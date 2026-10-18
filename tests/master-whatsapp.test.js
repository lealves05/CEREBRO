// Área Master (leitura + mudanças aprovadas) e aprovações pelo WhatsApp — APIs simuladas.
import './env-master.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { orgA, createUser, login, stopServer, startServer, productIds, drain, q } from './helpers.js';
import { masterHooks, resetSession } from '../src/connectors/master.js';
import { waHooks } from '../src/connectors/whatsapp.js';
import { processOutbox } from '../src/services/whatsapp-approvals.js';

createUser(orgA, 'owner@lorler.test', 'owner');
after(() => stopServer());

// ---------- Área Master simulada ----------
const M = { settings: { trial_default: '15_DAYS', grace_days: 5, renewal_notice_days: 7, signup_enabled: true }, puts: [], logins: 0 };
const now = Date.now(); const day = 86400_000;
const tenants = [
  { id: 't1', name: 'Salão A', status: 'ACTIVE', created_at: new Date(now - 10 * day).toISOString(), trial_type: '15_DAYS', last_payment: new Date(now - 2 * day).toISOString() },
  { id: 't2', name: 'Salão B', status: 'TRIAL', created_at: new Date(now - 5 * day).toISOString(), trial_type: '15_DAYS', last_payment: null },
  { id: 't3', name: 'Barbearia C', status: 'ACTIVE', created_at: new Date(now - 90 * day).toISOString(), trial_type: null, last_payment: new Date(now - 20 * day).toISOString() },
];
masterHooks.fetch = async (url, opts = {}) => {
  const u = new URL(url); const path = u.pathname.replace('/api/master', ''); const method = opts.method || 'GET';
  const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
  if (path === '/auth/login') { M.logins++; const b = JSON.parse(opts.body); return b.password === 'senha-master-teste1' ? j({ token: 'jwt-master' }) : j({ error: 'Usuário ou senha incorretos.' }, 401); }
  if (opts.headers?.Authorization !== 'Bearer jwt-master') return j({ error: 'Entre na administração' }, 401);
  if (path === '/dashboard') return j({ kpis: { total: 3, mrr: 198 }, products: [{ code: 'orbi', mrr: 198 }] });
  if (path === '/tenants') return j(tenants);
  if (path === '/subscriptions') return j([{ id: 's1', status: 'ACTIVE', started_at: new Date(now - 8 * day).toISOString(), canceled_at: null }, { id: 's2', status: 'ACTIVE', started_at: new Date(now - 80 * day).toISOString(), canceled_at: null }]);
  if (path === '/payments') return j([{ id: 'p1', status: 'CONFIRMED', amount: '99.00', paid_at: new Date(now - 2 * day).toISOString() }, { id: 'p2', status: 'PENDING', amount: '99.00', paid_at: null }]);
  if (path === '/plans') return j({ items: [{ id: 'plan-1', code: 'ESSENCIAL', name: 'Essencial', product: 'orbi', monthly_price: '99.00', annual_price: '990.00', active: true, features: {}, max_users: 3, sort: 0, tenants: 2 }] });
  if (path === '/settings' && method === 'GET') return j({ settings: { ...M.settings }, overrides: {}, keys: Object.keys(M.settings) });
  if (path === '/settings' && method === 'PUT') { const b = JSON.parse(opts.body); M.puts.push({ path, query: u.search, body: b }); Object.assign(M.settings, b); return j({ settings: { ...M.settings } }); }
  if (path.startsWith('/plans/') && method === 'PUT') { M.puts.push({ path, body: JSON.parse(opts.body) }); return j({ id: 'plan-1' }); }
  return j({ error: `rota não simulada ${path}` }, 404);
};

// ---------- WhatsApp simulado ----------
const sent = [];
waHooks.fetch = async (url, opts = {}) => { const b = JSON.parse(opts.body); sent.push(b); return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 }); };
const lastTo = (n) => [...sent].reverse().find((m) => m.to === n);
const textOf = (m) => m?.text?.body || m?.interactive?.body?.text || '';
const PHONE = '5519988887777';
let msgN = 0;
async function webhook(payload, { sign = true } = {}) {
  const b = await startServer();
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret').update(raw).digest('hex');
  return fetch(`${b}/api/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sign ? { 'x-hub-signature-256': sig } : {}) }, body: raw });
}
const inbound = (from, { text, button } = {}) => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111' }, messages: [{ id: `wamid.in.${++msgN}`, from, timestamp: String(Date.now() / 1000 | 0), ...(button ? { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: button, title: 'x' } } } : { type: 'text', text: { body: text } }) }] } }] }] });
const period = { start: new Date(now - 30 * day).toISOString(), end_exclusive: new Date(now + day).toISOString() };

async function masterDecision(owner, question = 'Devemos ampliar o período de teste grátis do ORBI na Área Master?') {
  const r = await owner.call('POST', '/api/decisions', { question, product_ids: productIds(orgA, ['ORBI']), decision_type: 'comercial', mode: 'real', period });
  assert.equal(r.status, 202, JSON.stringify(r.body));
  await drain();
  return (await owner.call('GET', `/api/decisions/${r.body.decision_id}`)).body;
}

test('análise real lê a Área Master e propõe mudança com valor anterior registrado pelo servidor', async () => {
  const owner = await login('owner@lorler.test');
  const d = await masterDecision(owner);
  const ev = d.current.evidence;
  assert.ok(ev.some((e) => e.source_ref === 'master/orbi/metrics' && e.is_demo === 0));
  const cfg = ev.find((e) => e.source_ref === 'master/orbi/config');
  assert.equal(cfg.payload.settings.trial_default, '15_DAYS');
  const metrics = ev.find((e) => e.source_ref === 'master/orbi/metrics').payload.metrics;
  assert.equal(metrics.active_subscriptions_at_period_end.value, '2');
  assert.equal(metrics.cash_received_in_period.value, '99.00');
  const p = d.current.proposals.at(-1);
  assert.equal(p.tool_code, 'master_update_settings');
  assert.equal(p.status, 'awaiting_approval');
  assert.deepEqual(p.parameters.before, { trial_default: '15_DAYS' });
  assert.deepEqual(p.parameters.values, { trial_default: '30_DAYS' });
});

test('aprovação aplica a mudança na Área Master; mudança concorrente bloqueia a execução', async () => {
  const owner = await login('owner@lorler.test');
  q.run('UPDATE sessions SET last_reauth_at = ?', new Date().toISOString());
  const d = await masterDecision(owner);
  const p = d.current.proposals.at(-1);
  const r = await owner.call('POST', `/api/actions/${p.id}/approve`, { proposal_version: p.version, payload_hash: p.payload_hash });
  assert.equal(r.body.execution.status, 'succeeded', JSON.stringify(r.body));
  assert.deepEqual(M.puts.at(-1).body, { trial_default: '30_DAYS' });
  assert.equal(M.puts.at(-1).query, '?product=orbi');
  // Segunda análise propõe voltar a 15 dias; alguém muda o valor no Master antes da aprovação
  const d2 = await masterDecision(owner);
  const p2 = d2.current.proposals.at(-1);
  M.settings.trial_default = 'UNLIMITED';
  const puts = M.puts.length;
  q.run('UPDATE sessions SET last_reauth_at = ?', new Date().toISOString());
  const r2 = await owner.call('POST', `/api/actions/${p2.id}/approve`, { proposal_version: p2.version, payload_hash: p2.payload_hash });
  assert.equal(r2.body.execution.status, 'failed');
  assert.match(r2.body.execution.error, /mudaram/);
  assert.equal(M.puts.length, puts, 'nenhuma escrita após detectar mudança');
  M.settings.trial_default = '15_DAYS';
});

test('mudança na Área Master a partir de análise de demonstração é bloqueada', async () => {
  const owner = await login('owner@lorler.test');
  const r = await owner.call('POST', '/api/decisions', { question: 'Devemos ampliar a carência do ORBI na Área Master?', product_ids: productIds(orgA, ['ORBI']), mode: 'demo', period });
  await drain();
  const p = (await owner.call('GET', `/api/decisions/${r.body.decision_id}`)).body.current.proposals.at(-1);
  assert.equal(p.tool_code, 'master_update_settings');
  assert.equal(p.status, 'denied');
});

test('WhatsApp: vínculo pelo próprio número, PIN, pedido com botões e aprovação confirmada por PIN', async () => {
  const owner = await login('owner@lorler.test');
  const b = await startServer();
  const v = await fetch(`${b}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=verifica-123&hub.challenge=abc`);
  assert.equal(await v.text(), 'abc');
  assert.equal((await webhook(inbound(PHONE, { text: 'oi' }), { sign: false })).status, 401);

  const link = (await owner.call('POST', '/api/whatsapp/link', {})).body;
  assert.match(link.message, /^LORLER \d{6}$/);
  await webhook(inbound(PHONE, { text: link.message }));
  assert.match(textOf(lastTo(PHONE)), /vinculado/i);
  q.run('UPDATE sessions SET last_reauth_at = ?', new Date().toISOString());
  assert.equal((await owner.call('POST', '/api/whatsapp/pin', { pin: '1234' })).status, 400, 'PIN previsível recusado');
  assert.equal((await owner.call('POST', '/api/whatsapp/pin', { pin: '4071' })).status, 200);

  const before = sent.length;
  await webhook(inbound('5511000000000', { text: 'PENDENTES' }));
  assert.equal(sent.length, before, 'número desconhecido não recebe resposta');

  const d = await masterDecision(owner, 'Devemos ampliar a carência do ORBI na Área Master?');
  const p = d.current.proposals.at(-1);
  await processOutbox();
  const notice = lastTo(PHONE);
  assert.equal(notice.type, 'interactive');
  const code = /Código: \*([A-Z0-9]{6})\*/.exec(textOf(notice))[1];
  assert.ok(notice.interactive.action.buttons.some((x) => x.reply.id === `aprovar:${code}`));

  await webhook(inbound(PHONE, { button: `aprovar:${code}` }));
  assert.match(textOf(lastTo(PHONE)), /envie seu PIN/i);
  await webhook(inbound(PHONE, { text: '9999' }));
  assert.match(textOf(lastTo(PHONE)), /PIN incorreto/);
  assert.equal(q.get('SELECT status FROM action_proposals WHERE id = ?', p.id).status, 'awaiting_approval');
  await webhook(inbound(PHONE, { text: '4071' }));
  assert.match(textOf(lastTo(PHONE)), /Aprovado/);
  assert.equal(q.get('SELECT status FROM action_proposals WHERE id = ?', p.id).status, 'executed');
  assert.deepEqual(M.puts.at(-1).body, { grace_days: 7 });
  const appr = q.get('SELECT comment FROM approvals WHERE action_proposal_id = ?', p.id);
  assert.match(appr.comment, /WhatsApp/);

  // Código já usado não aprova de novo
  await webhook(inbound(PHONE, { text: `APROVAR ${code}` }));
  assert.match(textOf(lastTo(PHONE)), /não está mais válido/);
});

test('WhatsApp: rejeição por mensagem e mensagem repetida deduplicada', async () => {
  const owner = await login('owner@lorler.test');
  const d = await masterDecision(owner, 'Devemos reajustar o plano do ORBI na Área Master?');
  const p = d.current.proposals.at(-1);
  assert.equal(p.tool_code, 'master_update_plan');
  assert.equal(p.parameters.before.monthly_price, 99);
  await processOutbox();
  const code = /Código: \*([A-Z0-9]{6})\*/.exec(textOf(lastTo(PHONE)))[1];
  const payload = inbound(PHONE, { text: `REJEITAR ${code} preço ainda não` });
  await webhook(payload);
  const n = sent.length;
  await webhook(payload); // reentrega da Meta
  assert.equal(sent.length, n, 'reentrega não gera nova resposta');
  assert.equal(q.get('SELECT status FROM action_proposals WHERE id = ?', p.id).status, 'rejected');
  assert.match(q.get("SELECT comment FROM approvals WHERE action_proposal_id = ?", p.id).comment, /preço ainda não/);
});

test('credencial errada da Área Master é identificada sem expor a senha', async () => {
  const owner = await login('owner@lorler.test');
  process.env.LORLER_SECRET_MASTER_PASSWORD = 'errada123';
  resetSession();
  const r = await owner.call('POST', '/api/master/test', {});
  assert.equal(r.body.ok, false);
  assert.equal(r.body.kind, 'auth');
  assert.ok(!JSON.stringify(r.body).includes('errada123'));
  process.env.LORLER_SECRET_MASTER_PASSWORD = 'senha-master-teste1';
  resetSession();
});

test('Centro de Análise lê as bases dos sistemas na Área Master', async () => {
  const owner = await login('owner@lorler.test');
  const r = await owner.call('GET', '/api/analytics?refresh=1');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.source, 'master');
  assert.equal(r.body.days.length, 30);
  const orbi = r.body.products.find((p) => p.code === 'ORBI');
  assert.equal(orbi.source, 'master');
  assert.equal(orbi.kpis.active, 2);
  assert.equal(orbi.kpis.trial, 1);
  assert.equal(orbi.kpis.cash, 99);
  assert.equal(orbi.kpis.open_receivables, 99);
  assert.equal(orbi.kpis.mrr, 198);
  assert.equal(orbi.kpis.conversion_pct, 50);
  assert.equal(orbi.series.cash.reduce((a, b) => a + b, 0), 99);
  assert.ok(orbi.health >= 0 && orbi.health <= 100);
  assert.ok(!JSON.stringify(r.body).includes('senha-master-teste1'));
});

test('Relatório das bases: atividades recentes e projeções (ORBI, Master, Instagram, WhatsApp)', async () => {
  const owner = await login('owner@lorler.test');
  const orbi = await owner.call('GET', '/api/sources/ORBI/report');
  assert.equal(orbi.status, 200, JSON.stringify(orbi.body));
  assert.equal(orbi.body.source, 'master');
  assert.equal(orbi.body.chart.actual.length, 30);
  assert.equal(orbi.body.chart.projected.length, 30);
  assert.ok(orbi.body.projections.length >= 5);
  assert.ok(orbi.body.activities.some((a) => a.type === 'signup' && a.text.includes('Salão B')));
  assert.ok(orbi.body.activities.some((a) => a.type === 'payment'));
  for (const code of ['MASTER', 'INSTAGRAM', 'WHATSAPP']) {
    const r = await owner.call('GET', `/api/sources/${code}/report`);
    assert.equal(r.status, 200, `${code}: ${JSON.stringify(r.body)}`);
    assert.ok(Array.isArray(r.body.kpis) && Array.isArray(r.body.activities));
  }
  assert.equal((await owner.call('GET', '/api/sources/XPTO/report')).status, 404);
  assert.ok(!JSON.stringify(orbi.body).includes('senha-master-teste1'));
});

test('tendência linear projeta a continuação da série', async () => {
  const { linearTrend } = await import('../src/services/reports.js');
  const t = linearTrend(Array.from({ length: 30 }, (_, i) => i));
  assert.equal(t.trend, 'alta');
  assert.equal(t.next[0], 30);
  assert.equal(t.next.length, 30);
  assert.equal(linearTrend(Array(30).fill(0)).total, 0);
  assert.ok(linearTrend(Array.from({ length: 30 }, (_, i) => 30 - i)).next.every((v) => v >= 0));
});
