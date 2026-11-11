// Conversa livre do Cérebro com a mesma IA da Central de Atendimento do ORBI (Área Master simulada).
import './env-master.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { orgA, createUser, login, stopServer } from './helpers.js';
import { masterHooks } from '../src/connectors/master.js';

createUser(orgA, 'brain.owner@lorler.test', 'owner');
after(() => { delete process.env.LORLER_CONVERSA_IA; stopServer(); });

const S = { calls: [], answer: { reply: 'No TORVEN você abre a ordem de serviço em Ordens › Nova. Veja a aula 3.', intent: 'answer' }, fail: false };
masterHooks.fetch = async (url, opts = {}) => {
  const path = new URL(url).pathname.replace('/api/master', '');
  const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
  if (path === '/auth/login') return j({ token: 'jwt-master' });
  if (opts.headers?.Authorization !== 'Bearer jwt-master') return j({ error: 'sem login' }, 401);
  if (path === '/atendimento/assistente/conversa') { S.calls.push(JSON.parse(opts.body)); return S.fail ? j({ error: 'A IA não respondeu agora.' }, 502) : j(S.answer); }
  return j({ error: 'não simulada' }, 404);
};
const say = (c, message, extra = {}) => c.call('POST', '/api/conversation', { message, ...extra });

test('pergunta livre vai para a IA do suporte, com histórico, telas e dados do painel', async () => {
  const c = await login('brain.owner@lorler.test');
  const r = await say(c, 'como abro uma ordem de serviço no torven?', { history: [{ role: 'user', text: 'oi' }, { role: 'assistant', text: 'Olá!' }] });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /Ordens › Nova/);
  const sent = S.calls.at(-1);
  assert.equal(sent.message, 'como abro uma ordem de serviço no torven?');
  assert.equal(sent.history.length, 2);
  assert.ok(sent.telas.includes('aprovacoes'));
  assert.ok(sent.contexto && 'sistemas' in sent.contexto);
  assert.ok(!('via' in r.body));
});

test('a IA pode propor análise e abrir telas conhecidas, nunca telas inventadas', async () => {
  const c = await login('brain.owner@lorler.test');
  S.answer = { reply: 'Abrindo.', intent: 'navigate', navigate_to: 'admin-secreto' };
  assert.equal((await say(c, 'abre a tela secreta')).body.intent, 'answer');
  S.answer = { reply: 'Quer que eu abra?', intent: 'propose_analysis', analysis_question: 'Vale subir o preço do plano do ORBI?' };
  const p = await say(c, 'devo subir o preço?');
  assert.equal(p.body.intent, 'propose_analysis');
});

test('aprovação continua bloqueada antes da IA; falha da IA cai na resposta do painel', async () => {
  const c = await login('brain.owner@lorler.test');
  const n = S.calls.length;
  const ap = await say(c, 'aprova isso agora');
  assert.equal(ap.body.intent, 'navigate_offer');
  assert.equal(S.calls.length, n, 'pedido de aprovação não chega à IA');
  S.fail = true;
  const r = await say(c, 'como estão os sistemas?');
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /sistemas/);
  S.fail = false;
  process.env.LORLER_CONVERSA_IA = 'proprio';
  const m = S.calls.length;
  await say(c, 'como estão os sistemas?');
  assert.equal(S.calls.length, m, 'LORLER_CONVERSA_IA=proprio desliga');
});
