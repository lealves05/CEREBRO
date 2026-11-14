// Marketing do Cérebro: reunião pelo WhatsApp, plano (posts + anúncio + ações), aprovação com PIN/senha,
// fila do publicador da VPS, resultados e avisos, mídia enviada pelo WhatsApp e pelo painel.
import './env-master.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const FILA = fs.mkdtempSync(path.join(os.tmpdir(), 'fila-'));
process.env.LORLER_SOCIAL_FILA = FILA;
process.env.LORLER_CONVERSA_IA = 'proprio';
const { orgA, createUser, login, stopServer, startServer, q } = await import('./helpers.js');
const { waHooks } = await import('../src/connectors/whatsapp.js');
const { handleInbound, waChatHooks, processMarketing } = await import('../src/services/whatsapp-approvals.js');
const mkt = await import('../src/services/marketing.js');
const meeting = await import('../src/services/meeting.js');

const ownerId = createUser(orgA, 'mkt.owner@lorler.test', 'owner');
createUser(orgA, 'mkt.analyst@lorler.test', 'analyst');
after(() => { stopServer(); fs.rmSync(FILA, { recursive: true, force: true }); });
const PHONE = '5519944445555';
let n = 0;
const msg = (text, extra = {}) => ({ id: `wamid.mkt.${++n}`, from: PHONE, text, ...extra });
const ctx = { orgId: orgA, userId: ownerId, productIds: null, role: 'owner' };
waHooks.fetch = async () => new Response(JSON.stringify({ messages: [{ id: 'wamid.x' }] }), { status: 200 });
waChatHooks.delay = async () => {};

async function linkAndPin(owner) {
  const b = await startServer();
  const link = (await owner.call('POST', '/api/whatsapp/link', {})).body;
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111' }, messages: [{ id: `wamid.mktlink.${++n}`, from: PHONE, timestamp: '1', type: 'text', text: { body: link.message } }] } }] }] };
  const raw = JSON.stringify(payload);
  await fetch(`${b}/api/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret').update(raw).digest('hex') }, body: raw });
  q.run('UPDATE sessions SET last_reauth_at = ?', new Date().toISOString());
  assert.equal((await owner.call('POST', '/api/whatsapp/pin', { pin: '4071' })).status, 200);
}

test('leitura das respostas da reunião (objetivo, sistema, verba, período, redes, quando)', () => {
  assert.equal(meeting.parseObjective('quero vender mais'), 'vendas');
  assert.equal(meeting.parseObjective('reativar quem cancelou'), 'reativacao');
  assert.equal(meeting.parseProduct('vamos de rusten'), 'RUSTEN');
  assert.equal(meeting.parseBudget('r$ 1.250,50'), 125050);
  assert.equal(meeting.parseBudget('sem anuncio'), 0);
  assert.deepEqual(meeting.parseNetworks('instagram e linkedin'), ['instagram', 'linkedin']);
  assert.equal(meeting.parseNetworks('todas').length, 4);
  const p = meeting.parsePeriod('2 semanas');
  assert.ok(p.end_date > p.start_date);
  const w = meeting.parseWhen('sexta às 19h30');
  assert.equal(w.time, '19:30');
  const d = meeting.extractAll('reunião: campanha do ORBI pra vender mais, 30 dias grátis, 2 semanas, R$ 300 de anúncio, todas as redes');
  assert.equal(d.product_code, 'ORBI'); assert.equal(d.objective, 'vendas'); assert.equal(d.budget_cents, 30000); assert.equal(d.networks.length, 4); assert.ok(d.period);
});

test('reunião pelo WhatsApp: perguntas → plano → ajuste → APROVAR código + PIN → posts na fila do publicador', async () => {
  const owner = await login('mkt.owner@lorler.test');
  await linkAndPin(owner);
  let replies = [];
  const reply = async (to, t) => { replies.push(t); return 'ok'; };
  const last = () => replies.join('\n');
  const send = async (text, extra) => { replies = []; return handleInbound(msg(text, extra), { reply }); };
  await send('vamos fazer uma reunião de marketing');
  assert.match(last(), /objetivo/i);
  await send('vender mais');
  assert.match(last(), /sistema/i);
  await send('RUSTEN');
  await send('15 dias grátis');
  await send('padrão');
  await send('2 semanas');
  await send('R$ 280');
  await send('todas');
  await send('3 por semana');
  assert.match(last(), /Fechei o plano/);
  assert.match(last(), /Anúncio/);
  assert.match(last(), /Ação/);
  const m = q.get("SELECT * FROM mkt_meetings WHERE user_id = ? ORDER BY created_at DESC LIMIT 1", ownerId);
  assert.equal(m.step, 'review');
  const camp = mkt.getCampaign(ctx, m.campaign_id);
  assert.ok(camp.items.filter((i) => i.kind === 'post').length >= 4);
  assert.equal(camp.budget_cents, 28000);
  assert.ok(camp.items.find((i) => i.kind === 'anuncio').ad.orcamento_diario);
  // ajustes por mensagem
  await send('muda o 1 para sexta 19h');
  assert.match(last(), /vai/);
  await send('tira o 2');
  assert.match(last(), /Tirei o 2/);
  // foto enviada vira mídia dos posts
  waChatHooks.download = async () => ({ buffer: Buffer.from('jpegfalso'), mime: 'image/jpeg' });
  await send('', { media: { id: 'IMG1', mime: 'image/jpeg', kind: 'imagem' } });
  assert.match(last(), /coloquei em \d post/);
  delete waChatHooks.download;
  await send('pode aprovar');
  const code = /APROVAR (M[A-Z0-9]{5})/.exec(last())?.[1];
  assert.ok(code, last());
  assert.ok(q.get("SELECT 1 FROM vault_notes WHERE user_id = ? AND slug LIKE 'reuniao-marketing-%'", ownerId), 'ata da reunião no cofre');
  await send(`APROVAR ${code}`);
  assert.match(last(), /envie seu PIN/);
  await send('9999');
  assert.match(last(), /PIN incorreto/);
  await send('4071');
  assert.match(last(), /✅ Aprovado/);
  assert.match(last(), /agendados|publicando agora/);
  const files = fs.readdirSync(path.join(FILA, 'saida')).filter((f) => f.startsWith('cerebro-'));
  assert.ok(files.length >= 3, 'posts gravados na fila do publicador');
  const post = JSON.parse(fs.readFileSync(path.join(FILA, 'saida', files[0]), 'utf8'));
  assert.ok(post.quando && post.redes.length && post.textos && (post.video_url || post.imagem_url));
  assert.equal(post.tiktok.modo, 'rascunho');
  assert.ok(q.get("SELECT COUNT(*) AS c FROM internal_tasks WHERE business_ref LIKE 'mkt:%'").c >= 3, 'ações comerciais viraram tarefas');
  const canceled = q.get("SELECT COUNT(*) AS c FROM mkt_items WHERE campaign_id = ? AND status = 'cancelado'", camp.id).c;
  assert.equal(canceled, 1, 'o item tirado na reunião não foi publicado');
  // o publicador devolve o resultado → status publicado + aviso no WhatsApp
  const id = files[0].replace(/^cerebro-|\.json$/g, '');
  const nets = post.redes;
  fs.mkdirSync(path.join(FILA, 'resultados'), { recursive: true });
  fs.writeFileSync(path.join(FILA, 'resultados', `cerebro-${id}.resultado.json`), JSON.stringify({ concluido: true, redes: Object.fromEntries(nets.map((r) => [r, { situacao: 'publicado', url: `https://exemplo.com/${r}/1` }])) }));
  const avisos = [];
  await processMarketing({ send: async (to, t) => { avisos.push(t); } });
  assert.equal(mkt.getItem(ctx, id).status, 'publicado');
  assert.match(avisos[0], /📣 Publicado/);
  assert.match(avisos[0], /exemplo\.com/);
  await processMarketing({ send: async (to, t) => { avisos.push(t); } });
  assert.equal(avisos.length, 1, 'avisa uma vez só');
});

test('JARVIS: "agende um post" cria o rascunho com código; "o que está agendado" lista; MARKETING no WhatsApp', async () => {
  const c = await login('mkt.owner@lorler.test');
  const r = await c.call('POST', '/api/conversation', { message: 'agende um post no instagram e facebook amanhã às 18h sobre agenda online do ORBI', channel: 'text' });
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /Deixei pronto/);
  assert.match(r.body.reply, /APROVAR M[A-Z0-9]{5}/);
  const it = q.get("SELECT * FROM mkt_items WHERE source LIKE 'conversa:%' ORDER BY created_at DESC LIMIT 1");
  assert.equal(it.status, 'aguardando_aprovacao');
  assert.deepEqual(JSON.parse(it.networks), ['instagram', 'facebook']);
  const l = await c.call('POST', '/api/conversation', { message: 'o que está agendado?', channel: 'text' });
  assert.match(l.body.reply, /Nos próximos 7 dias/);
  const replies = [];
  await handleInbound(msg('MARKETING'), { reply: async (to, t) => { replies.push(t); } });
  assert.match(replies[0], /Esperando sua aprovação/);
});

test('painel: plano, aprovação exige permissão e senha recente, cancelar tira da fila, mídia pública, validações', async () => {
  const owner = await login('mkt.owner@lorler.test');
  const analyst = await login('mkt.analyst@lorler.test');
  const plan = await owner.call('POST', '/api/mkt/plan', { product_code: 'TORVEN', objective: 'leads', networks: ['instagram', 'linkedin'], posts_per_week: 2, budget_cents: 0 });
  assert.equal(plan.status, 200);
  assert.ok(!plan.body.items.some((i) => i.kind === 'anuncio'), 'sem verba, sem anúncio');
  const sub = await owner.call('POST', '/api/mkt/submit', { campaign_id: plan.body.id });
  assert.match(sub.body.code, /^M[A-Z0-9]{5}$/);
  assert.equal((await analyst.call('POST', '/api/mkt/approve', { campaign_id: plan.body.id })).status, 403, 'analista não aprova');
  q.run('UPDATE sessions SET last_reauth_at = ?', '2020-01-01T00:00:00.000Z');
  const noAuth = await owner.call('POST', '/api/mkt/approve', { campaign_id: plan.body.id });
  assert.equal(noAuth.status, 403); assert.equal(noAuth.body.error.code, 'reauth_required');
  q.run('UPDATE sessions SET last_reauth_at = ?', new Date().toISOString());
  const ok = await owner.call('POST', '/api/mkt/approve', { campaign_id: plan.body.id });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.queued.length >= 2);
  const first = ok.body.queued[0];
  assert.ok(fs.existsSync(path.join(FILA, 'saida', `cerebro-${first}.json`)));
  const can = await owner.call('POST', `/api/mkt/items/${first}/cancel`, {});
  assert.equal(can.body.status, 'cancelado');
  assert.ok(!fs.existsSync(path.join(FILA, 'saida', `cerebro-${first}.json`)), 'cancelado sai da fila');
  // post avulso sem mídia no Instagram não passa
  const solo = await owner.call('POST', '/api/mkt/items', { kind: 'post', title: 'Teste', networks: ['instagram'], text: 'oi', scheduled_at: new Date(Date.now() + 86400_000).toISOString() });
  assert.ok(solo.body.issues.some((x) => /Instagram: precisa de imagem/.test(x)));
  const appr = await owner.call('POST', '/api/mkt/approve', { item_id: solo.body.id });
  assert.equal(appr.body.queued.length, 0); assert.equal(appr.body.skipped.length, 1);
  // mídia enviada pelo painel vira link público
  const up = await owner.call('POST', '/api/mkt/media', { data: Buffer.from('PNGfalso').toString('base64'), mime: 'image/png', filename: 'a.png' });
  assert.match(up.body.url, /\/api\/public\/midia\/[a-f0-9]{32}\.png$/);
  const b = await startServer();
  const pub = await fetch(`${b}/api/public/midia/${up.body.id}.png`);
  assert.equal(pub.status, 200); assert.equal(pub.headers.get('content-type'), 'image/png'); assert.equal(await pub.text(), 'PNGfalso');
  assert.equal((await fetch(`${b}/api/public/midia/../../etc.png`)).status, 404);
  const ed = await owner.call('PUT', `/api/mkt/items/${solo.body.id}`, { media_url: `https://cerebro.lorler.com.br/api/public/midia/${up.body.id}.png` });
  assert.equal(ed.body.issues.length, 0);
  const ov = await owner.call('GET', '/api/mkt/overview');
  assert.ok(ov.body.library.length >= 12 && ov.body.publisher && ov.body.items.length);
});

test('post aprovado pelo WhatsApp publica na hora (e "AGENDADO" mantém o horário)', async () => {
  const ctxA = { orgId: orgA, userId: ownerId, role: 'owner', productIds: null };
  const later = new Date(Date.now() + 3 * 86400000).toISOString();
  const mk = () => { const it = mkt.createItem(ctxA, { kind: 'post', title: 'Teste agora', networks: ['facebook'], text: 'Olá do ORBI', media_url: 'https://cdn.jsdelivr.net/gh/x/y.jpg', media_kind: 'imagem', scheduled_at: later }, { source: 'teste' }); mkt.submit(ctxA, { item_id: it.id }); return it; };
  const a = mk();
  const r = mkt.approve(ctxA, { item_id: a.id, via: 'whatsapp', publishNow: true });
  assert.equal((r.now || []).length, 1);
  const qa = JSON.parse(fs.readFileSync(path.join(FILA, 'saida', `cerebro-${a.id}.json`), 'utf8'));
  assert.ok(Date.parse(qa.quando) <= Date.now() + 1000, 'vai para a fila com horário de agora');
  assert.equal(mkt.getItem(ctxA, a.id).status, 'na_fila');
  const b = mk();
  mkt.approve(ctxA, { item_id: b.id, via: 'whatsapp', publishNow: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(FILA, 'saida', `cerebro-${b.id}.json`), 'utf8')).quando, later);
});

test('WhatsApp: "Aprovar mwoym74071" (código e PIN colados), "APROVAR CÓDIGO PIN" e "APROVAR PIN AGENDADO"', async () => {
  const ctxA = { orgId: orgA, userId: ownerId, role: 'owner', productIds: null };
  const replies = []; const reply = async (_to, t) => { replies.push(t); return 'ok'; };
  const later = new Date(Date.now() + 2 * 86400000).toISOString();
  const mk = () => { const it = mkt.createItem(ctxA, { kind: 'post', title: 'Teste pin', networks: ['facebook'], text: 'Olá', media_url: 'https://cdn.jsdelivr.net/gh/x/y.jpg', media_kind: 'imagem', scheduled_at: later }, { source: 'teste' }); return { it, code: mkt.submit(ctxA, { item_id: it.id }).code }; };
  const a = mk();
  await handleInbound(msg(`Aprovar ${a.code.toLowerCase()}4071`), { reply });
  assert.match(replies.at(-1), /✅ Aprovado.*publicando agora/s);
  assert.equal(mkt.getItem(ctxA, a.it.id).status, 'na_fila');
  const b = mk();
  await handleInbound(msg(`APROVAR ${b.code} 4071`), { reply });
  assert.match(replies.at(-1), /✅ Aprovado/);
  const c = mk();
  await handleInbound(msg(`APROVAR ${c.code}`), { reply });
  assert.match(replies.at(-1), /envie seu PIN/);
  await handleInbound(msg('APROVAR 4071 AGENDADO'), { reply });
  assert.match(replies.at(-1), /agendado/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(FILA, 'saida', `cerebro-${c.it.id}.json`), 'utf8')).quando, later);
  await handleInbound(msg('APROVAR 999999'), { reply });
  assert.match(replies.at(-1), /Não achei o código 999999/);
});
