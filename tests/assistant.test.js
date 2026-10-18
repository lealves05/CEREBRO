// Assistente configurável (nome, tom, avatar, voz) e conversa natural pelo WhatsApp.
import './env-master.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { orgA, createUser, login, stopServer, startServer, drain, q } from './helpers.js';
import { waHooks } from '../src/connectors/whatsapp.js';
import { handleInbound, waChatHooks, processChatFollowups } from '../src/services/whatsapp-approvals.js';
import { providerRegistry } from '../src/ai/provider.js';

createUser(orgA, 'pers.owner@lorler.test', 'owner');
createUser(orgA, 'pers.viewer@lorler.test', 'viewer');
after(() => { providerRegistry.override = null; stopServer(); });

const sent = [];
waHooks.fetch = async (url, opts = {}) => { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }] }), { status: 200 }); };
waChatHooks.delay = async () => {};
const PHONE = '5519977776666';
let n = 0;
const msg = (text) => ({ id: `wamid.chat.${++n}`, from: PHONE, text });

async function linkPhone(owner) {
  const b = await startServer();
  const link = (await owner.call('POST', '/api/whatsapp/link', {})).body;
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111' }, messages: [{ id: `wamid.link.${++n}`, from: PHONE, timestamp: '1', type: 'text', text: { body: link.message } }] } }] }] };
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret').update(raw).digest('hex');
  await fetch(`${b}/api/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
}

test('configuração do assistente: padrão, edição pelo owner, valores saneados e viewer só lê', async () => {
  const owner = await login('pers.owner@lorler.test');
  const g = await owner.call('GET', '/api/assistant');
  assert.equal(g.status, 200);
  assert.equal(g.body.settings.name, 'Cérebro');
  assert.equal(g.body.can_edit, true);
  const p = await owner.call('PUT', '/api/assistant', { name: 'Sofia', tone: 'amigavel', call_me: 'Leandro', avatar: { style: 'rosto', color: '#ff0066', image: 'https://exemplo.com/x.png' }, voice: { engine: 'openai', openai_voice: 'coral', rate: 9 } });
  assert.equal(p.status, 200);
  assert.equal(p.body.settings.name, 'Sofia');
  assert.equal(p.body.settings.avatar.style, 'rosto');
  assert.equal(p.body.settings.avatar.image, '', 'link externo de imagem não é aceito');
  assert.equal(p.body.settings.voice.rate, 1.6, 'velocidade limitada');
  const bad = await owner.call('PUT', '/api/assistant', { tone: 'grosso', avatar: { color: 'red' } });
  assert.equal(bad.body.settings.tone, 'amigavel', 'tom inválido mantém o atual');
  assert.equal(bad.body.settings.avatar.color, '#ff0066');
  const v = await login('pers.viewer@lorler.test');
  assert.equal((await v.call('GET', '/api/assistant')).body.settings.name, 'Sofia');
  assert.equal((await v.call('PUT', '/api/assistant', { name: 'Hack' })).status, 403);
});

test('saudação usa o nome configurado; com IA, os números calculados vão como dados prontos e a persona entra nas instruções', async () => {
  const owner = await login('pers.owner@lorler.test');
  const oi = await owner.call('POST', '/api/conversation', { message: 'oi' });
  assert.match(oi.body.reply, /Leandro\. Aqui é Sofia/);
  let seen = null;
  providerRegistry.override = { name: 'teste', async validateConfiguration() { return { valid: true }; },
    async analyze(req) { seen = req; return { status: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, output: { reply: 'Olha, o ORBI recebeu bem esse mês.', intent: 'answer', analysis_question: '', navigate_to: '' } }; } };
  const r = await owner.call('POST', '/api/conversation', { message: 'quanto o ORBI recebeu?' });
  assert.equal(r.body.reply, 'Olha, o ORBI recebeu bem esse mês.');
  assert.match(seen.input.dados_prontos, /No ORBI, recebemos R\$/);
  assert.match(seen.instructions, /Seu nome é Sofia/);
  assert.match(seen.instructions, /FALADA/);
  const ap = await owner.call('POST', '/api/conversation', { message: 'aprova isso agora' });
  assert.equal(ap.body.intent, 'navigate_offer', 'regras de segurança valem antes da IA');
  providerRegistry.override = null;
});

test('WhatsApp: texto livre vira conversa natural com memória, "sim" abre a análise sugerida e o aviso chega quando termina', async () => {
  const owner = await login('pers.owner@lorler.test');
  await linkPhone(owner);
  const replies = [];
  const reply = async (to, t) => { replies.push({ to, t }); return 'ok'; };
  const calls = [];
  providerRegistry.override = { name: 'teste', async validateConfiguration() { return { valid: true }; },
    async analyze(req) {
      calls.push(req);
      if (calls.length === 1) return { status: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, output: { reply: 'Opa, tudo certo por aqui!\n\nQuer que eu dê uma olhada em algo?', intent: 'answer', analysis_question: '', navigate_to: '' } };
      return { status: 'ok', usage: { inputTokens: 10, outputTokens: 5 }, output: { reply: 'Boa pergunta. Posso pedir para os especialistas analisarem, quer?', intent: 'propose_analysis', analysis_question: 'Vale a pena lançar um plano anual com desconto no TORVEN?', navigate_to: '' } };
    } };
  const r1 = await handleInbound(msg('e aí, tudo bem?'), { reply });
  assert.equal(r1.chat, 'answer');
  assert.deepEqual(replies.map((x) => x.t), ['Opa, tudo certo por aqui!', 'Quer que eu dê uma olhada em algo?'], 'resposta quebrada em mensagens curtas, como gente');
  assert.match(calls[0].instructions, /WhatsApp/);
  assert.match(calls[0].instructions, /Seu nome é Sofia/);
  assert.ok(sent.some((m) => m.status === 'read' && m.typing_indicator), 'marca como lida e mostra "digitando"');

  await handleInbound(msg('acha que vale fazer um plano anual no torven?'), { reply });
  assert.equal(calls[1].input.historico.length, 2, 'lembra da conversa anterior');
  const before = q.get('SELECT COUNT(*) AS c FROM decisions').c;
  replies.length = 0;
  const r3 = await handleInbound(msg('sim'), { reply });
  assert.equal(r3.chat, 'analysis_opened');
  assert.equal(q.get('SELECT COUNT(*) AS c FROM decisions').c, before + 1);
  assert.match(replies[0].t, /Te mando aqui/);
  assert.equal(calls.length, 2, 'confirmação não gasta IA');

  const help = await handleInbound(msg('ajuda'), { reply });
  assert.equal(help.help, true, 'comandos continuam funcionando');
  replies.length = 0;
  await handleInbound(msg('pode aprovar isso agora'), { reply });
  assert.match(replies[0].t, /APROVAR/, 'aprovação continua exigindo código + PIN');

  providerRegistry.override = null;
  await drain();
  const before2 = sent.length;
  await processChatFollowups();
  const aviso = sent.slice(before2).find((m) => m.to === PHONE);
  assert.match(aviso?.text?.body || '', /Saiu a análise|não chegou ao fim/);
  await processChatFollowups();
  assert.equal(sent.slice(before2).filter((m) => m.to === PHONE).length, 1, 'avisa uma vez só');
});

test('WhatsApp: com a conversa desligada, texto livre recebe os comandos; números desconhecidos seguem ignorados', async () => {
  const owner = await login('pers.owner@lorler.test');
  await owner.call('PUT', '/api/assistant', { whatsapp_chat: false });
  const replies = [];
  const r = await handleInbound(msg('bom dia'), { reply: async (to, t) => { replies.push(t); } });
  assert.equal(r.help, true);
  assert.match(replies[0], /Comandos LORLER/);
  const u = await handleInbound({ id: 'wamid.x.1', from: '5511000000001', text: 'oi' }, { reply: async () => {} });
  assert.equal(u.ignored, 'unknown_number');
  await owner.call('PUT', '/api/assistant', { whatsapp_chat: true });
});
