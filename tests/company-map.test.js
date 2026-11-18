// Mapa da empresa: departamentos com números ao vivo, rotinas autônomas, atividade e comandos pelo WhatsApp.
import './env-master.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const FILA = fs.mkdtempSync(path.join(os.tmpdir(), 'fila-mapa-'));
process.env.LORLER_SOCIAL_FILA = FILA;
const { orgA, createUser, login, startServer, stopServer, q } = await import('./helpers.js');
const cm = await import('../src/services/company-map.js');
const owner = await import('../src/services/owner-actions.js');
const ownerId = createUser(orgA, 'mapa.owner@lorler.test', 'owner');
after(() => { stopServer(); fs.rmSync(FILA, { recursive: true, force: true }); });
const ctx = { orgId: orgA, userId: ownerId, role: 'owner', productIds: null, channel: 'whatsapp' };

const hoje = new Date().toISOString();
const TENANTS = [
  { id: 't1', name: 'Barbearia Nova', product: 'orbi', status: 'TRIAL', trial_type: '15_DAYS', trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString(), created_at: hoje, phone: '(19) 9999-0000', last_access_at: hoje },
  { id: 't2', name: 'Oficina Velha', product: 'torven', status: 'ACTIVE', created_at: '2026-09-01T12:00:00Z', last_access_at: '2026-10-01T12:00:00Z' },
  { id: 't3', name: 'Bar do Zé', product: 'rusten', status: 'ACTIVE', created_at: '2026-09-02T12:00:00Z', last_access_at: hoje },
];
cm.mapHooks.master = async (p) => {
  if (p.startsWith('/tenants?status=INADIMPLENTE')) return [];
  if (p.startsWith('/tenants?expiring=1')) return [TENANTS[1]];
  if (p.startsWith('/tenants')) return TENANTS;
  if (p.startsWith('/payments')) return [{ amount: 89.9, status: 'CONFIRMED', paid_at: hoje }];
  return [];
};
const told = [];
cm.mapHooks.send = async (_c, t) => { told.push(t); return true; };

test('rotinas: contatos novos, caixa, risco e sites registram atividade e avisam', async () => {
  const r1 = await cm.runJob(ctx, 'contatos');
  assert.match(r1.text, /1 contato novo nas últimas 24 h · 1 com o teste acabando/);
  assert.match(told.at(-1), /Barbearia Nova/);
  const r2 = await cm.runJob(ctx, 'caixa');
  assert.match(r2.text, /R\$ 89,90 hoje/);
  const r3 = await cm.runJob(ctx, 'risco');
  assert.match(r3.text, /clientes em risco: 1/); assert.match(r3.text, /Oficina Velha/);
  let up = true;
  cm.mapHooks.fetch = async (url) => (url.includes('rusten') && !up ? Promise.reject(new Error('down')) : new Response('ok', { status: 200 }));
  await cm.runJob(ctx, 'sites');
  up = false; told.length = 0;
  const r4 = await cm.runJob(ctx, 'sites');
  assert.match(r4.text, /fora do ar agora: RUSTEN/); assert.equal(told.length, 1);
  up = true; const r5 = await cm.runJob(ctx, 'sites');
  assert.match(r5.text, /voltou ao ar: RUSTEN/);
  const act = cm.activity(ctx);
  assert.ok(act.some((a) => a.agent === 'Captador de Leads') && act.some((a) => a.agent === 'Guardião'));
});

test('agendador: roda cada rotina uma vez no horário e respeita desligada', async () => {
  q.run('DELETE FROM autopilot_jobs WHERE organization_id = ?', orgA);
  cm.mapHooks.now = () => new Date('2026-11-17T09:10:00-03:00'); // terça, 09:10
  const runs = [];
  const orig = { ...cm.RUN };
  for (const k of Object.keys(cm.RUN)) cm.RUN[k] = async () => { runs.push(k); return { text: '', quiet: true }; };
  cm.setJob(ctx, 'contatos', { enabled: false });
  await cm.processAutopilot();
  assert.ok(runs.includes('caixa'), 'caixa às 9h roda'); assert.ok(runs.includes('sites'), 'sites roda de hora em hora');
  assert.ok(!runs.includes('contatos'), 'desligada não roda'); assert.ok(!runs.includes('risco'), 'risco só segunda'); assert.ok(!runs.includes('post'), 'post só ao meio-dia');
  runs.length = 0; await cm.processAutopilot();
  assert.equal(runs.length, 0, 'não roda duas vezes');
  Object.assign(cm.RUN, orig); cm.mapHooks.now = () => new Date();
});

test('mapa: departamentos com números, rotinas, para aprovar e resumo pelo WhatsApp', async () => {
  const m = await cm.companyMap(ctx);
  assert.equal(m.departamentos.length, 8);
  assert.match(m.departamentos.find((d) => d.id === 'crm').kpi, /1 cadastro novo/);
  assert.match(m.departamentos.find((d) => d.id === 'financeiro').kpi, /R\$ 89,90/);
  assert.equal(m.rotinas.length, 5);
  assert.ok(m.equipe.agentes > 10);
  const s = await cm.mapSummary(ctx);
  assert.match(s, /Mapa da empresa/); assert.match(s, /Rotinas de hoje/);
  assert.equal(owner.quickIntent('me mostra o mapa da empresa')?.nome, 'mapa_empresa');
  assert.equal(owner.quickIntent('confere o caixa do dia')?.args.rotina, 'caixa');
});

test('painel: GET /api/mapa e ligar/desligar rotina', async () => {
  await startServer();
  const c = await login('mapa.owner@lorler.test');
  const r = await c.call('GET', '/api/mapa');
  assert.equal(r.status, 200); assert.equal(r.body.departamentos.length, 8);
  const off = await c.call('PUT', '/api/mapa/rotinas/post', { enabled: false });
  assert.equal(off.status, 200); assert.equal(off.body.enabled, false);
  assert.equal((await c.call('PUT', '/api/mapa/rotinas/xyz', { enabled: true })).status, 400);
});
