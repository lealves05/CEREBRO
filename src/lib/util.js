import crypto from 'node:crypto';

export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const errors = {
  invalid: (msg, details) => new AppError(400, 'invalid_input', msg, details),
  unauth: () => new AppError(401, 'unauthenticated', 'Sessão inválida ou expirada.'),
  forbidden: (msg = 'Permissão insuficiente para esta operação.') => new AppError(403, 'forbidden', msg),
  notFound: () => new AppError(404, 'not_found', 'Recurso não encontrado.'),
  conflict: (msg) => new AppError(409, 'conflict', msg),
  reauth: () => new AppError(403, 'reauth_required', 'Confirme sua senha para concluir esta operação.'),
  limit: (msg) => new AppError(429, 'limit_reached', msg),
  insufficient: (msg) => new AppError(422, 'insufficient_data', msg),
  unavailable: (msg) => new AppError(503, 'integration_unavailable', msg),
  paused: () => new AppError(423, 'executions_paused', 'Execuções pausadas pelo administrador.'),
};

// JSON canônico: chaves ordenadas recursivamente, sem espaços. Base dos hashes de proposta.
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Aritmética decimal simples com centavos (evita ponto flutuante em dinheiro)
export function toCents(str) {
  if (str === null || str === undefined || str === '') return null;
  const s = String(str).trim().replace(',', '.');
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [i, d = ''] = s.replace('-', '').split('.');
  const cents = BigInt(i) * 100n + BigInt((d + '00').slice(0, 2));
  return neg ? -cents : cents;
}
export function fromCents(c) {
  if (c === null || c === undefined) return null;
  const big = BigInt(c);
  const neg = big < 0n;
  const abs = neg ? -big : big;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

export function brl(str) {
  if (str === null || str === undefined) return '—';
  const n = Number(str);
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function clampText(s, max) {
  if (typeof s !== 'string') return '';
  return s.length > max ? s.slice(0, max) : s;
}
