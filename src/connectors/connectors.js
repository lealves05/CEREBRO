// Conectores de leitura ORBI, TORVEN, RUSTEN (e demais produtos cadastrados).
// Contrato: GET {base_url}/lorler/v1/metrics?start=...&end_exclusive=...&timezone=...
//           Authorization: Bearer <credencial em variável de ambiente referenciada por secret_ref>
// Ver docs/CONECTORES.md. Sem API disponível → integração permanece "pending_setup"; nunca simula sucesso.
import dns from 'node:dns/promises';
import net from 'node:net';
import { config, secret, IS_WORKER } from '../config.js';
import { q, now } from '../db.js';
import { sha256, canonicalJson } from '../lib/util.js';

export const ADAPTER_VERSION = '1.0';
export const QUALITIES = ['complete', 'partial', 'stale', 'unavailable'];

export class ConnectorError extends Error {
  constructor(kind, message) { super(message); this.kind = kind; } // auth | forbidden | unavailable | contract | blocked | config
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:');
}

export async function assertUrlAllowed(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new ConnectorError('config', 'URL da API inválida.'); }
  const host = u.hostname.toLowerCase();
  const isLocal = host === 'localhost' || host === '127.0.0.1';
  if (isLocal && config.connectors.allowInsecureLocalhost && config.env !== 'production') return u; // somente desenvolvimento
  if (u.protocol !== 'https:') throw new ConnectorError('blocked', 'Somente HTTPS é permitido para conectores.');
  if (!config.connectors.allowedHosts.includes(host)) {
    throw new ConnectorError('blocked', `Host não autorizado: ${host}. Cadastre-o em LORLER_CONNECTOR_ALLOWED_HOSTS.`);
  }
  if (IS_WORKER) return u; // Worker: sem rede interna e sem DNS do Node
  const addrs = await dns.lookup(host, { all: true }).catch(() => { throw new ConnectorError('unavailable', 'Falha de DNS ao resolver o host.'); });
  if (addrs.some((a) => isPrivateIp(a.address))) throw new ConnectorError('blocked', 'Host resolve para endereço interno; bloqueado.');
  return u;
}

export function validateContract(body, expectedProduct, period) {
  const errs = [];
  if (!body || typeof body !== 'object') return ['Resposta não é um objeto JSON.'];
  if (body.schema_version !== '1.0') errs.push('schema_version incompatível (esperado 1.0).');
  if (body.product_code !== expectedProduct) errs.push(`product_code divergente (esperado ${expectedProduct}).`);
  if (!body.period || body.period.start == null || body.period.end_exclusive == null) errs.push('period ausente.');
  else if (period && (Date.parse(body.period.start) !== Date.parse(period.start) || Date.parse(body.period.end_exclusive) !== Date.parse(period.end_exclusive))) errs.push('Período retornado difere do solicitado.');
  if (body.currency && body.currency !== 'BRL') errs.push(`Moeda não suportada: ${body.currency}.`);
  if (!Array.isArray(body.metrics)) errs.push('metrics deve ser uma lista.');
  else body.metrics.slice(0, 500).forEach((m, i) => {
    if (!m || typeof m.code !== 'string' || !/^[a-z0-9_]{2,80}$/.test(m.code)) errs.push(`metrics[${i}].code inválido.`);
    if (m.value !== null && typeof m.value !== 'string') errs.push(`metrics[${i}].value deve ser texto decimal ou null.`);
    if (typeof m.value === 'string' && !/^-?\d+(\.\d+)?$/.test(m.value)) errs.push(`metrics[${i}].value não é decimal.`);
    if (!QUALITIES.includes(m.quality)) errs.push(`metrics[${i}].quality inválida.`);
  });
  return errs;
}

export async function fetchMetrics(integration, productCode, period, { fetchImpl = fetch } = {}) {
  if (!integration.base_url) throw new ConnectorError('config', 'URL da API não cadastrada.');
  const token = secret(integration.secret_ref);
  if (!token) throw new ConnectorError('config', `Credencial ausente: defina ${integration.secret_ref || 'LORLER_SECRET_<PRODUTO>'} no .env do servidor.`);
  const base = await assertUrlAllowed(integration.base_url);
  const url = new URL(base.pathname.replace(/\/$/, '') + '/lorler/v1/metrics', base);
  url.searchParams.set('start', period.start);
  url.searchParams.set('end_exclusive', period.end_exclusive);
  url.searchParams.set('timezone', period.timezone || 'America/Sao_Paulo');

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.connectors.timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: ac.signal, redirect: 'manual' });
  } catch (e) {
    throw new ConnectorError('unavailable', e.name === 'AbortError' ? 'Tempo limite excedido.' : 'Falha de conexão com a API do produto.');
  } finally { clearTimeout(timer); }
  if (res.status >= 300 && res.status < 400) throw new ConnectorError('blocked', `Produto respondeu com redirecionamento (${res.status}); não seguido.`);
  if (res.status === 401) throw new ConnectorError('auth', 'Credencial rejeitada pelo produto (401).');
  if (res.status === 403) throw new ConnectorError('forbidden', 'Escopo negado pelo produto (403).');
  if (!res.ok) throw new ConnectorError('unavailable', `Produto respondeu HTTP ${res.status}.`);
  const text = await res.text();
  if (text.length > config.connectors.maxBytes) throw new ConnectorError('contract', 'Resposta excede o tamanho máximo permitido.');
  let body;
  try { body = JSON.parse(text); } catch { throw new ConnectorError('contract', 'Resposta não é JSON válido.'); }
  const errs = validateContract(body, productCode, period);
  if (errs.length) throw new ConnectorError('contract', `Contrato inválido: ${errs.slice(0, 5).join(' ')}`);
  return body;
}

export async function testIntegration(integrationId, orgId) {
  const integ = q.get('SELECT i.*, p.code AS product_code FROM integrations i JOIN products p ON p.id = i.product_id WHERE i.id = ? AND i.organization_id = ?', integrationId, orgId);
  if (!integ) throw new Error('Integração não encontrada.');
  q.run("UPDATE integrations SET status = 'testing' WHERE id = ?", integ.id);
  const end = new Date(); end.setUTCDate(1); end.setUTCHours(3, 0, 0, 0); // 1º dia do mês 00:00 BRT
  const start = new Date(end); start.setUTCMonth(start.getUTCMonth() - 1);
  const period = { start: start.toISOString(), end_exclusive: end.toISOString(), timezone: 'America/Sao_Paulo' };
  try {
    const body = await fetchMetrics(integ, integ.product_code, period);
    const result = { ok: true, metrics: body.metrics.length, checked_period: period };
    q.run("UPDATE integrations SET status = 'connected', last_checked_at = ?, last_check_result = ? WHERE id = ?", now(), JSON.stringify(result), integ.id);
    return { status: 'connected', ...result };
  } catch (e) {
    const kind = e.kind || 'unavailable';
    const status = kind === 'config' ? 'pending_setup' : 'error';
    const result = { ok: false, kind, message: e.message };
    q.run('UPDATE integrations SET status = ?, last_checked_at = ?, last_check_result = ? WHERE id = ?', status, now(), JSON.stringify(result), integ.id);
    return { status, ...result };
  }
}

export function checksumOf(obj) { return sha256(canonicalJson(obj)); }
