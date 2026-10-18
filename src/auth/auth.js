// Autenticação: senhas com scrypt, sessões opacas (token só no cookie HttpOnly; banco guarda o hash),
// token CSRF por sessão exigido em toda requisição que altera estado.
import crypto from 'node:crypto';
import { q, insert, now, addMs } from '../db.js';
import { config } from '../config.js';
import { errors, sha256, randomToken, safeEqual } from '../lib/util.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(password) {
  validatePasswordStrength(password);
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [alg, N, r, p, saltB64, keyB64] = String(stored).split('$');
    if (alg !== 'scrypt') return false;
    const key = Buffer.from(keyB64, 'base64');
    const test = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), key.length, { N: +N, r: +r, p: +p });
    return crypto.timingSafeEqual(key, test);
  } catch { return false; }
}

export function validatePasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) throw errors.invalid('A senha deve ter pelo menos 10 caracteres.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw errors.invalid('A senha deve combinar letras e números.');
}

// Proteção simples contra força bruta (memória do processo)
const attempts = new Map();
function throttle(key) {
  const rec = attempts.get(key) || { n: 0, until: 0 };
  if (rec.until > Date.now()) throw errors.limit('Muitas tentativas. Aguarde alguns minutos.');
  return rec;
}
function fail(key) {
  const rec = attempts.get(key) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= 5) { rec.until = Date.now() + 5 * 60_000; rec.n = 0; }
  attempts.set(key, rec);
}

function failIp(key) {
  const rec = attempts.get(key) || { n: 0, until: 0 };
  rec.n += 1;
  if (rec.n >= 20) { rec.until = Date.now() + 15 * 60_000; rec.n = 0; }
  attempts.set(key, rec);
}

export function login(email, password, ip = '') {
  const key = `${String(email).toLowerCase()}|${ip}`;
  throttle(key);
  throttle(`ip|${ip}`);
  const user = q.get("SELECT * FROM users WHERE email = ? AND status = 'active'", String(email || ''));
  if (!user || !verifyPassword(password, user.password_hash)) {
    fail(key);
    failIp(`ip|${ip}`);
    throw errors.invalid('E-mail ou senha inválidos.');
  }
  attempts.delete(key);
  return createSession(user.id);
}

export function createSession(userId) {
  const token = randomToken();
  const csrf = randomToken(24);
  const t = now();
  insert('sessions', {
    id: sha256(token), user_id: userId, csrf_token: csrf, created_at: t,
    expires_at: addMs(config.sessionHours * 3600_000), last_reauth_at: t,
  });
  return { token, csrf, userId };
}

export function destroySession(token) {
  if (token) q.run('DELETE FROM sessions WHERE id = ?', sha256(token));
}

export function sessionFromToken(token) {
  if (!token) return null;
  const s = q.get(`SELECT s.*, u.email, u.display_name, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`, sha256(token));
  if (!s || s.user_status !== 'active') return null;
  if (s.expires_at < now()) { q.run('DELETE FROM sessions WHERE id = ?', s.id); return null; }
  return s;
}

export function checkCsrf(session, headerValue) {
  if (!session || !headerValue || !safeEqual(session.csrf_token, headerValue)) {
    throw errors.forbidden('Token CSRF inválido. Recarregue a página.');
  }
}

export function reauthenticate(session, password) {
  const user = q.get('SELECT password_hash FROM users WHERE id = ?', session.user_id);
  if (!user || !verifyPassword(password, user.password_hash)) throw errors.invalid('Senha incorreta.');
  q.run('UPDATE sessions SET last_reauth_at = ? WHERE id = ?', now(), session.id);
}

export function requireRecentAuth(session) {
  const limit = addMs(-config.reauthMinutes * 60_000);
  if (!session.last_reauth_at || session.last_reauth_at < limit) throw errors.reauth();
}
