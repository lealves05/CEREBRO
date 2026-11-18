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
const VIDEOS = fs.mkdtempSync(path.join(os.tmpdir(), 'videos-'));
process.env.LORLER_VIDEOS = VIDEOS;
process.env.LORLER_CONVERSA_IA = 'proprio';
const { orgA, createUser, login, stopServer, startServer, q } = await import('./helpers.js');
const { waHooks } = await import('../src/connectors/whatsapp.js');
const { handleInbound, waChatHooks, processMarketing } = await import('../src/services/whatsapp-approvals.js');
const mkt = await import('../src/services/marketing.js');
const meeting = await import('../src/services/meeting.js');

const ownerId = createUser(orgA, 'mkt.owner@lorler.test', 'owner');
createUser(orgA, 'mkt.analyst@lorler.test', 'analyst');
after(() => { stopServer(); fs.rmSync(FILA, { recursive: true, force: true }); fs.rmSync(VIDEOS, { recursive: true, force: true }); });
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
  q.run('UPDATE whatsapp_links SET pin_ok_until = NULL'); // fora da janela de 30 min do PIN
  await handleInbound(msg(`APROVAR ${c.code}`), { reply });
  assert.match(replies.at(-1), /envie seu PIN/);
  await handleInbound(msg('APROVAR 4071 AGENDADO'), { reply });
  assert.match(replies.at(-1), /agendado/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(FILA, 'saida', `cerebro-${c.it.id}.json`), 'utf8')).quando, later);
  await handleInbound(msg('APROVAR 999999'), { reply });
  assert.match(replies.at(-1), /Não achei o código 999999/);
});

const writeResult = (id, est) => { fs.mkdirSync(path.join(FILA, 'resultados'), { recursive: true }); fs.writeFileSync(path.join(FILA, 'resultados', `cerebro-${id}.resultado.json`), JSON.stringify(est)); };

test('PIN vale 30 min, APROVAR TUDO com um PIN só e aprovar de novo um post que falhou vira TENTAR DE NOVO', async () => {
  const ctxA = { orgId: orgA, userId: ownerId, role: 'owner', productIds: null };
  const replies = []; const reply = async (_to, t) => { replies.push(t); return 'ok'; };
  const later = new Date(Date.now() + 2 * 86400000).toISOString();
  const mk = (t = 'Tudo') => { const it = mkt.createItem(ctxA, { kind: 'post', title: t, networks: ['facebook'], text: 'Olá', media_url: 'https://cdn.jsdelivr.net/gh/x/y.jpg', media_kind: 'imagem', scheduled_at: later }, { source: 'teste' }); return { it, code: mkt.submit(ctxA, { item_id: it.id }).code }; };
  q.run("UPDATE mkt_items SET status = 'cancelado' WHERE status = 'aguardando_aprovacao'");
  q.run("UPDATE mkt_campaigns SET wa_code = NULL");
  q.run('UPDATE whatsapp_links SET pin_ok_until = NULL');
  const a = mk('Um'); const b = mk('Dois'); const c = mk('Três');
  await handleInbound(msg('APROVAR TUDO'), { reply });
  assert.match(replies.at(-1), /Vou aprovar 3 itens[\s\S]*Envie seu PIN/);
  await handleInbound(msg('4071'), { reply });
  assert.match(replies.at(-1), /✅ Aprovado\. 3 posts publicando agora[\s\S]*30 min/);
  for (const x of [a, b, c]) assert.equal(mkt.getItem(ctxA, x.it.id).status, 'na_fila');
  // dentro da janela: APROVAR código aprova sem pedir o PIN
  const d = mk('Quatro');
  await handleInbound(msg(`APROVAR ${d.code}`), { reply });
  assert.match(replies.at(-1), /✅ Aprovado\. publicando agora/);
  assert.doesNotMatch(replies.at(-1), /30 min/);
  // falhou no Instagram por falta de ajuste: avisa uma vez com o passo a passo; depois "APROVAR código" = tentar de novo
  q.run("UPDATE mkt_items SET networks = ? WHERE id = ?", JSON.stringify(['facebook', 'instagram']), d.it.id);
  writeResult(d.it.id, { concluido: false, redes: { facebook: { situacao: 'publicado', url: 'https://fb.com/1' }, instagram: { situacao: 'aguardando_ajuste', erro: 'Instagram aguardando ajuste (permissão): o acesso da Página não tem instagram_content_publish.' } } });
  const sent = []; const send = async (_to, t) => { sent.push(t); };
  await processMarketing({ send });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /esperando ajuste[\s\S]*✅ Facebook: https:\/\/fb\.com\/1[\s\S]*⏸️ Instagram[\s\S]*Como corrigir o Instagram[\s\S]*Casos de uso[\s\S]*instagram_content_publish/);
  await processMarketing({ send });
  assert.equal(sent.length, 1, 'aviso de ajuste só uma vez');
  writeResult(d.it.id, { concluido: true, redes: { facebook: { situacao: 'publicado', url: 'https://fb.com/1' }, instagram: { situacao: 'desistido', erro: 'Instagram aguardando ajuste (vínculo): a Página LORLER não tem Instagram profissional vinculado.' } } });
  await processMarketing({ send });
  assert.equal(mkt.getItem(ctxA, d.it.id).status, 'parcial');
  assert.match(sent.at(-1), /Publicado em parte[\s\S]*Editar perfil › \*Página\*[\s\S]*TENTAR DE NOVO/);
  await handleInbound(msg(`APROVAR ${d.code}`), { reply });
  assert.match(replies.at(-1), /🔁 Tentando de novo \*Quatro\* no Instagram/);
  const post = JSON.parse(fs.readFileSync(path.join(FILA, 'saida', `cerebro-${d.it.id}.json`), 'utf8'));
  assert.ok(post.tentar_de_novo && post.quando === post.tentar_de_novo);
  // resultado antigo (antes de o publicador reabrir) é ignorado: nada de aviso repetido
  const before = sent.length;
  await processMarketing({ send });
  assert.equal(sent.length, before);
  assert.equal(mkt.getItem(ctxA, d.it.id).status, 'na_fila');
  writeResult(d.it.id, { concluido: true, tentar_de_novo: post.tentar_de_novo, redes: { facebook: { situacao: 'publicado', url: 'https://fb.com/1' }, instagram: { situacao: 'publicado', url: 'https://instagram.com/p/9' } } });
  await processMarketing({ send });
  assert.equal(mkt.getItem(ctxA, d.it.id).status, 'publicado');
  assert.match(sent.at(-1), /📣 Publicado[\s\S]*instagram\.com\/p\/9/);
  assert.doesNotMatch(sent.at(-1), /TENTAR DE NOVO/);
  // TENTAR DE NOVO sem nada falhando
  await handleInbound(msg('tentar de novo'), { reply });
  assert.match(replies.at(-1), /Não há post com erro/);
});

test('publicador desatualizado: TENTAR DE NOVO sem resposta em 20 min vira erro com a instrução do .bat', () => {
  const ctxA = { orgId: orgA, userId: ownerId, role: 'owner', productIds: null };
  const it = mkt.createItem(ctxA, { kind: 'post', title: 'Velho', networks: ['facebook'], text: 'Olá', media_url: 'https://cdn.jsdelivr.net/gh/x/y.jpg', media_kind: 'imagem', scheduled_at: new Date(Date.now() + 86400000).toISOString() }, { source: 'teste' });
  mkt.submit(ctxA, { item_id: it.id }); mkt.approve(ctxA, { item_id: it.id, via: 'teste' });
  writeResult(it.id, { concluido: true, redes: { facebook: { situacao: 'desistido', erro: 'HTTP 500' } } });
  mkt.processResults();
  assert.equal(mkt.getItem(ctxA, it.id).status, 'erro');
  mkt.retry(ctxA, it.id);
  const old = new Date(Date.now() - 25 * 60_000).toISOString();
  q.run('UPDATE mkt_items SET result = ? WHERE id = ?', JSON.stringify({ ...mkt.getItem(ctxA, it.id).result, retry_at: old }), it.id);
  const ch = mkt.processResults();
  assert.ok(ch.some((x) => x.id === it.id));
  assert.match(mkt.getItem(ctxA, it.id).result.erro, /LIGAR-PUBLICADOR-CEREBRO/);
});

test('biblioteca de vídeos: lista com legendas, rodízio, post de vídeo (Reels + YouTube), link público com Range e fila com o arquivo local', async () => {
  const ctxA = { orgId: orgA, userId: ownerId, role: 'owner', productIds: null };
  for (const f of ['torven-1-os.mp4', 'torven-3-laudos.mp4', 'rusten-1-comanda.mp4']) fs.writeFileSync(path.join(VIDEOS, f), Buffer.alloc(4000, f.length));
  fs.writeFileSync(path.join(VIDEOS, '..evil.mp4.txt'), 'x');
  fs.writeFileSync(path.join(VIDEOS, 'mensagens-whatsapp.txt'), '━━ TORVEN\n\n[torven-3-laudos.mp4]\n📋 Laudo para a seguradora em minutos!\n👉 lorler.com.br\n\n[torven-1-os.mp4]\n🔧 OS do pedido à entrega.\n');
  const vids = mkt.listVideos(ctxA);
  assert.equal(vids.length, 3);
  const laudos = vids.find((v) => v.file === 'torven-3-laudos.mp4');
  assert.equal(laudos.sistema, 'TORVEN'); assert.equal(laudos.titulo, 'TORVEN: Laudos');
  assert.match(laudos.legenda, /^📋 Laudo para a seguradora em minutos!\n👉 lorler\.com\.br$/);
  assert.equal(mkt.pickVideo(ctxA, { sistema: 'TORVEN', termo: 'video dos laudos' }).file, 'torven-3-laudos.mp4');
  const it = mkt.createVideoPost(ctxA, laudos, { networks: ['instagram', 'facebook', 'youtube'] });
  assert.deepEqual(it.networks, ['instagram', 'facebook', 'youtube']);
  assert.equal(it.media_kind, 'video'); assert.equal(it.format, '9x16');
  assert.deepEqual(it.issues, []);
  assert.match(it.texts.youtube, /torven\.lorler\.com\.br/);
  assert.equal(mkt.pickVideo(ctxA, { sistema: 'TORVEN' }).file, 'torven-1-os.mp4', 'rodízio: o menos usado');
  // YouTube sem vídeo não passa
  const img = mkt.createItem(ctxA, { kind: 'post', title: 'Sem vídeo', networks: ['youtube'], text: 'x', media_url: 'https://cdn.jsdelivr.net/gh/x/y.jpg', media_kind: 'imagem', scheduled_at: new Date(Date.now() + 86400000).toISOString() }, { source: 'teste' });
  assert.ok(img.issues.some((x) => /YouTube: precisa de vídeo/.test(x)));
  // aprovado → fila com o caminho local do vídeo (o publicador lê do disco)
  mkt.submit(ctxA, { item_id: it.id }); mkt.approve(ctxA, { item_id: it.id, via: 'teste', publishNow: true });
  const post = JSON.parse(fs.readFileSync(path.join(FILA, 'saida', `cerebro-${it.id}.json`), 'utf8'));
  assert.equal(post.midia_arquivo, path.join(VIDEOS, 'torven-3-laudos.mp4'));
  assert.match(post.video_url, /\/api\/public\/video\/torven-3-laudos\.mp4$/);
  assert.deepEqual(post.redes, ['instagram', 'facebook', 'youtube']);
  // link público com Range (o player e a Meta usam)
  const b = await startServer();
  const full = await fetch(`${b}/api/public/video/torven-3-laudos.mp4`);
  assert.equal(full.status, 200); assert.equal(full.headers.get('content-type'), 'video/mp4'); assert.equal((await full.arrayBuffer()).byteLength, 4000);
  const part = await fetch(`${b}/api/public/video/torven-3-laudos.mp4`, { headers: { range: 'bytes=100-199' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 100-199/4000'); assert.equal((await part.arrayBuffer()).byteLength, 100);
  assert.equal((await fetch(`${b}/api/public/video/..%2Fx.mp4`)).status, 404);
  assert.equal((await fetch(`${b}/api/public/video/mensagens-whatsapp.txt`)).status, 404);
  // WhatsApp: VÍDEOS e "posta o vídeo do rusten"
  const replies = []; const reply = async (_to, t) => { replies.push(t); return 'ok'; };
  await handleInbound(msg('VÍDEOS'), { reply });
  assert.match(replies.at(-1), /3 vídeos prontos[\s\S]*RUSTEN: Comanda[\s\S]*TORVEN: Os, Laudos \(1x\)/);
  const owner = await import('../src/services/owner-actions.js');
  assert.deepEqual(owner.quickIntent('posta o vídeo do rusten'), { nome: 'postar_video', args: { sistema: 'RUSTEN' } });
  assert.deepEqual(owner.quickIntent('posta o video do torven laudos'), { nome: 'postar_video', args: { sistema: 'TORVEN', video: 'laudos' } });
  assert.equal(owner.quickIntent('como corrigir o instagram')?.nome, 'corrigir_instagram');
  assert.equal(owner.quickIntent('Como eu consigo corrigir')?.nome, 'corrigir_instagram');
  assert.equal(owner.quickIntent('tenta de novo')?.nome, 'tentar_de_novo');
  const r = await owner.perform({ ...ctxA, channel: 'whatsapp' }, 'postar_video', { sistema: 'RUSTEN' }, 'posta o vídeo do rusten');
  assert.match(r.reply, /🎬 Post com o vídeo \*RUSTEN: Comanda\* pronto[\s\S]*APROVAR M[A-Z0-9]{5}/);
});
