// Briefing do dia (tela Comando, comando RESUMO, envio diário) e comando RADAR pelo WhatsApp.
import './env-master.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { orgA, createUser, login, stopServer, startServer, q } from './helpers.js';
import { waHooks } from '../src/connectors/whatsapp.js';
import { handleInbound, waChatHooks } from '../src/services/whatsapp-approvals.js';
import { processBriefings } from '../src/services/briefing.js';

createUser(orgA, 'brief.owner@lorler.test', 'owner');
after(() => stopServer());

const sent = [];
waHooks.fetch = async (url, opts = {}) => { sent.push(JSON.parse(opts.body)); return new Response(JSON.stringify({ messages: [{ id: `wamid.b${sent.length}` }] }), { status: 200 }); };
waChatHooks.delay = async () => {};
const PHONE = '5519955554444';
let n = 0;
const msg = (text) => ({ id: `wamid.brief.${++n}`, from: PHONE, text });

async function linkPhone(owner) {
  const b = await startServer();
  const link = (await owner.call('POST', '/api/whatsapp/link', {})).body;
  const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111' }, messages: [{ id: `wamid.blink.${++n}`, from: PHONE, timestamp: '1', type: 'text', text: { body: link.message } }] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret').update(raw).digest('hex');
  await fetch(`${b}/api/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body: raw });
}

test('briefing da tela Comando: itens calculados, manchete e fonte', async () => {
  const owner = await login('brief.owner@lorler.test');
  const r = await owner.call('GET', '/api/briefing');
  assert.equal(r.status, 200);
  assert.ok(r.body.headline);
  assert.ok(Array.isArray(r.body.items) && r.body.items.length >= 1);
  assert.ok(r.body.items.every((i) => ['info', 'warn', 'danger', 'good'].includes(i.level) && i.title && i.text));
  assert.equal(r.body.source, 'demo');
});

test('WhatsApp: liga o briefing com horário válido, RESUMO e RADAR respondem, envio diário sai uma vez só', async () => {
  const owner = await login('brief.owner@lorler.test');
  assert.equal((await owner.call('POST', '/api/whatsapp/briefing', { enabled: true })).status, 400, 'sem número vinculado');
  await linkPhone(owner);
  assert.equal((await owner.call('POST', '/api/whatsapp/briefing', { enabled: true, time: '25:00' })).status, 400, 'horário inválido');
  const ok = await owner.call('POST', '/api/whatsapp/briefing', { enabled: true, time: '00:00' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.link.briefing, true);
  assert.equal(ok.body.link.briefing_time, '00:00');

  const replies = [];
  await handleInbound(msg('resumo'), { reply: async (to, t) => { replies.push(t); } });
  assert.match(replies.at(-1), /Briefing do Cérebro LORLER/);
  await handleInbound(msg('RADAR'), { reply: async (to, t) => { replies.push(t); } });
  assert.match(replies.at(-1), /Radar dos sistemas/);
  assert.match(replies.at(-1), /ORBI/);
  await handleInbound(msg('ajuda'), { reply: async (to, t) => { replies.push(t); } });
  assert.match(replies.at(-1), /RESUMO/);

  // dentro da janela de 3 h depois do horário (00:00 → só passa entre 00:00 e 03:00); força a janela ajustando o horário
  const tz = q.get('SELECT timezone FROM organizations WHERE id = ?', orgA).timezone || 'America/Sao_Paulo';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  await owner.call('POST', '/api/whatsapp/briefing', { time: `${p.hour}:${p.minute}` });
  const out = [];
  const r1 = await processBriefings({ send: async (to, t) => { out.push({ to, t }); } });
  assert.equal(r1.sent, 1);
  assert.equal(out[0].to, PHONE);
  assert.match(out[0].t, /Briefing/);
  const r2 = await processBriefings({ send: async (to, t) => { out.push({ to, t }); } });
  assert.equal(r2.sent, 0, 'não repete no mesmo dia');

  const sendNow = await owner.call('POST', '/api/whatsapp/briefing/send', {});
  assert.equal(sendNow.status, 200);
  assert.ok(sent.some((m) => m.to === PHONE && /Briefing/.test(m.text?.body || '')));
  const chat = await owner.call('GET', '/api/whatsapp/chat');
  assert.equal(chat.status, 200);
  assert.ok(Array.isArray(chat.body.turns));
  await owner.call('POST', '/api/whatsapp/briefing', { enabled: false });
  assert.equal(q.get("SELECT briefing FROM whatsapp_links WHERE wa_id = ? AND status = 'verified'", PHONE).briefing, 0);
});
