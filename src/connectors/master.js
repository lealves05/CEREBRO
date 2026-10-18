// Integração com a Área Master da LORLER (central de assinaturas e cobrança — API /api/master do ORBI).
// Leitura: painel, empresas, assinaturas, pagamentos, planos e parâmetros, normalizados no contrato de métricas.
// Escrita: somente pelo executor, depois da política e da aprovação humana da proposta exata.
// Autenticação: administrador da plataforma (usuário + senha, TOTP opcional), token Bearer de curta duração.
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { config, secret, IS_WORKER } from '../config.js';
import { q, now } from '../db.js';
import { clampText } from '../lib/util.js';

export const masterHooks = { fetch: (...a) => fetch(...a) };
export const SETTINGS_KEYS = ['trial_default', 'grace_days', 'renewal_notice_days', 'signup_enabled', 'support_contact', 'support_whatsapp', 'support_email', 'support_hours', 'support_message'];
export const PLAN_FIELDS = ['name', 'description', 'monthly_price', 'annual_price', 'features', 'max_users', 'active', 'sort'];

export class MasterError extends Error {
  constructor(kind, message, { uncertain = false } = {}) { super(message); this.kind = kind; this.uncertain = uncertain; }
}

const cfg = () => ({
  url: (process.env.LORLER_MASTER_URL || '').replace(/\/+$/, ''),
  username: process.env.LORLER_MASTER_USERNAME || '',
  password: secret('LORLER_SECRET_MASTER_PASSWORD'),
  totp: secret('LORLER_SECRET_MASTER_TOTP'),
  // Master oculto na VPS (lorler-master-oculto): passe da porta, igual ao do navegador que entrou pelo link secreto.
  // A VPS preenche sozinha em /etc/lorler/cerebro.env; vazio = Master aberto (sem ocultamento).
  porta: process.env.LORLER_MASTER_PORTA || '',
});
export const isConfigured = () => { const c = cfg(); return !!(c.url && c.username && c.password); };
export const masterInfo = () => { const c = cfg(); return { url: c.url || null, username: c.username || null, password_configured: !!c.password, totp_configured: !!c.totp, configured: isConfigured() }; };

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) { const [a, b] = ip.split('.').map(Number); return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168); }
  const v = ip.toLowerCase(); return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function assertSafe(url) {
  const u = new URL(url);
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') { if (config.env !== 'production' && config.connectors.allowInsecureLocalhost) return; }
  if (u.protocol !== 'https:') throw new MasterError('config', 'LORLER_MASTER_URL precisa ser HTTPS.');
  // No Cloudflare Worker não existe rede interna para proteger (e o DNS do Node não está disponível lá)
  if (IS_WORKER) return;
  const addrs = await dns.lookup(u.hostname, { all: true }).catch(() => { throw new MasterError('unavailable', 'Falha de DNS ao resolver a Área Master.'); });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new MasterError('blocked', 'Endereço da Área Master resolve para rede interna; bloqueado.');
}

// TOTP RFC 6238 (SHA-1, 30 s, 6 dígitos) — para administrador com MFA ativado
function base32(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = ''; const out = [];
  for (const ch of String(s).replace(/=+$/, '').replace(/\s/g, '').toUpperCase()) { const v = alpha.indexOf(ch); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); }
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
export function totp(secretB32, t = Date.now()) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = crypto.createHmac('sha1', base32(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, '0');
}

let session = { token: null, exp: 0 };
async function raw(path, { method = 'GET', body, token } = {}) {
  const c = cfg();
  const url = `${c.url}/api/master${path}`;
  await assertSafe(url);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20000);
  let res;
  try {
    res = await masterHooks.fetch(url, { method, signal: ac.signal, redirect: 'manual', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(/^[A-Za-z0-9_-]{20,100}$/.test(c.porta) ? { Cookie: `lorler_porta=${c.porta}` } : {}), 'User-Agent': 'LORLER-Central-de-Decisoes' }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new MasterError('timeout', e.name === 'AbortError' ? 'Tempo limite ao falar com a Área Master.' : 'Falha de conexão com a Área Master.', { uncertain: method !== 'GET' });
  } finally { clearTimeout(timer); }
  // redirecionamento não é seguido (o token não pode vazar para outro endereço). 'manual' funciona no Node e no Worker.
  if (res.status >= 300 && res.status < 400) throw new MasterError('config', `A Área Master respondeu com redirecionamento (${res.status}); confira LORLER_MASTER_URL.`);
  const text = await res.text();
  if (text.length > 5_000_000) throw new MasterError('contract', 'Resposta da Área Master grande demais.');
  let data = {}; try { data = text ? JSON.parse(text) : {}; } catch { throw new MasterError('contract', 'Resposta da Área Master não é JSON.'); }
  if (!res.ok) {
    const kind = res.status === 401 ? 'auth' : res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate_limit' : res.status >= 500 ? 'unavailable' : 'api';
    throw new MasterError(kind, `Área Master (${res.status}): ${clampText(data.error || data.message || 'erro', 240)}`);
  }
  return data;
}

async function login() {
  const c = cfg();
  if (!isConfigured()) throw new MasterError('config', 'Configure LORLER_MASTER_URL, LORLER_MASTER_USERNAME e LORLER_SECRET_MASTER_PASSWORD no .env do servidor.');
  let r = await raw('/auth/login', { method: 'POST', body: { username: c.username, password: c.password } });
  if (r.mfa_required) {
    if (!c.totp) throw new MasterError('auth', 'O administrador da Área Master tem MFA: defina LORLER_SECRET_MASTER_TOTP (segredo base32) ou use um administrador dedicado.');
    r = await raw('/auth/mfa', { method: 'POST', body: { mfa_token: r.mfa_token, code: totp(c.totp) } });
  }
  if (!r.token) throw new MasterError('auth', 'A Área Master não retornou token.');
  if (r.must_change_password) throw new MasterError('auth', 'O administrador precisa trocar a senha inicial na Área Master antes do uso pelo cérebro.');
  session = { token: r.token, exp: Date.now() + 100 * 60_000 }; // sessões do Master duram 120 min
  return session.token;
}

export async function call(path, opts = {}) {
  if (!session.token || session.exp < Date.now()) await login();
  try { return await raw(path, { ...opts, token: session.token }); }
  catch (e) {
    if (e.kind === 'auth') { session = { token: null, exp: 0 }; await login(); return raw(path, { ...opts, token: session.token }); }
    throw e;
  }
}
export function resetSession() { session = { token: null, exp: 0 }; }

export async function testConnection() {
  try {
    const d = await call('/dashboard');
    const products = (d.products || []).map((p) => p.code).filter(Boolean);
    const result = { ok: true, products, checked_at: now() };
    lastStatus = result;
    return result;
  } catch (e) {
    lastStatus = { ok: false, kind: e.kind, message: e.message, checked_at: now() };
    return lastStatus;
  }
}
let lastStatus = null;
export const lastMasterStatus = () => lastStatus;

const inPeriod = (iso, p) => iso && Date.parse(iso) >= Date.parse(p.start) && Date.parse(iso) < Date.parse(p.end_exclusive);
const num = (v) => (v == null || v === '' ? null : Number(v));
const m = (code, value, unit, quality = 'complete', note) => ({ code, value: value == null || Number.isNaN(value) ? null : String(value), unit, definition_version: '1.0', quality: value == null ? 'unavailable' : quality, source_ref: `master/${code}`, ...(note ? { note } : {}) });

// Snapshot normalizado de um produto (contrato de métricas 1.0 + configuração comercial)
export async function productSnapshot(productCode, period) {
  const p = String(productCode).toLowerCase();
  const qs = `?product=${encodeURIComponent(p)}`;
  const [tenantsRes, subs, pays, plansRes, settingsRes] = await Promise.all([
    call(`/tenants${qs}`), call(`/subscriptions${qs}`), call(`/payments${qs}`), call(`/plans${qs}`), call(`/settings${qs}`),
  ]);
  let dash = null; try { dash = await call(`/dashboard${qs}`); } catch { dash = null; }
  const tenants = Array.isArray(tenantsRes) ? tenantsRes : tenantsRes.items || tenantsRes.tenants || [];
  const plans = (plansRes.items || []).filter((x) => x.product === p);
  const recent = Date.parse(period.end_exclusive) >= Date.now() - 2 * 86400_000;
  const snapNote = recent ? undefined : 'Situação atual da Área Master (sem histórico na data final do período)';
  const status = (s) => tenants.filter((t) => t.status === s).length;
  const startedBefore = subs.filter((s) => s.started_at && Date.parse(s.started_at) < Date.parse(period.start) && (!s.canceled_at || Date.parse(s.canceled_at) >= Date.parse(period.start))).length;
  const cohort = tenants.filter((t) => inPeriod(t.created_at, period) && t.trial_type);
  const confirmed = pays.filter((x) => x.status === 'CONFIRMED' && inPeriod(x.paid_at, period));
  const open = pays.filter((x) => ['PENDING', 'OVERDUE', 'PAYMENT_PENDING'].includes(x.status));
  const capped = pays.length >= 500 || subs.length >= 500;
  const prices = plans.filter((x) => x.active && Number(x.monthly_price) > 0).map((x) => Number(x.monthly_price)).sort((a, b) => a - b);
  const mrr = num(dash?.kpis?.mrr);
  const metrics = [
    m('active_subscriptions_at_period_end', status('ACTIVE'), 'subscriptions', recent ? 'complete' : 'partial', snapNote),
    m('active_subscriptions_at_period_start', startedBefore, 'subscriptions', 'partial', 'Estimado pelas datas das assinaturas'),
    m('tenants_in_trial', status('TRIAL'), 'tenants', recent ? 'complete' : 'partial', snapNote),
    m('tenants_past_due', tenants.filter((t) => ['PAST_DUE', 'PAYMENT_PENDING'].includes(t.status)).length, 'tenants'),
    m('tenants_suspended', status('SUSPENDED'), 'tenants'),
    m('new_signups', tenants.filter((t) => inPeriod(t.created_at, period)).length, 'tenants'),
    m('new_subscriptions', subs.filter((s) => inPeriod(s.started_at, period)).length, 'subscriptions', capped ? 'partial' : 'complete'),
    m('cancellations', subs.filter((s) => inPeriod(s.canceled_at, period)).length, 'subscriptions', capped ? 'partial' : 'complete'),
    m('cohort_trials', cohort.length, 'trials'),
    m('cohort_trial_subscriptions', cohort.filter((t) => t.last_payment).length, 'subscriptions', 'partial', 'Teste convertido = empresa da coorte com pagamento confirmado'),
    m('cash_received_in_period', confirmed.reduce((a, x) => a + Number(x.amount || 0), 0).toFixed(2), 'money', capped ? 'partial' : 'complete'),
    m('open_receivables', open.reduce((a, x) => a + Number(x.amount || 0), 0).toFixed(2), 'money'),
    m('mrr_normalized', mrr == null ? null : mrr.toFixed(2), 'money', 'complete'),
    m('plan_price_main', prices.length ? prices[0].toFixed(2) : null, 'money'),
  ];
  return {
    contract: {
      schema_version: '1.0', product_code: productCode.toUpperCase(), period, fetched_at: now(), currency: 'BRL', metrics,
      limitations: [capped ? 'Listas da Área Master limitadas a 500 registros — valores marcados como parciais' : null, 'Custos variáveis não existem na Área Master'].filter(Boolean),
    },
    config: {
      product: p,
      plans: plans.map((x) => ({ id: x.id, code: x.code, name: x.name, monthly_price: x.monthly_price, annual_price: x.annual_price, active: x.active, tenants: x.tenants, max_users: x.max_users })),
      settings: settingsRes.settings || {}, overrides: settingsRes.overrides || {}, keys: settingsRes.keys || SETTINGS_KEYS,
    },
  };
}

// ---------- Escrita (executor) ----------
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const reasonText = (r) => clampText(r || 'Central de Decisões LORLER', 480);

export async function applyAction(tool, params, { reason } = {}) {
  if (tool === 'master_update_settings') {
    const qs = `?product=${encodeURIComponent(params.product)}`;
    const cur = (await call(`/settings${qs}`)).settings || {};
    for (const k of Object.keys(params.values || {})) if (!SETTINGS_KEYS.includes(k)) throw new MasterError('content', `Parâmetro não permitido: ${k}`);
    const changed = Object.keys(params.before || {}).filter((k) => !same(cur[k], params.before[k]));
    if (changed.length) throw new MasterError('stale', `Valores mudaram na Área Master desde a análise (${changed.join(', ')}). Gere uma nova análise.`);
    const r = await call(`/settings${qs}`, { method: 'PUT', body: params.values });
    return { applied: params.values, settings: r.settings || null };
  }
  if (tool === 'master_update_plan') {
    const plans = (await call(`/plans?product=${encodeURIComponent(params.product)}`)).items || [];
    const plan = plans.find((x) => x.id === params.plan_id);
    if (!plan) throw new MasterError('content', 'Plano não encontrado na Área Master.');
    const changed = Object.keys(params.before || {}).filter((k) => !same(num(plan[k]) ?? plan[k], num(params.before[k]) ?? params.before[k]));
    if (changed.length) throw new MasterError('stale', `O plano mudou desde a análise (${changed.join(', ')}). Gere uma nova análise.`);
    const body = Object.fromEntries(PLAN_FIELDS.map((k) => [k, plan[k]]));
    body.monthly_price = num(body.monthly_price); body.annual_price = num(body.annual_price);
    for (const [k, v] of Object.entries(params.changes || {})) if (PLAN_FIELDS.includes(k)) body[k] = v;
    const r = await call(`/plans/${encodeURIComponent(plan.id)}`, { method: 'PUT', body });
    return { plan_id: r.id || plan.id, applied: params.changes };
  }
  if (tool === 'master_update_product_params') {
    const cur = (await call(`/products/${encodeURIComponent(params.product)}/params`)).values || {};
    const changed = Object.keys(params.before || {}).filter((k) => !same(cur[k], params.before[k]));
    if (changed.length) throw new MasterError('stale', `Parâmetros mudaram desde a análise (${changed.join(', ')}). Gere uma nova análise.`);
    const r = await call(`/products/${encodeURIComponent(params.product)}/params`, { method: 'PUT', body: { values: params.values, reason: reasonText(reason) } });
    return { applied: params.values, values: r.values || null };
  }
  if (tool === 'master_extend_trial') {
    const t = await call(`/tenants/${encodeURIComponent(params.tenant_id)}`);
    const tenant = t.tenant || t;
    if (params.before_trial_ends_at !== undefined && !same(tenant.trial_ends_at || null, params.before_trial_ends_at || null)) throw new MasterError('stale', 'O teste desta empresa mudou desde a análise. Gere uma nova análise.');
    await call(`/tenants/${encodeURIComponent(params.tenant_id)}/trial`, { method: 'POST', body: { action: 'extend', days: Number(params.days), reason: reasonText(reason) } });
    return { tenant_id: params.tenant_id, extended_days: Number(params.days) };
  }
  throw new MasterError('content', `Ação da Área Master não suportada: ${tool}`);
}

// Conciliação após timeout: verifica se o estado desejado já está aplicado
export async function isApplied(tool, params) {
  if (tool === 'master_update_settings') {
    const cur = (await call(`/settings?product=${encodeURIComponent(params.product)}`)).settings || {};
    return Object.entries(params.values || {}).every(([k, v]) => same(cur[k], v));
  }
  if (tool === 'master_update_plan') {
    const plan = ((await call(`/plans?product=${encodeURIComponent(params.product)}`)).items || []).find((x) => x.id === params.plan_id);
    return !!plan && Object.entries(params.changes || {}).every(([k, v]) => same(num(plan[k]) ?? plan[k], num(v) ?? v));
  }
  if (tool === 'master_update_product_params') {
    const cur = (await call(`/products/${encodeURIComponent(params.product)}/params`)).values || {};
    return Object.entries(params.values || {}).every(([k, v]) => same(cur[k], v));
  }
  if (tool === 'master_extend_trial') {
    const t = await call(`/tenants/${encodeURIComponent(params.tenant_id)}`);
    const ends = (t.tenant || t).trial_ends_at;
    if (!ends || !params.before_trial_ends_at) return false;
    return Math.abs(Date.parse(ends) - (Date.parse(params.before_trial_ends_at) + Number(params.days) * 86400_000)) < 2 * 86400_000;
  }
  return false;
}
