// Cofre de memória do JARVIS: notas em markdown, no estilo Obsidian, pessoais de cada usuário.
//   raw/      tudo capturado (conversas do dia, voz e WhatsApp)
//   wiki/     conhecimento refinado ("lembre que…", assuntos, pessoas, sistemas)
//   outputs/  o que o Cérebro entrega (resumo da manhã, métricas, tendências, relatórios)
//   diario/   um arquivo por dia (top 3, agenda, encerramento e reflexão)
// "Se não está no cofre, não aconteceu": a conversa consulta o cofre antes de responder e grava o que foi combinado.
// Tudo fica no banco do próprio servidor; exportar gera arquivos .md que o Obsidian abre como um cofre normal.
import zlib from 'node:zlib';
import { q, insert, uuid, now, json } from '../db.js';
import { errors, clampText } from '../lib/util.js';
import { SYSTEM_CODES } from '../seed.js';

export const FOLDERS = ['raw', 'wiki', 'outputs', 'diario'];
export const FOLDER_LABEL = { raw: 'tudo capturado', wiki: 'conhecimento refinado', outputs: 'tudo que o Cérebro entrega', diario: 'um arquivo por dia' };
const MAX_NOTE = 60_000;

export const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
export function slugify(s) {
  return fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'nota';
}
export function localDate(tz = 'America/Sao_Paulo', d = new Date()) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  return f.format(d);
}
export function localTime(tz = 'America/Sao_Paulo', d = new Date()) {
  return new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
const STOP = new Set('a o os as um uma uns umas de da do das dos e em no na nos nas por para pra pro com sem que se me te lhe eu voce voces ele ela isso isto esse essa este esta ja nao sim mais muito muita como qual quais quando onde sobre ao aos meu minha meus minhas seu sua seus suas tem ter ta to foi ser sao era e ou mas ate'.split(' '));
export const terms = (s) => [...new Set(fold(s).split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)))];

/** [[links]] e #tags do conteúdo (para o grafo e a busca). */
export function extractLinks(content) {
  return [...new Set([...String(content || '').matchAll(/\[\[([^\]|#\n]{1,80})(?:[|#][^\]\n]*)?\]\]/g)].map((m) => m[1].trim()))].slice(0, 80);
}
export function extractTags(content) {
  return [...new Set([...String(content || '').matchAll(/(?:^|\s)#([\p{L}0-9_-]{2,40})/gu)].map((m) => m[1].toLowerCase()))].slice(0, 30);
}
/** Liga automaticamente os nomes dos sistemas ([[ORBI]]) — é o que monta o grafo de conhecimento sozinho. */
export function autoLink(text) {
  let out = String(text || '');
  for (const code of SYSTEM_CODES) out = out.replace(new RegExp(`(?<!\\[\\[)\\b${code}\\b(?!\\]\\])`, 'gi'), `[[${code}]]`);
  return out;
}

const owner = (ctx) => ({ orgId: ctx.orgId, userId: ctx.userId });

export function getNote(ctx, folder, slug) {
  const { orgId, userId } = owner(ctx);
  return q.get('SELECT * FROM vault_notes WHERE organization_id = ? AND user_id = ? AND folder = ? AND slug = ?', orgId, userId, folder, slug) || null;
}

function shape(n, { full = true } = {}) {
  if (!n) return null;
  return { id: n.id, path: `${n.folder}/${n.slug}.md`, folder: n.folder, slug: n.slug, title: n.title, ...(full ? { content: n.content } : { excerpt: clampText(n.content.replace(/\s+/g, ' '), 180) }), tags: json(n.tags, []), links: json(n.links, []), source: n.source, created_at: n.created_at, updated_at: n.updated_at };
}

/** Cria ou substitui uma nota. */
export function writeNote(ctx, { folder, title, slug, content, source = 'conversa' }) {
  if (!FOLDERS.includes(folder)) throw errors.invalid('Pasta do cofre inválida.');
  const t = clampText(String(title || '').replace(/[\r\n]/g, ' ').trim(), 120) || 'Nota';
  const s = slugify(slug || t);
  const body = clampText(String(content ?? ''), MAX_NOTE);
  const ex = getNote(ctx, folder, s);
  const meta = { tags: JSON.stringify(extractTags(body)), links: JSON.stringify(extractLinks(body)) };
  if (ex) q.run('UPDATE vault_notes SET title = ?, content = ?, tags = ?, links = ?, source = ?, updated_at = ? WHERE id = ?', t, body, meta.tags, meta.links, source, now(), ex.id);
  else insert('vault_notes', { id: uuid(), organization_id: ctx.orgId, user_id: ctx.userId, folder, slug: s, title: t, content: body, ...meta, source, created_at: now(), updated_at: now() });
  return shape(getNote(ctx, folder, s));
}

/** Acrescenta texto embaixo de um título (## seção) da nota, criando nota e seção se faltar. */
export function appendTo(ctx, { folder, slug, title, heading = null, text, source = 'conversa', header = '' }) {
  const s = slugify(slug || title);
  const ex = getNote(ctx, folder, s);
  let content = ex ? ex.content : `# ${title}\n${header ? `\n${header}\n` : ''}`;
  const line = String(text || '').trim();
  if (!line) return shape(ex);
  if (heading) {
    const h = `## ${heading}`;
    const idx = content.indexOf(`\n${h}\n`);
    if (idx < 0) content = `${content.replace(/\s*$/, '')}\n\n${h}\n${line}\n`;
    else {
      const start = idx + h.length + 2;
      const next = content.indexOf('\n## ', start);
      const end = next < 0 ? content.length : next;
      content = `${content.slice(0, end).replace(/\s*$/, '')}\n${line}\n${content.slice(end)}`;
    }
  } else content = `${content.replace(/\s*$/, '')}\n${line}\n`;
  // nota cheia: guarda o começo e segue (o raw é o que cresce; ninguém perde o dia)
  if (content.length > MAX_NOTE) content = `${content.slice(0, 2000)}\n\n…\n\n${content.slice(-(MAX_NOTE - 4000))}`;
  return writeNote(ctx, { folder, title: ex?.title || title, slug: s, content, source });
}

export function listNotes(ctx, { folder = null, limit = 200 } = {}) {
  const { orgId, userId } = owner(ctx);
  const rows = folder
    ? q.all('SELECT * FROM vault_notes WHERE organization_id = ? AND user_id = ? AND folder = ? ORDER BY updated_at DESC LIMIT ?', orgId, userId, folder, limit)
    : q.all('SELECT * FROM vault_notes WHERE organization_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?', orgId, userId, limit);
  return rows.map((n) => shape(n, { full: false }));
}

export function deleteNote(ctx, folder, slug) {
  const n = getNote(ctx, folder, slug);
  if (!n) throw errors.notFound();
  q.run('DELETE FROM vault_notes WHERE id = ?', n.id);
  return { ok: true };
}

/** Busca simples por palavras (título pesa mais; notas recentes e da wiki sobem; o raw vale menos). */
export function search(ctx, text, { limit = 8, folders = FOLDERS } = {}) {
  const ts = terms(text);
  if (!ts.length) return [];
  const { orgId, userId } = owner(ctx);
  const rows = q.all('SELECT * FROM vault_notes WHERE organization_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 600', orgId, userId).filter((n) => folders.includes(n.folder));
  const W = { wiki: 1.6, diario: 1.2, outputs: 1, raw: 0.55 };
  const nowMs = Date.now();
  const scored = rows.map((n) => {
    const tt = fold(n.title); const cc = fold(n.content);
    let sc = 0; let hit = 0;
    for (const t of ts) {
      const inT = tt.includes(t); const c = cc.split(t).length - 1;
      if (inT || c) hit++;
      sc += (inT ? 3 : 0) + Math.min(c, 6);
    }
    if (!hit) return null;
    const ageDays = (nowMs - Date.parse(n.updated_at)) / 86400_000;
    sc = sc * (hit / ts.length) * (W[n.folder] || 1) * (1 + 0.5 / (1 + ageDays / 7));
    return { n, sc };
  }).filter(Boolean).sort((a, b) => b.sc - a.sc).slice(0, limit);
  return scored.map(({ n, sc }) => ({ ...shape(n, { full: false }), score: Math.round(sc * 10) / 10, snippet: snippet(n.content, ts) }));
}

function snippet(content, ts) {
  const lines = String(content).split('\n').filter((l) => l.trim() && !/^#\s/.test(l));
  const best = lines.map((l) => ({ l, s: ts.reduce((a, t) => a + (fold(l).includes(t) ? 1 : 0), 0) })).sort((a, b) => b.s - a.s).slice(0, 3).filter((x) => x.s).map((x) => x.l.trim());
  return clampText((best.length ? best : lines.slice(0, 2)).join(' · ').replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1'), 420);
}

/** O que o cofre lembra sobre a mensagem (vai para o contexto da IA como "memoria"). */
export function recall(ctx, text, limit = 4) {
  try {
    const found = search(ctx, text, { limit });
    const today = getNote(ctx, 'diario', localDate(ctx.timezone));
    const out = found.filter((f) => f.score >= 1.5).map((f) => ({ nota: f.path, titulo: f.title, trecho: f.snippet }));
    if (today && !out.some((o) => o.nota === `diario/${today.slug}.md`)) out.push({ nota: `diario/${today.slug}.md`, titulo: today.title, trecho: clampText(today.content.replace(/\s+/g, ' '), 500) });
    return out;
  } catch { return []; }
}

/** "lembre que …": vai para a wiki (memorias + nota do assunto) e para o diário do dia. */
export function remember(ctx, rawText, { source = 'conversa' } = {}) {
  const text = clampText(String(rawText || '').replace(/^\s*(que|de que|disso:?|isso:?)\s+/i, '').trim(), 1500);
  if (text.length < 3) throw errors.invalid('O que você quer que eu lembre?');
  const tz = ctx.timezone || 'America/Sao_Paulo'; const day = localDate(tz);
  const linked = autoLink(text);
  appendTo(ctx, { folder: 'wiki', slug: 'memorias', title: 'Memórias', text: `- ${day} — ${linked}`, source, header: 'Tudo que você me pediu para lembrar. Cada linha tem a data em que foi dita.' });
  const subj = /\b(?:sobre|do|da)\s+(?:o |a )?([A-ZÀ-Ú][\wÀ-ú]+(?:\s+[A-ZÀ-Ú][\wÀ-ú]+){0,2})/.exec(text)?.[1] || SYSTEM_CODES.find((c) => new RegExp(`\\b${c}\\b`, 'i').test(text));
  if (subj && slugify(subj) !== 'memorias') appendTo(ctx, { folder: 'wiki', slug: slugify(subj), title: subj.toUpperCase() === subj ? subj : subj.replace(/^\w/, (c) => c.toUpperCase()), heading: 'Anotações', text: `- ${day} — ${linked}`, source });
  appendTo(ctx, { folder: 'diario', slug: day, title: `Diário — ${day}`, heading: 'Anotado hoje', text: `- ${localTime(tz)} ${linked}`, source });
  return { saved: true, subject: subj || null, path: subj ? `wiki/${slugify(subj)}.md` : 'wiki/memorias.md' };
}

/** Registra cada volta da conversa no raw do dia (tudo capturado). */
export function logTurn(ctx, { channel = 'voz', user, reply }) {
  try {
    if (!ctx?.userId || !user) return;
    const tz = ctx.timezone || 'America/Sao_Paulo'; const day = localDate(tz);
    const ch = { voice: 'voz', text: 'texto', whatsapp: 'WhatsApp' }[channel] || channel;
    appendTo(ctx, { folder: 'raw', slug: `conversas-${day}`, title: `Conversas — ${day}`, text: `\n**${localTime(tz)} · ${ch}**\n> ${clampText(String(user).replace(/\n+/g, ' '), 600)}\n\n${clampText(String(reply || '').replace(/\n{3,}/g, '\n\n'), 1500)}`, source: channel });
  } catch (e) { console.warn(JSON.stringify({ level: 'warn', event: 'vault.log_failed', message: clampText(String(e.message), 160) })); }
}

export function stats(ctx) {
  const { orgId, userId } = owner(ctx);
  const rows = q.all('SELECT folder, COUNT(*) AS c, MAX(updated_at) AS last FROM vault_notes WHERE organization_id = ? AND user_id = ? GROUP BY folder', orgId, userId);
  const by = Object.fromEntries(FOLDERS.map((f) => [f, 0])); let last = null; let total = 0;
  for (const r of rows) { by[r.folder] = r.c; total += r.c; if (!last || r.last > last) last = r.last; }
  const size = q.get('SELECT COALESCE(SUM(LENGTH(content)), 0) AS s FROM vault_notes WHERE organization_id = ? AND user_id = ?', orgId, userId).s;
  return { total, by_folder: by, last_update: last, chars: size };
}

/** Grafo das notas (o "sistema Karpathy": tudo ligado por [[links]]). */
export function graph(ctx, { limit = 250 } = {}) {
  const { orgId, userId } = owner(ctx);
  const rows = q.all('SELECT folder, slug, title, links FROM vault_notes WHERE organization_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT ?', orgId, userId, limit);
  const byKey = new Map();
  for (const r of rows) { byKey.set(r.slug, `${r.folder}/${r.slug}`); byKey.set(slugify(r.title), `${r.folder}/${r.slug}`); }
  const nodes = rows.map((r) => ({ id: `${r.folder}/${r.slug}`, title: r.title, folder: r.folder }));
  const virtual = new Map(); const edges = [];
  for (const r of rows) {
    for (const l of json(r.links, [])) {
      const k = slugify(l); let to = byKey.get(k);
      if (!to) { to = `tag/${k}`; if (!virtual.has(to)) virtual.set(to, { id: to, title: l, folder: 'link' }); }
      edges.push({ from: `${r.folder}/${r.slug}`, to });
    }
  }
  return { nodes: [...nodes, ...virtual.values()].slice(0, limit + 60), edges: edges.slice(0, 1200) };
}

// ---------- exportar / importar (Obsidian) ----------
export function toMarkdown(n) {
  const fm = ['---', `titulo: ${JSON.stringify(n.title)}`, `pasta: ${n.folder}`, `criado: ${n.created_at}`, `atualizado: ${n.updated_at}`, `origem: ${n.source}`];
  const tags = json(n.tags, []); if (tags.length) fm.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  fm.push('---', '');
  return `${fm.join('\n')}${n.content}`;
}
export function exportFiles(ctx) {
  const { orgId, userId } = owner(ctx);
  const rows = q.all('SELECT * FROM vault_notes WHERE organization_id = ? AND user_id = ? ORDER BY folder, slug', orgId, userId);
  const files = rows.map((n) => ({ path: `${n.folder}/${n.slug}.md`, content: toMarkdown(n), updated_at: n.updated_at }));
  files.unshift({ path: 'LEIA-ME.md', content: `# Cofre do Cérebro LORLER\n\nAbra esta pasta no Obsidian (Abrir pasta como cofre).\n\n${FOLDERS.map((f) => `- **${f}/** — ${FOLDER_LABEL[f]}`).join('\n')}\n\nEditou uma nota aqui? Rode o SINCRONIZAR-COFRE.bat que ela volta para o Cérebro.\n`, updated_at: now() });
  return files;
}
function stripFrontmatter(s) { return String(s || '').replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''); }
/** Recebe notas editadas no Obsidian (só substitui quando a do arquivo é mais nova). */
export function importFiles(ctx, files) {
  if (!Array.isArray(files) || files.length > 500) throw errors.invalid('Envie até 500 notas por vez.');
  let created = 0; let updated = 0; let skipped = 0;
  for (const f of files) {
    const m = /^(raw|wiki|outputs|diario)\/([^/]{1,90})\.md$/i.exec(String(f?.path || '').replace(/\\/g, '/'));
    if (!m || typeof f.content !== 'string') { skipped++; continue; }
    const folder = m[1].toLowerCase(); const slug = slugify(m[2]);
    const body = stripFrontmatter(f.content).replace(/\r\n/g, '\n');
    const ex = getNote(ctx, folder, slug);
    if (ex && f.mtime && Date.parse(f.mtime) <= Date.parse(ex.updated_at)) { skipped++; continue; }
    if (ex && ex.content === body) { skipped++; continue; }
    const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || ex?.title || m[2];
    writeNote(ctx, { folder, slug, title, content: body, source: 'obsidian' });
    ex ? updated++ : created++;
  }
  return { created, updated, skipped };
}

// ZIP sem compressão (store): abre em qualquer Windows/Obsidian e não precisa de biblioteca.
const crc32 = zlib.crc32 || ((buf) => { let c; const t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let crc = 0xffffffff; for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; });
export function zip(files) {
  const parts = []; const central = []; let offset = 0;
  const dosTime = (d) => { const t = new Date(d || Date.now()); return { time: (t.getHours() << 11) | (t.getMinutes() << 5) | (t.getSeconds() >> 1), date: ((t.getFullYear() - 1980) << 9) | ((t.getMonth() + 1) << 5) | t.getDate() }; };
  for (const f of files) {
    const name = Buffer.from(`Cofre-Cerebro/${f.path}`, 'utf8'); const data = Buffer.from(f.content, 'utf8'); const crc = crc32(data); const { time, date } = dosTime(f.updated_at);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
