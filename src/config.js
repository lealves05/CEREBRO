// Carrega .env (sem dependências) e expõe configuração tipada.
// Segredos ficam apenas no processo do servidor; nunca são enviados ao navegador nem ao modelo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Em Cloudflare Workers não há sistema de arquivos do projeto: ROOT fica vazio e as funções que leem arquivos
// recebem os dados pela camada de plataforma (src/platform.js).
export const IS_WORKER = typeof globalThis.WebSocketPair === 'function' && typeof globalThis.navigator?.userAgent === 'string' && globalThis.navigator.userAgent.includes('Cloudflare-Workers');
let root = '';
try { if (!IS_WORKER) root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); } catch { root = ''; }
export const ROOT = root;

function loadDotEnv() {
  if (IS_WORKER || !ROOT) return;
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const int = (k, d) => { const v = parseInt(env(k, ''), 10); return Number.isFinite(v) ? v : d; };

function buildConfig() {
  return {
  env: env('LORLER_ENV', 'development'),            // development | test | production
  port: int('PORT', 3700),
  host: env('HOST', '127.0.0.1'),
  dbFile: env('LORLER_DB_FILE', ROOT ? path.join(ROOT, 'data', 'lorler.db') : ':memory:'),
  demoMode: env('LORLER_DEMO_MODE', 'true') === 'true', // habilita dados fictícios identificados
  cookieSecure: env('LORLER_COOKIE_SECURE', 'false') === 'true',
  trustProxy: env('LORLER_TRUST_PROXY', 'false') === 'true', // atrás do Cloudflare Tunnel/proxy: usar CF-Connecting-IP
  publicUrl: env('LORLER_PUBLIC_URL', ''),
  sessionHours: int('LORLER_SESSION_HOURS', 12),
  reauthMinutes: int('LORLER_REAUTH_MINUTES', 15),
  workerInProcess: env('LORLER_WORKER_IN_PROCESS', 'true') === 'true',
  workerId: env('LORLER_WORKER_ID', `worker-${globalThis.process?.pid ?? 'cf'}`),
  ai: {
    provider: env('LORLER_AI_PROVIDER', 'demo'),       // demo | openai | anthropic
    model: env('LORLER_AI_MODEL', ''),                 // modelo padrão; sem valor fixo no código
    modelByAgent: {
      marketing: env('LORLER_AI_MODEL_MARKETING', ''),
      coordinator: env('LORLER_AI_MODEL_COORDINATOR', ''),
      financial: env('LORLER_AI_MODEL_FINANCIAL', ''),
      commercial: env('LORLER_AI_MODEL_COMMERCIAL', ''),
      operations: env('LORLER_AI_MODEL_OPERATIONS', ''),
    },
    openaiKey: env('OPENAI_API_KEY', ''),
    openaiBase: env('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    anthropicKey: env('ANTHROPIC_API_KEY', ''),
    anthropicBase: env('ANTHROPIC_BASE_URL', 'https://api.anthropic.com/v1'),
    timeoutMs: int('LORLER_AI_TIMEOUT_MS', 90000),
  },
  connectors: {
    allowedHosts: env('LORLER_CONNECTOR_ALLOWED_HOSTS', '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    timeoutMs: int('LORLER_CONNECTOR_TIMEOUT_MS', 15000),
    maxBytes: int('LORLER_CONNECTOR_MAX_BYTES', 1_000_000),
    allowInsecureLocalhost: env('LORLER_CONNECTOR_ALLOW_LOCALHOST', 'false') === 'true',
  },
  instagram: {
    appId: env('INSTAGRAM_APP_ID', ''),
    appSecret: env('INSTAGRAM_APP_SECRET', ''),
    redirectUri: env('INSTAGRAM_REDIRECT_URI', ''),       // ex.: https://cerebro.seudominio/api/social/instagram/callback
    apiVersion: env('INSTAGRAM_API_VERSION', 'v24.0'),     // conferir a versão vigente na documentação da Meta
    graphBase: env('INSTAGRAM_GRAPH_BASE', 'https://graph.instagram.com'),
    oauthBase: env('INSTAGRAM_OAUTH_BASE', 'https://www.instagram.com/oauth/authorize'),
    tokenUrl: env('INSTAGRAM_TOKEN_URL', 'https://api.instagram.com/oauth/access_token'),
    timeoutMs: int('INSTAGRAM_TIMEOUT_MS', 20000),
  },
  encryptionKey: env('LORLER_ENCRYPTION_KEY', ''),
  events: {
    hmacSecretRef: 'LORLER_EVENTS_HMAC_SECRET',
    windowSeconds: int('LORLER_EVENTS_WINDOW_SECONDS', 300),
  },
};
}
export const config = buildConfig();
/** Relê as variáveis (Cloudflare: chamado depois que os segredos são carregados em process.env). */
export function refreshConfig() { const fresh = buildConfig(); for (const k of Object.keys(fresh)) config[k] = fresh[k]; return config; }


export function secret(ref) {
  // Resolve um secret_ref (nome de variável de ambiente). Restringe a nomes com prefixo permitido.
  if (!ref || !/^LORLER_SECRET_[A-Z0-9_]+$|^LORLER_EVENTS_HMAC_SECRET$/.test(ref)) return '';
  return process.env[ref] || '';
}
