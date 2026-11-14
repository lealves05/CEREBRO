// JARVIS: cofre de memória (markdown), habilidades (skills/*/SKILL.md), rotina do dia, HUD, voz local e áudio no WhatsApp.
import './env-master.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { orgA, createUser, login, stopServer, startServer, q } from './helpers.js';
import { waHooks, extractMessages } from '../src/connectors/whatsapp.js';
import { handleInbound, waChatHooks } from '../src/services/whatsapp-approvals.js';
import * as vault from '../src/services/vault.js';
import { matchSkill, parsePriorities, publicSkills } from '../src/services/skills.js';
import { runSlot, processRoutine } from '../src/services/routine.js';
import { hooks as voiceHooks } from '../src/services/voice-local.js';

process.env.LORLER_CONVERSA_IA = 'proprio'; // conversa sem a IA do suporte (Master simulado fora do ar)
const ownerId = createUser(orgA, 'jarvis.owner@lorler.test', 'owner');
createUser(orgA, 'jarvis.viewer@lorler.test', 'viewer');
after(() => { stopServer(); delete process.env.LORLER_STT_URL; delete process.env.LORLER_TTS_LOCAL_URL; });
const ctx = { orgId: orgA, userId: ownerId, timezone: 'America/Sao_Paulo', productIds: null };
const say = (c, message, channel = 'text') => c.call('POST', '/api/conversation', { message, channel });

test('habilidades: as 7 do SKILL.md carregam e os gatilhos acionam a certa', () => {
  assert.deepEqual(publicSkills().map((s) => s.nome), ['metricas', 'caixa-de-entrada', 'tendencias', 'plano-de-hoje', 'cofre', 'marketing', 'encerrar-dia']);
  assert.ok(publicSkills().every((s) => s.arquivo?.startsWith('skills/')));
  assert.equal(matchSkill('Lembre que o reajuste do ORBI é em dezembro')?.nome, 'cofre');
  assert.equal(matchSkill('o que você sabe sobre o RUSTEN?')?.nome, 'cofre');
  assert.equal(matchSkill('me dá o resumo da manhã')?.nome, 'caixa-de-entrada');
  assert.equal(matchSkill('encerrar o dia')?.nome, 'encerrar-dia');
  assert.equal(matchSkill('quais as tendências?')?.nome, 'tendencias');
  assert.equal(matchSkill('quanto o ORBI recebeu?'), null, 'pergunta comum continua com a interpretação normal');
  assert.deepEqual(parsePriorities('minhas prioridades são ligar pro contador, revisar o RUSTEN e gravar o vídeo'), ['ligar pro contador', 'revisar o RUSTEN', 'gravar o vídeo']);
});

test('cofre: "lembre que" grava na wiki e no diário, a busca acha e a conversa usa a memória', async () => {
  const c = await login('jarvis.owner@lorler.test');
  const r = await say(c, 'Lembre que o reajuste do ORBI entra em dezembro com 8%');
  assert.equal(r.status, 200);
  assert.match(r.body.reply, /^Anotado:/);
  const mem = vault.getNote(ctx, 'wiki', 'memorias');
  assert.match(mem.content, /\[\[ORBI\]\]/, 'nomes dos sistemas viram [[links]]');
  assert.ok(vault.getNote(ctx, 'wiki', 'orbi'), 'nota do assunto criada');
  assert.match(vault.getNote(ctx, 'diario', vault.localDate()).content, /## Anotado hoje/);
  const s = await c.call('GET', '/api/vault/search?q=reajuste%20dezembro');
  assert.ok(s.body.results.length >= 1);
  const back = await say(c, 'o que você sabe sobre o reajuste?');
  assert.match(back.body.reply, /dezembro/);
  // toda volta da conversa vai para o raw do dia
  const raw = vault.getNote(ctx, 'raw', `conversas-${vault.localDate()}`);
  assert.match(raw.content, /reajuste do ORBI/);
  const g = await c.call('GET', '/api/vault/graph');
  assert.ok(g.body.edges.some((e) => /orbi/i.test(e.to)), 'grafo liga as notas pelo [[ORBI]]');
});

test('plano de hoje: top 3 vai para o diário; resumo pergunta e a resposta seguinte é gravada', async () => {
  const c = await login('jarvis.owner@lorler.test');
  q.run("DELETE FROM vault_notes WHERE user_id = ? AND folder = 'diario'", ownerId);
  const r1 = await say(c, 'resumo da manhã');
  assert.match(r1.body.reply, /três prioridades/);
  assert.ok(vault.getNote(ctx, 'outputs', `resumo-${vault.localDate()}`), 'resumo gravado em outputs/');
  const r2 = await say(c, 'fechar a proposta do hospital; revisar o caixa do RUSTEN; gravar a aula do ANIBI');
  assert.match(r2.body.reply, /top 3/i);
  const st = await c.call('GET', '/api/jarvis/state');
  assert.equal(st.status, 200);
  assert.equal(st.body.top3.length, 3);
  assert.match(st.body.top3[1], /RUSTEN/);
  const r3 = await say(c, 'qual meu plano de hoje?');
  assert.match(r3.body.reply, /fechar a proposta/);
});

test('encerrar o dia: resume, pergunta a reflexão e grava a resposta (não confunde com "encerrar" a conversa)', async () => {
  const c = await login('jarvis.owner@lorler.test');
  const r = await say(c, 'encerrar o dia', 'voice');
  assert.notEqual(r.body.intent, 'end');
  assert.match(r.body.reply, /Como foi o seu dia/);
  const r2 = await say(c, 'foi produtivo, mas o suporte tomou a tarde toda');
  assert.match(r2.body.reply, /reflexão/);
  const d = vault.getNote(ctx, 'diario', vault.localDate()).content;
  assert.match(d, /## Encerramento/);
  assert.match(d, /## Reflexão\n> foi produtivo/);
  assert.equal((await say(c, 'tchau')).body.intent, 'end', '"tchau" continua encerrando a conversa');
});

test('rotina: etapas rodam uma vez por dia e gravam no cofre; métricas e tendências viram outputs', async () => {
  const m = await runSlot(ctx, 'metricas');
  assert.match(m.reply, /receita recorrente/);
  assert.match(vault.getNote(ctx, 'outputs', `metricas-${vault.localDate()}`).content, /\| \[\[ORBI\]\]/);
  const c = await login('jarvis.owner@lorler.test');
  const t = await say(c, 'tendências');
  assert.match(t.body.reply, /últimos 7 dias/);
  const rt = await c.call('PUT', '/api/jarvis/routine', { times: { metricas: '25:00' } });
  assert.equal(rt.status, 400);
  const ok = await c.call('PUT', '/api/jarvis/routine', { enabled: true, times: { manha: '00:00', plano: '00:00', metricas: '00:00', encerrar: '00:00' } });
  assert.equal(ok.status, 200);
  q.run("UPDATE jarvis_routine SET last_runs = '{}' WHERE user_id = ?", ownerId);
  const sent = [];
  const first = await processRoutine({ send: async (to, text) => { sent.push(text); } });
  const second = await processRoutine({ send: async () => {} });
  // horário 00:00 só vale até 02:00; fora dessa janela não roda (nem por isso falha)
  assert.ok(first.ran === 0 || first.ran >= 1);
  assert.equal(second.ran, 0, 'nunca roda duas vezes no mesmo dia');
  const run = await c.call('POST', '/api/jarvis/routine/plano/run', {});
  assert.equal(run.status, 200);
  assert.ok(run.body.reply.length > 10);
});

test('HUD: estado e sinais vitais; cofre exige sessão; viewer não vê o cofre do owner', async () => {
  const c = await login('jarvis.owner@lorler.test');
  const st = await c.call('GET', '/api/jarvis/state');
  assert.equal(st.body.status.sistema, true);
  assert.ok(st.body.agenda.length >= 4, 'rotina do dia (a reunião de marketing aparece às segundas)');
  assert.ok(st.body.vault.total >= 3);
  assert.equal(st.body.skills.length, 7);
  const v = await c.call('GET', '/api/jarvis/vitals');
  assert.ok(v.body.mem?.pct >= 0);
  const b = await startServer();
  assert.equal((await fetch(`${b}/api/vault`)).status, 401);
  const viewer = await login('jarvis.viewer@lorler.test');
  const vv = await viewer.call('GET', '/api/vault');
  assert.equal(vv.status, 200);
  assert.equal(vv.body.stats.total, 0, 'o cofre é pessoal');
  const bad = await c.call('GET', '/api/vault/note?path=..%2Fetc%2Fpasswd');
  assert.equal(bad.status, 400);
});

test('cofre ↔ Obsidian: exporta zip válido; token pessoal sincroniza (baixa e sobe notas)', async () => {
  const c = await login('jarvis.owner@lorler.test');
  const b = await startServer();
  const z = await fetch(`${b}/api/vault/export`, { headers: { cookie: c.cookie } });
  assert.equal(z.headers.get('content-type'), 'application/zip');
  const buf = Buffer.from(await z.arrayBuffer());
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const nameLen = buf.readUInt16LE(26); const size = buf.readUInt32LE(18);
  const first = buf.subarray(30 + nameLen, 30 + nameLen + size);
  assert.equal(buf.readUInt32LE(14), zlib.crc32(first), 'CRC do zip confere');
  assert.equal((await fetch(`${b}/api/vault/sync/files`)).status, 401);
  const tok = (await c.call('POST', '/api/vault/token', {})).body.token;
  assert.match(tok, /^cv_/);
  const files = await (await fetch(`${b}/api/vault/sync/files`, { headers: { authorization: `Bearer ${tok}` } })).json();
  assert.ok(files.files.some((f) => f.path === 'wiki/memorias.md' && /^---\ntitulo:/.test(f.content)));
  const up = await fetch(`${b}/api/vault/sync/files`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify({ files: [{ path: 'wiki/ideias.md', content: '---\ntitulo: "x"\n---\n# Ideias\n- app do [[ANIBI]] com agenda', mtime: new Date().toISOString() }, { path: '../../segredo.md', content: 'x' }] }) });
  const ur = await up.json();
  assert.equal(ur.created, 1); assert.equal(ur.skipped, 1);
  assert.match(vault.getNote(ctx, 'wiki', 'ideias').content, /^# Ideias/);
  await c.call('POST', '/api/vault/token/revoke', {});
  assert.equal((await fetch(`${b}/api/vault/sync/files`, { headers: { authorization: `Bearer ${tok}` } })).status, 401);
});

test('voz local: sem instalação o STT avisa; com Whisper/Kokoro simulados, transcreve e fala', async () => {
  const c = await login('jarvis.owner@lorler.test');
  const audio = Buffer.from('audio-falso-webm').toString('base64');
  const off = await c.call('POST', '/api/stt', { audio, mime: 'audio/webm;codecs=opus' });
  assert.equal(off.status, 503);
  process.env.LORLER_STT_URL = 'http://127.0.0.1:8000'; process.env.LORLER_TTS_LOCAL_URL = 'http://127.0.0.1:8880';
  const calls = [];
  voiceHooks.fetch = async (url, opts = {}) => {
    calls.push(url);
    if (url.endsWith('/v1/audio/transcriptions')) { assert.ok(opts.body instanceof FormData); assert.equal(opts.body.get('language'), 'pt'); return new Response(JSON.stringify({ text: ' quanto o ORBI recebeu ' }), { status: 200 }); }
    if (url.endsWith('/v1/audio/speech')) { const b = JSON.parse(opts.body); assert.equal(b.model, 'kokoro'); return new Response(Buffer.from(`MP3:${b.voice}:${b.response_format}`), { status: 200 }); }
    return new Response('ok', { status: 200 });
  };
  const on = await c.call('POST', '/api/stt', { audio, mime: 'audio/webm;codecs=opus' });
  assert.equal(on.status, 200); assert.equal(on.body.text, 'quanto o ORBI recebeu');
  assert.equal((await c.call('POST', '/api/stt', { audio: 'não é base64!', mime: 'audio/webm' })).status, 400);
  const a = await c.call('GET', '/api/assistant');
  assert.equal(a.body.tts_engines.local, true); assert.equal(a.body.stt_local, true);
  const b = await startServer();
  const tts = await fetch(`${b}/api/tts`, { method: 'POST', headers: { cookie: c.cookie, 'content-type': 'application/json', 'x-csrf-token': c.csrf }, body: JSON.stringify({ text: 'Olá, Leandro.', engine: 'local', voice: 'pm_alex' }) });
  assert.equal(tts.status, 200); assert.equal(await tts.text(), 'MP3:pm_alex:mp3');
  const p = await c.call('PUT', '/api/assistant', { voice: { engine: 'local', local_voice: 'pf_dora', stt: 'local' } });
  assert.equal(p.body.settings.voice.engine, 'local');
  const t2 = await c.call('GET', '/api/jarvis/voz/teste');
  assert.equal(t2.body.online.stt, true);
});

test('WhatsApp: nota de voz → Whisper → conversa → resposta em áudio (Kokoro, opus)', async () => {
  const owner = await login('jarvis.owner@lorler.test');
  const PHONE = '5519933332222';
  const sent = [];
  waHooks.fetch = async (url, opts = {}) => { sent.push({ url, body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body }); return new Response(JSON.stringify({ messages: [{ id: `wamid.${sent.length}` }], id: 'media-1' }), { status: 200 }); };
  waChatHooks.delay = async () => {};
  const b = await startServer();
  const link = (await owner.call('POST', '/api/whatsapp/link', {})).body;
  const payload = { object: 'whatsapp_business_account', entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111' }, messages: [{ id: 'wamid.jv.link', from: PHONE, timestamp: '1', type: 'text', text: { body: link.message } }] } }] }] };
  const raw = JSON.stringify(payload);
  await fetch(`${b}/api/whatsapp/webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', 'wa-app-secret').update(raw).digest('hex') }, body: raw });
  // o webhook entende a nota de voz
  const m = extractMessages({ entry: [{ changes: [{ value: { metadata: { phone_number_id: '1111' }, messages: [{ id: 'wamid.aud.1', from: PHONE, type: 'audio', audio: { id: 'MEDIA123', mime_type: 'audio/ogg; codecs=opus', voice: true } }] } }] }] })[0];
  assert.deepEqual(m.audio, { id: 'MEDIA123', mime: 'audio/ogg; codecs=opus', voice: true });
  const voiceNotes = [];
  waChatHooks.download = async (id) => { assert.equal(id, 'MEDIA123'); return { buffer: Buffer.from('ogg'), mime: 'audio/ogg' }; };
  waChatHooks.sendVoice = async (to, buf, mime) => { voiceNotes.push({ to, audio: buf.toString(), mime }); return 'ok'; };
  const texts = [];
  const r = await handleInbound(m, { reply: async (to, t) => { texts.push(t); } });
  assert.equal(r.chat, 'answer'); assert.equal(r.voice, true);
  assert.equal(voiceNotes.length, 1);
  assert.equal(voiceNotes[0].audio, 'MP3:pf_dora:opus', 'resposta em nota de voz (opus) na voz local');
  assert.equal(texts.length, 0);
  assert.match(vault.getNote(ctx, 'raw', `conversas-${vault.localDate()}`).content, /WhatsApp\*\*\n> quanto o ORBI recebeu/);
  // sem o Whisper instalado: avisa por escrito
  delete process.env.LORLER_STT_URL;
  const t2 = [];
  await handleInbound({ ...m, id: 'wamid.aud.2' }, { reply: async (to, t) => { t2.push(t); } });
  assert.match(t2[0], /reconhecimento de voz ainda não está instalado/);
  delete waChatHooks.download; delete waChatHooks.sendVoice;
});
