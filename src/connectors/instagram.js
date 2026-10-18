// Integração com o Instagram (Instagram API com login do Instagram — contas profissionais: Empresa ou Criador).
// Vinculação por OAuth (app da Meta) ou por token de acesso colado manualmente.
// Publicação: cria contêiner de mídia → aguarda processamento → media_publish. Só é chamada pelo executor,
// depois da política e da aprovação humana do conteúdo exato. Conferir a documentação vigente da Meta:
// https://developers.facebook.com/docs/instagram-platform
import crypto from 'node:crypto';
import { config } from '../config.js';
import { q, insert, uuid, now, addMs, tx, json } from '../db.js';
import { encrypt, decrypt } from '../services/secrets.js';
import { sha256, randomToken, errors, clampText } from '../lib/util.js';

export const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
export const igHooks = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export class InstagramError extends Error {
  constructor(kind, message, { uncertain = false } = {}) { super(message); this.kind = kind; this.uncertain = uncertain; }
}

const cfg = () => config.instagram;
export const isAppConfigured = () => !!(cfg().appId && cfg().appSecret && cfg().redirectUri);

async function call(url, { method = 'GET', body, form } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), cfg().timeoutMs);
  let res;
  try {
    res = await igHooks.fetch(url, {
      method, signal: ac.signal,
      headers: form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : body ? { 'Content-Type': 'application/json' } : {},
      body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new InstagramError('timeout', e.name === 'AbortError' ? 'Tempo limite ao falar com o Instagram.' : 'Falha de rede com o Instagram.', { uncertain: true });
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = clampText(data.error?.message || data.error_message || `HTTP ${res.status}`, 300);
    const kind = res.status === 401 || data.error?.code === 190 ? 'auth' : res.status === 403 ? 'forbidden' : res.status === 429 || data.error?.code === 4 ? 'rate_limit' : 'api';
    throw new InstagramError(kind, `Instagram: ${msg}`);
  }
  return data;
}

const graph = (path, params = {}) => {
  const u = new URL(`${cfg().graphBase}/${cfg().apiVersion}/${path.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
};

// ---------- Vinculação ----------
export function startOAuth(ctx) {
  if (!isAppConfigured()) throw errors.invalid('Configure INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET e INSTAGRAM_REDIRECT_URI no .env do servidor, ou vincule colando um token de acesso.');
  const state = randomToken(24);
  insert('oauth_states', { state_hash: sha256(state), organization_id: ctx.orgId, user_id: ctx.userId, provider: 'instagram', created_at: now(), expires_at: addMs(10 * 60_000), used_at: null });
  const u = new URL(cfg().oauthBase);
  u.searchParams.set('client_id', cfg().appId);
  u.searchParams.set('redirect_uri', cfg().redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(','));
  u.searchParams.set('state', state);
  return u.toString();
}

export async function handleCallback({ code, state }) {
  const rec = tx(() => {
    const r = q.get("SELECT * FROM oauth_states WHERE state_hash = ? AND provider = 'instagram'", sha256(String(state || '')));
    if (!r || r.used_at || r.expires_at < now()) return null;
    q.run('UPDATE oauth_states SET used_at = ? WHERE state_hash = ?', now(), r.state_hash); // uso único
    return r;
  });
  if (!rec) throw new InstagramError('state', 'Pedido de vinculação inválido ou expirado. Tente novamente pelo painel.');
  const member = q.get("SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'", rec.organization_id, rec.user_id);
  if (!member || member.role !== 'owner') throw new InstagramError('forbidden', 'Somente o owner pode vincular a conta.');
  if (!code) throw new InstagramError('denied', 'Autorização não concedida no Instagram.');
  const short = await call(cfg().tokenUrl, { method: 'POST', form: { client_id: cfg().appId, client_secret: cfg().appSecret, grant_type: 'authorization_code', redirect_uri: cfg().redirectUri, code: String(code).replace(/#_$/, '') } });
  const shortToken = short.access_token || short.data?.[0]?.access_token;
  if (!shortToken) throw new InstagramError('api', 'Instagram não retornou token de acesso.');
  const long = await call(`${cfg().graphBase}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: cfg().appSecret, access_token: shortToken })}`);
  const scopes = short.permissions ? String(short.permissions).split(',') : SCOPES;
  await saveAccount({ orgId: rec.organization_id, userId: rec.user_id, token: long.access_token, expiresIn: long.expires_in, method: 'oauth', scopes });
  return rec.organization_id;
}

export async function linkManualToken(ctx, token) {
  const t = String(token || '').trim();
  if (t.length < 20 || /\s/.test(t)) throw errors.invalid('Token de acesso inválido.');
  let finalToken = t; let expiresIn = null;
  if (cfg().appSecret) {
    // Tenta trocar por token de longa duração; se já for longo, mantém o original.
    try {
      const long = await call(`${cfg().graphBase}/access_token?${new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: cfg().appSecret, access_token: t })}`);
      if (long.access_token) { finalToken = long.access_token; expiresIn = long.expires_in; }
    } catch { /* mantém o token informado */ }
  }
  return saveAccount({ orgId: ctx.orgId, userId: ctx.userId, token: finalToken, expiresIn, method: 'manual_token', scopes: SCOPES });
}

async function saveAccount({ orgId, userId, token, expiresIn, method, scopes }) {
  const me = await call(graph('me', { fields: 'user_id,username,account_type', access_token: token }));
  const accountId = String(me.user_id || me.id || '');
  if (!accountId) throw new InstagramError('api', 'Não foi possível identificar a conta do Instagram.');
  if (me.account_type && !/BUSINESS|MEDIA_CREATOR|CREATOR/i.test(me.account_type)) {
    throw new InstagramError('account_type', 'A conta precisa ser profissional (Empresa ou Criador de conteúdo) para publicar pela API.');
  }
  const row = {
    account_id: accountId, username: clampText(me.username || '', 60), account_type: me.account_type || null,
    token_ciphertext: encrypt(token), token_expires_at: expiresIn ? addMs(Number(expiresIn) * 1000) : null,
    scopes: JSON.stringify(scopes), link_method: method, status: 'connected', connected_by: userId,
    connected_at: now(), last_checked_at: now(), last_check_result: JSON.stringify({ ok: true }),
  };
  tx(() => {
    const ex = q.get("SELECT id FROM social_accounts WHERE organization_id = ? AND provider = 'instagram'", orgId);
    if (ex) q.run(`UPDATE social_accounts SET ${Object.keys(row).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...Object.values(row), ex.id);
    else insert('social_accounts', { id: uuid(), organization_id: orgId, provider: 'instagram', ...row });
  });
  return publicAccount(orgId);
}

export function publicAccount(orgId) {
  const a = q.get("SELECT id, account_id, username, account_type, token_expires_at, scopes, link_method, status, connected_at, last_checked_at, last_check_result FROM social_accounts WHERE organization_id = ? AND provider = 'instagram'", orgId);
  if (!a || a.status === 'disconnected') return null;
  const expired = a.token_expires_at && a.token_expires_at < now();
  return { ...a, status: expired ? 'expired' : a.status, scopes: json(a.scopes, []), last_check_result: json(a.last_check_result) };
}

function tokenFor(orgId) {
  const a = q.get("SELECT * FROM social_accounts WHERE organization_id = ? AND provider = 'instagram' AND status = 'connected'", orgId);
  if (!a) throw new InstagramError('not_linked', 'Conta do Instagram não vinculada.');
  if (a.token_expires_at && a.token_expires_at < now()) throw new InstagramError('auth', 'Token do Instagram expirado. Vincule a conta novamente.');
  return { account: a, token: decrypt(a.token_ciphertext) };
}

export async function verifyAccount(orgId) {
  const { account, token } = tokenFor(orgId);
  let tk = token;
  try {
    // Renova tokens de longa duração próximos do vencimento (válidos por ~60 dias)
    if (account.token_expires_at && account.token_expires_at < addMs(7 * 86400_000)) {
      const r = await call(`${cfg().graphBase}/refresh_access_token?${new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token })}`);
      if (r.access_token) { tk = r.access_token; q.run('UPDATE social_accounts SET token_ciphertext = ?, token_expires_at = ? WHERE id = ?', encrypt(tk), addMs(Number(r.expires_in || 0) * 1000), account.id); }
    }
    const me = await call(graph('me', { fields: 'user_id,username,account_type', access_token: tk }));
    let limit = null;
    try { limit = await call(graph(`${account.account_id}/content_publishing_limit`, { fields: 'quota_usage,config', access_token: tk })); } catch { /* opcional */ }
    const result = { ok: true, username: me.username, quota: limit?.data?.[0] || null };
    q.run("UPDATE social_accounts SET status = 'connected', username = ?, last_checked_at = ?, last_check_result = ? WHERE id = ?", me.username || account.username, now(), JSON.stringify(result), account.id);
    return result;
  } catch (e) {
    q.run('UPDATE social_accounts SET status = ?, last_checked_at = ?, last_check_result = ? WHERE id = ?', e.kind === 'auth' ? 'expired' : 'error', now(), JSON.stringify({ ok: false, kind: e.kind, message: e.message }), account.id);
    throw e;
  }
}

export function disconnect(orgId) {
  q.run("UPDATE social_accounts SET status = 'disconnected', token_ciphertext = 'revogado' WHERE organization_id = ? AND provider = 'instagram'", orgId);
}

// ---------- Publicação (executor) ----------
export function validatePost({ caption, image_url }) {
  const errs = [];
  if (!caption || !String(caption).trim()) errs.push('Legenda vazia');
  if (String(caption || '').length > 2200) errs.push('Legenda acima de 2.200 caracteres');
  if ((String(caption || '').match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) errs.push('Mais de 30 hashtags');
  if (!image_url) errs.push('Imagem não informada (URL pública HTTPS de um JPEG)');
  else {
    try { const u = new URL(image_url); if (u.protocol !== 'https:') errs.push('A imagem deve estar em URL HTTPS pública'); } catch { errs.push('URL da imagem inválida'); }
  }
  return errs;
}

export async function publishImage(orgId, { caption, image_url }) {
  const { account, token } = tokenFor(orgId);
  const errs = validatePost({ caption, image_url });
  if (errs.length) throw new InstagramError('content', errs.join('; '));
  const container = await call(graph(`${account.account_id}/media`), { method: 'POST', form: { image_url, caption, access_token: token } });
  const creationId = container.id;
  // Aguarda o processamento do contêiner (FINISHED) antes de publicar
  for (let i = 0; i < 10; i++) {
    const st = await call(graph(creationId, { fields: 'status_code', access_token: token }));
    if (st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new InstagramError('content', `Instagram recusou a mídia (${st.status_code}). Verifique se a imagem é JPEG pública.`);
    if (i === 9) throw new InstagramError('timeout', 'Mídia ainda em processamento no Instagram.');
    await igHooks.sleep(3000);
  }
  // A partir daqui, um timeout pode significar publicação já feita → resultado incerto
  try {
    const pub = await call(graph(`${account.account_id}/media_publish`), { method: 'POST', form: { creation_id: creationId, access_token: token } });
    let permalink = null;
    try { permalink = (await call(graph(pub.id, { fields: 'permalink', access_token: token }))).permalink || null; } catch { /* opcional */ }
    return { media_id: pub.id, creation_id: creationId, permalink, username: account.username };
  } catch (e) {
    if (e.kind === 'timeout') throw new InstagramError('timeout', 'Sem confirmação da publicação — conciliar antes de tentar de novo.', { uncertain: true });
    throw e;
  }
}

// Conciliação: procura nas publicações recentes uma com a mesma legenda após o início da execução.
export async function findPublished(orgId, caption, sinceIso) {
  const { account, token } = tokenFor(orgId);
  const r = await call(graph(`${account.account_id}/media`, { fields: 'id,caption,timestamp,permalink', limit: '25', access_token: token }));
  const since = Date.parse(sinceIso) - 120_000;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  return (r.data || []).find((m) => norm(m.caption) === norm(caption) && Date.parse(m.timestamp) >= since) || null;
}

export function captionHash(caption) { return crypto.createHash('sha256').update(String(caption)).digest('hex'); }
