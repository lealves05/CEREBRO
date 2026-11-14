// Agente de suporte no número público da LORLER + número pessoal do dono (sem restrição).
import './env-master.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.LORLER_CONVERSA_IA = 'proprio';
const { orgA, createUser, login, stopServer, startServer, q } = await import('./helpers.js');
const { waHooks } = await import('../src/connectors/whatsapp.js');
const { handleInbound, waChatHooks } = await import('../src/services/whatsapp-approvals.js');
const support = await import('../src/services/support-agent.js');

const ownerId = createUser(orgA, 'sa.owner@lorler.test', 'owner');
createUser(orgA, 'sa.analyst@lorler.test', 'analyst');
after(() => stopServer());
const sent = [];
waHooks.fetch = async (url, init) => { try { const b = JSON.parse(init?.body || '{}'); if (b.to) sent.push(b); } catch { /* */ } return new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 }); };
waChatHooks.delay = async () => {};
let n = 0;
const msg = (from, text) => ({ id: `wamid.sa.${++n}`, from, text });
const CLIENTE = '5511988887777';

test('agente desligado: número desconhecido não recebe resposta', async () => {
  const r = await handleInbound(msg(CLIENTE, 'oi'), { reply: async () => { throw new Error('não devia responder'); } });
  assert.equal(r.ignored, 'unknown_number');
});

test('painel: liga o agente (só quem gerencia integrações) e cadastra o número pessoal com reautenticação', async () => {
  await startServer();
  const analyst = await login('sa.analyst@lorler.test');
  assert.equal((await analyst.call('PUT', '/api/support-agent', { enabled: true })).status, 403);
  const owner = await login('sa.owner@lorler.test');
  const put = await owner.call('PUT', '/api/support-agent', { enabled: true, handoff: true, hours: 'Seg a sex, 9h às 18h' });
  assert.equal(put.status, 200); assert.equal(put.body.enabled, true);
  q.run('UPDATE sessions SET last_reauth_at = ?', new Date().toISOString());
  assert.equal((await owner.call('POST', '/api/support-agent/my-number', { number: '19 90000-0000' })).status, 400, 'número da LORLER recusado');
  assert.equal((await owner.call('POST', '/api/support-agent/my-number', { number: 'abc' })).status, 400);
  const ok = await owner.call('POST', '/api/support-agent/my-number', { number: '(19) 99876-5432' });
  assert.equal(ok.status, 200);
  const view = (await owner.call('GET', '/api/support-agent')).body;
  assert.ok(view.my_number); assert.equal(view.enabled, true);
  assert.equal(q.get("SELECT status FROM whatsapp_links WHERE wa_id = '5519998765432'").status, 'verified');
});

test('cliente: saudação, dúvida técnica, fora do assunto e pedido de atendente (avisa o dono)', async () => {
  const replies = [];
  const reply = async (to, t) => { replies.push({ to, t }); return 'ok'; };
  assert.equal((await handleInbound(msg(CLIENTE, 'oi'), { reply })).support, 'greeting');
  assert.match(replies.at(-1).t, /suporte técnico/);
  assert.equal((await handleInbound(msg(CLIENTE, 'quanto a lorler fatura por mês? e o futebol?'), { reply })).support, 'off_topic');
  assert.match(replies.at(-1).t, /só consigo ajudar com dúvidas técnicas/);
  let asked = null;
  support.hooks.brain = async (b) => { asked = b; return { reply: 'No ORBI, vá em Agenda › Novo agendamento e escolha o profissional.' }; };
  const r = await handleInbound(msg(CLIENTE, 'como faço um agendamento no orbi?'), { reply });
  assert.equal(r.support, 'answer');
  assert.match(replies.at(-1).t, /Agenda/);
  if (asked) assert.match(asked.persona, /SOMENTE dúvidas técnicas/);
  support.hooks.brain = async () => ({ reply: 'O faturamento da LORLER é segredo.' });
  await handleInbound(msg(CLIENTE, 'como cadastro produto no rusten?'), { reply });
  assert.doesNotMatch(replies.at(-1).t, /faturamento/i, 'trava final bloqueia assunto interno');
  sent.length = 0;
  assert.equal((await handleInbound(msg(CLIENTE, 'quero falar com atendente'), { reply })).support, 'handoff');
  assert.match(replies.at(-1).t, /chamei um atendente/);
  const aviso = sent.find((s) => s.to === '5519998765432');
  assert.ok(aviso, 'dono avisado no número pessoal');
  assert.match(aviso.text.body, /wa\.me\/5511988887777/);
});

test('número pessoal do dono: não cai no suporte, conversa como ele mesmo', async () => {
  const replies = [];
  const r = await handleInbound(msg('5519998765432', 'ajuda'), { reply: async (to, t) => { replies.push(t); return 'ok'; } });
  assert.equal(r.support, undefined);
  assert.ok(replies.length >= 1);
  assert.doesNotMatch(replies.join('\n'), /só consigo ajudar com dúvidas técnicas/);
  assert.equal(ownerId.length > 0, true);
});

test('ponte com o Master (WhatsApp por QR Code): mensagem do número pessoal chega ao Cérebro e a resposta volta', async () => {
  const bridge = await import('../src/services/master-whatsapp.js');
  const handled = [];
  bridge.bridgeHooks.call = async (p) => { assert.match(p, /\/atendimento\/whatsapp\/cerebro\/pendentes/); return { items: [{ id: 7, phone: '5519998765432', text: 'RESUMO' }, { id: 8, phone: '5511900001111', text: 'oi' }, { id: 9, phone: '5519998765432', text: '', kind: 'audio', mime: 'audio/ogg', media: true }, { id: 10, phone: '5519998765432', text: 'pro post', kind: 'image', mime: 'image/jpeg', media: true }], owner_number: '5519998765432' }; };
  bridge.bridgeHooks.handle = async (m, { reply }) => { handled.push(m); await reply(m.from, 'ok'); return {}; };
  const n = await bridge.pollOnce({ wait: 0 });
  assert.equal(n, 4);
  assert.equal(handled.length, 3, 'só o número vinculado vira conversa');
  assert.equal(handled[0].id, 'master.7');
  assert.deepEqual(handled[1].audio, { id: 'master:9', mime: 'audio/ogg', voice: true });
  assert.equal(handled[2].media.id, 'master:10'); assert.equal(handled[2].media.kind, 'imagem');
  assert.equal(bridge.bridgeStatus().ok, true);
});
