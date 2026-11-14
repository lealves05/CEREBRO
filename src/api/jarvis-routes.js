// Rotas do JARVIS: HUD (estado e sinais vitais), cofre de memória, rotina do dia, habilidades e voz local.
import path from 'node:path';
import { q, now } from '../db.js';
import { config } from '../config.js';
import { errors, clampText, sha256, randomToken } from '../lib/util.js';
import { requirePerm } from '../auth/authz.js';
import { audit } from '../services/audit.js';
import * as vault from '../services/vault.js';
import * as routine from '../services/routine.js';
import { publicSkills, readTop3, loadSkills } from '../services/skills.js';
import { vitals } from '../services/vitals.js';
import * as voiceLocal from '../services/voice-local.js';
import * as assistant from '../services/assistant.js';
import * as wa from '../connectors/whatsapp.js';
import { isConfigured as masterConfigured } from '../connectors/master.js';
import { getProvider } from '../ai/provider.js';

const tzOf = (ctx) => q.get('SELECT timezone FROM organizations WHERE id = ?', ctx.orgId)?.timezone || 'America/Sao_Paulo';
const withTz = (ctx) => ({ ...ctx, timezone: tzOf(ctx) });
const dataDir = () => (config.dbFile && config.dbFile !== ':memory:' ? path.dirname(config.dbFile) : '/');
const sttHits = new Map();

function parsePath(p) {
  const m = /^(raw|wiki|outputs|diario)\/([^/]{1,90}?)(?:\.md)?$/i.exec(String(p || '').replace(/\\/g, '/'));
  if (!m) throw errors.invalid('Caminho de nota inválido (use pasta/nome.md).');
  return { folder: m[1].toLowerCase(), slug: vault.slugify(m[2]) };
}

// Token pessoal do cofre (para o SINCRONIZAR-COFRE.bat no PC, que espelha o cofre numa pasta do Obsidian).
function vaultCtxFromToken(req) {
  const h = String(req.headers.authorization || '');
  const tok = /^Bearer\s+(cv_[A-Za-z0-9_-]{20,80})$/.exec(h)?.[1];
  if (!tok) throw errors.unauth();
  const row = q.get('SELECT user_id, organization_id FROM jarvis_routine WHERE vault_token_hash = ?', sha256(tok));
  if (!row) throw errors.unauth();
  const m = q.get("SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'", row.organization_id, row.user_id);
  if (!m) throw errors.unauth();
  return { userId: row.user_id, orgId: row.organization_id, timezone: q.get('SELECT timezone FROM organizations WHERE id = ?', row.organization_id)?.timezone || 'America/Sao_Paulo' };
}

export function registerJarvisRoutes(router) {
  // ---------- HUD ----------
  router.get('/api/jarvis/vitals', ({ ctx }) => { requirePerm(ctx, 'view'); return vitals(dataDir()); });

  router.get('/api/jarvis/state', async ({ ctx }) => {
    requirePerm(ctx, 'view');
    const c = withTz(ctx);
    const s = assistant.getSettings(ctx.orgId);
    const link = q.get("SELECT id, briefing, briefing_time FROM whatsapp_links WHERE user_id = ? AND organization_id = ? AND status = 'verified' AND wa_id IS NOT NULL", ctx.userId, ctx.orgId);
    const pending = q.get("SELECT COUNT(*) AS c FROM action_proposals WHERE organization_id = ? AND status = 'awaiting_approval'", ctx.orgId).c;
    return {
      now: new Date().toISOString(), timezone: c.timezone,
      vitals: vitals(dataDir()),
      vault: { ...vault.stats(c), folders: vault.FOLDER_LABEL, recent: vault.listNotes(c, { limit: 8 }) },
      top3: readTop3(c), agenda: routine.agendaToday(c, c.timezone), routine: routine.publicRoutine(c),
      skills: publicSkills(), pending,
      status: {
        sistema: true, ia: getProvider().name, master: masterConfigured(), whatsapp: wa.isConfigured(), whatsapp_vinculado: !!link,
        ...voiceLocal.status(), tts_engine: s.voice.engine, stt_engine: s.voice.stt,
        tts_online: s.voice.engine === 'browser' || (s.voice.engine === 'local' ? voiceLocal.ttsConfigured() : true),
        acesso_seguro: !!config.cookieSecure, env: config.env,
      },
    };
  });

  router.get('/api/jarvis/voz/teste', async ({ ctx }) => { requirePerm(ctx, 'view'); return { ...voiceLocal.status(), online: await voiceLocal.probe() }; });

  // ---------- habilidades ----------
  router.get('/api/jarvis/skills', ({ ctx }) => { requirePerm(ctx, 'view'); return { skills: loadSkills({ force: true }).map((x) => ({ nome: x.nome, titulo: x.titulo, descricao: x.descricao, gatilhos: x.gatilhos, instrucoes: x.instrucoes, arquivo: x.arquivo })) }; });

  // ---------- rotina ----------
  router.get('/api/jarvis/routine', ({ ctx }) => { requirePerm(ctx, 'view'); const c = withTz(ctx); return { ...routine.publicRoutine(c), agenda: routine.agendaToday(c, c.timezone), labels: routine.SLOT_LABEL }; });
  router.put('/api/jarvis/routine', ({ ctx, body }) => { requirePerm(ctx, 'view'); return routine.setRoutine(withTz(ctx), body || {}); });
  router.post('/api/jarvis/routine/:slot/run', async ({ ctx, params }) => {
    requirePerm(ctx, 'view');
    if (!routine.SLOTS.includes(params.slot)) throw errors.invalid('Etapa inválida.');
    const r = await routine.runSlot(withTz(ctx), params.slot);
    return { slot: r.slot, reply: r.reply, note: r.note || null };
  });

  // ---------- cofre ----------
  router.get('/api/vault', ({ ctx, url }) => {
    requirePerm(ctx, 'view');
    const folder = url.searchParams.get('folder');
    if (folder && !vault.FOLDERS.includes(folder)) throw errors.invalid('Pasta inválida.');
    const c = withTz(ctx);
    return { folders: vault.FOLDER_LABEL, stats: vault.stats(c), notes: vault.listNotes(c, { folder, limit: 300 }) };
  });
  router.get('/api/vault/note', ({ ctx, url }) => {
    requirePerm(ctx, 'view');
    const { folder, slug } = parsePath(url.searchParams.get('path'));
    const n = vault.getNote(ctx, folder, slug);
    if (!n) throw errors.notFound();
    return { path: `${folder}/${slug}.md`, folder, slug, title: n.title, content: n.content, updated_at: n.updated_at, source: n.source };
  });
  router.put('/api/vault/note', ({ ctx, body }) => {
    requirePerm(ctx, 'view');
    const { folder, slug } = parsePath(body?.path);
    return vault.writeNote(ctx, { folder, slug, title: body?.title || slug, content: String(body?.content ?? ''), source: 'painel' });
  }, { bigBody: true });
  router.post('/api/vault/note/delete', ({ ctx, body }) => { requirePerm(ctx, 'view'); const { folder, slug } = parsePath(body?.path); return vault.deleteNote(ctx, folder, slug); });
  router.post('/api/vault/remember', ({ ctx, body }) => { requirePerm(ctx, 'view'); return vault.remember(withTz(ctx), String(body?.text || ''), { source: 'painel' }); });
  router.get('/api/vault/search', ({ ctx, url }) => { requirePerm(ctx, 'view'); return { results: vault.search(ctx, clampText(String(url.searchParams.get('q') || ''), 200), { limit: 20 }) }; });
  router.get('/api/vault/graph', ({ ctx }) => { requirePerm(ctx, 'view'); return vault.graph(ctx); });
  router.get('/api/vault/export', ({ ctx, res }) => {
    requirePerm(ctx, 'view');
    const buf = vault.zip(vault.exportFiles(ctx));
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="Cofre-Cerebro-${new Date().toISOString().slice(0, 10)}.zip"`, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
    return null;
  });
  // token do cofre para sincronizar com o Obsidian no PC (mostrado uma única vez)
  router.post('/api/vault/token', ({ ctx, requestId }) => {
    requirePerm(ctx, 'view');
    routine.getRoutine(ctx);
    const tok = `cv_${randomToken(24)}`;
    q.run('UPDATE jarvis_routine SET vault_token_hash = ? WHERE user_id = ?', sha256(tok), ctx.userId);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'vault.token_created', requestId });
    return { token: tok };
  });
  router.post('/api/vault/token/revoke', ({ ctx }) => { requirePerm(ctx, 'view'); q.run('UPDATE jarvis_routine SET vault_token_hash = NULL WHERE user_id = ?', ctx.userId); return { ok: true }; });
  router.get('/api/vault/sync/files', ({ req }) => { const c = vaultCtxFromToken(req); return { files: vault.exportFiles(c), server_time: now() }; }, { public: true });
  router.post('/api/vault/sync/files', ({ req, body }) => { const c = vaultCtxFromToken(req); return vault.importFiles(c, body?.files); }, { public: true, bigBody: true, noCsrf: true });

  // ---------- voz local ----------
  // Áudio do microfone (base64) → texto pelo Whisper da VPS. O áudio não é guardado.
  router.post('/api/stt', async ({ ctx, body }) => {
    requirePerm(ctx, 'view');
    const t = Date.now(); const hits = (sttHits.get(ctx.userId) || []).filter((x) => t - x < 60_000);
    if (hits.length >= 40) throw errors.limit('Muitas falas em pouco tempo. Aguarde alguns segundos.');
    hits.push(t); sttHits.set(ctx.userId, hits);
    if (!voiceLocal.sttConfigured()) throw errors.unavailable('O reconhecimento de voz local ainda não foi instalado na VPS (VPS-MENU › I).');
    const b64 = String(body?.audio || '');
    if (!b64 || b64.length > 1_350_000 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw errors.invalid('Áudio inválido ou longo demais (até ~60 s).');
    const mime = /^audio\/[a-z0-9.+-]+(;\s*codecs=[a-z0-9.,"-]+)?$/i.test(String(body?.mime || '')) ? body.mime : 'audio/webm';
    try { return { text: await voiceLocal.transcribe(Buffer.from(b64, 'base64'), mime) }; }
    catch (e) { throw errors.unavailable(e.message); }
  }, { bigBody: true });
}

/** Voz local para a rota /api/tts (motor "local"). */
export async function localTts(s, body) {
  const voice = Object.hasOwn(assistant.LOCAL_VOICES, body?.voice) ? body.voice : s.voice.local_voice;
  try { return await voiceLocal.synthesize(String(body.text), { voice, speed: Number(body?.rate) || s.voice.rate || 1, format: 'mp3' }); }
  catch (e) { throw errors.unavailable(e.message); }
}
