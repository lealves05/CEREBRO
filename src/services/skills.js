// Habilidades do Cérebro (JARVIS): cada uma é uma pasta skills/<nome>/SKILL.md (gatilhos + jeito de responder) e um
// executor aqui embaixo (cálculo e gravação no cofre). Só é acionada quando a frase bate com um gatilho.
// O executor sempre devolve números calculados — a IA só reescreve com naturalidade (vão como "dados_prontos").
import fs from 'node:fs';
import path from 'node:path';
import { q } from '../db.js';
import { ROOT } from '../config.js';
import { clampText } from '../lib/util.js';
import { buildAnalytics } from './analytics.js';
import { buildBriefing } from './briefing.js';
import * as vault from './vault.js';
import { setAwaiting, getRoutine } from './routine.js';

const fold = vault.fold;
const money = (v) => (v == null ? 'sem dado' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
const pct = (v) => `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`;
const plural = (n, um, varios) => `${Number(n).toLocaleString('pt-BR')} ${Number(n) === 1 ? um : varios}`;
const listPt = (arr) => (arr.length <= 1 ? arr.join('') : `${arr.slice(0, -1).join(', ')} e ${arr[arr.length - 1]}`);

// Definições embutidas (valem se a pasta skills/ não estiver disponível, ex.: no Worker da Cloudflare).
const BUILTIN = [
  { nome: 'metricas', titulo: 'Métricas', descricao: 'Mostra seus números.', gatilhos: ['\\b(metricas|meus numeros|os numeros|kpis?|indicadores)\\b'] },
  { nome: 'caixa-de-entrada', titulo: 'Caixa de entrada', descricao: 'O resumo da manhã.', gatilhos: ['\\b(resumo da manha|resumo do dia|caixa de entrada|briefing)\\b'] },
  { nome: 'tendencias', titulo: 'Tendências', descricao: 'Analisa o que está mudando.', gatilhos: ['\\b(tendencias?|o que (esta|ta) mudando)\\b'] },
  { nome: 'plano-de-hoje', titulo: 'Plano de hoje', descricao: 'Escreve seu top 3.', gatilhos: ['\\b(plano de hoje|top ?3|minhas prioridades)\\b'] },
  { nome: 'cofre', titulo: 'Cofre (memória)', descricao: 'Lê e escreve memória.', gatilhos: ['^(lembr[ae](-se)?|anot[ae]|guard[ae])\\b', '\\bo que (voce )?(sabe|lembra) (sobre|de|do|da)\\b'] },
  { nome: 'encerrar-dia', titulo: 'Encerrar o dia', descricao: 'Fecha o dia e registra a reflexão.', gatilhos: ['\\b(encerrar o dia|fechar o dia|fim do dia)\\b', '^reflexao[:\\s]'] },
];
export const SKILLS_DIR = process.env.LORLER_SKILLS_DIR || path.join(ROOT || '.', 'skills');

function parseSkill(md) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(md);
  if (!m) return null;
  const out = { gatilhos: [] }; let inList = null;
  for (const line of m[1].split(/\r?\n/)) {
    const li = /^\s+-\s+(.*)$/.exec(line);
    if (li && inList) { out[inList].push(li[1].trim()); continue; }
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[2] === '') { inList = kv[1]; out[kv[1]] = []; } else { inList = null; out[kv[1]] = kv[2].trim(); }
  }
  out.instrucoes = m[2].trim();
  return out.nome ? out : null;
}

let cache = { at: 0, list: null };
export function loadSkills({ force = false } = {}) {
  if (!force && cache.list && Date.now() - cache.at < 60_000) return cache.list;
  let list = [];
  try {
    for (const d of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(SKILLS_DIR, d.name, 'SKILL.md');
      if (!fs.existsSync(f)) continue;
      const s = parseSkill(fs.readFileSync(f, 'utf8'));
      if (s && HANDLERS[s.nome]) list.push({ ...s, arquivo: `skills/${d.name}/SKILL.md` });
    }
  } catch { list = []; }
  if (!list.length) list = BUILTIN.map((s) => ({ ...s, instrucoes: '', arquivo: null }));
  for (const s of list) s.regex = s.gatilhos.map((g) => { try { return new RegExp(g, 'i'); } catch { return null; } }).filter(Boolean);
  const order = BUILTIN.map((b) => b.nome);
  list.sort((a, b) => order.indexOf(a.nome) - order.indexOf(b.nome));
  cache = { at: Date.now(), list };
  return list;
}

export function publicSkills() {
  return loadSkills().map((s) => ({ nome: s.nome, titulo: s.titulo || s.nome, descricao: s.descricao || '', gatilhos: s.gatilhos, arquivo: s.arquivo }));
}

export function matchSkill(text) {
  const f = fold(text).trim();
  return loadSkills().find((s) => s.regex.some((r) => r.test(f))) || null;
}

function scoped(ctx) {
  return q.all("SELECT id, code, name, description FROM products WHERE organization_id = ? AND status = 'active' ORDER BY code", ctx.orgId).filter((p) => !ctx.productIds || ctx.productIds.has(p.id));
}
const tzOf = (ctx) => ctx.timezone || 'America/Sao_Paulo';
const today = (ctx) => vault.localDate(tzOf(ctx));
const diaryTitle = (d) => `Diário — ${d}`;

/** Lê o "## Top 3" do diário de hoje (ou null). */
export function readTop3(ctx, day = today(ctx)) {
  const n = vault.getNote(ctx, 'diario', day);
  if (!n) return null;
  const m = /\n## Top 3\n([\s\S]*?)(?=\n## |$)/.exec(`\n${n.content}`);
  if (!m) return null;
  const items = m[1].split('\n').map((l) => l.replace(/^\s*(?:\d+[.)]|[-*])\s*(\[[ x]\]\s*)?/i, '').replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '$1').trim()).filter(Boolean);
  return items.length ? items.slice(0, 3) : null;
}

export function saveTop3(ctx, items, { source = 'conversa' } = {}) {
  const day = today(ctx);
  const n = vault.getNote(ctx, 'diario', day);
  const block = `## Top 3\n${items.slice(0, 3).map((x, i) => `${i + 1}. [ ] ${vault.autoLink(clampText(x, 200))}`).join('\n')}\n`;
  let content = n ? n.content : `# ${diaryTitle(day)}\n`;
  if (/\n## Top 3\n/.test(`\n${content}`)) content = `\n${content}`.replace(/\n## Top 3\n[\s\S]*?(?=\n## |$)/, `\n${block}`).replace(/^\n/, '');
  else content = `${content.replace(/\s*$/, '')}\n\n${block}`;
  return vault.writeNote(ctx, { folder: 'diario', slug: day, title: diaryTitle(day), content, source });
}

/** "minhas prioridades são A, B e C" / "1. A 2. B 3. C" → [A, B, C] */
export function parsePriorities(text) {
  let t = String(text || '').replace(/^.*?\b(prioridades?|top ?3|plano de hoje|plano)\b\s*(de hoje|do dia|hoje)?\s*(sao|são|é|e|:|-)?\s*/i, '');
  if (t === text) t = String(text || '');
  const parts = t.split(/\s*(?:\n|;|\d+\s*[.)º°-]\s*|,\s*|\s+e\s+(?=[^,]{3,}$)|\bdepois\b|\bsegundo\b|\bterceiro\b|\bprimeiro\b)\s*/i).map((x) => x.replace(/^[\s:.-]+|[\s.]+$/g, '')).filter((x) => x.length >= 3);
  return parts.slice(0, 3);
}

// ------------------------------- executores -------------------------------
async function metricas(ctx) {
  const a = await buildAnalytics(scoped(ctx));
  const ps = a.products.filter((p) => p.kpis); const t = a.totals || {};
  if (!ps.length) return { reply: 'Não consegui ler os números dos sistemas agora. Tenta de novo em instantes.' };
  const days = a.days?.length || 30;
  const best = ps.slice().sort((x, y) => (y.kpis.cash || 0) - (x.kpis.cash || 0))[0];
  const reply = `A receita recorrente está em ${money(t.mrr)} e entraram ${money(t.cash)} nos últimos ${days} dias. São ${plural(t.active || 0, 'assinatura ativa', 'assinaturas ativas')}, ${plural(t.trial || 0, 'empresa em teste', 'empresas em teste')} e ${plural(t.past_due || 0, 'inadimplente', 'inadimplentes')}. Quem mais faturou foi o ${best.code}.${a.source === 'demo' ? ' Atenção: são números de demonstração.' : ''}`;
  const tz = tzOf(ctx); const day = today(ctx);
  const table = ['| Sistema | Ativas | Teste | Inadimpl. | Recebido 30d | MRR | Saúde |', '|---|---|---|---|---|---|---|', ...ps.map((p) => `| [[${p.code}]] | ${p.kpis.active ?? '—'} | ${p.kpis.trial ?? '—'} | ${p.kpis.past_due ?? '—'} | ${money(p.kpis.cash)} | ${money(p.kpis.mrr)} | ${p.health ?? '—'} |`)].join('\n');
  vault.appendTo(ctx, { folder: 'outputs', slug: `metricas-${day}`, title: `Métricas — ${day}`, heading: `Leitura das ${vault.localTime(tz)}`, text: `${reply}\n\n${table}`, source: 'skill:metricas' });
  return { reply, note: `outputs/metricas-${day}.md` };
}

async function caixaDeEntrada(ctx) {
  const b = await buildBriefing(ctx);
  const day = today(ctx);
  const top = b.items.filter((i) => i.level !== 'info').slice(0, 3).map((i) => i.title);
  const t3 = readTop3(ctx);
  let reply = `${b.headline}${top.length ? ` Os pontos de hoje: ${listPt(top)}.` : ''}`;
  if (b.pending) reply += ` ${plural(b.pending, 'decisão espera', 'decisões esperam')} sua aprovação.`;
  if (t3) reply += ` Seu top 3 de hoje: ${listPt(t3.map((x, i) => `${i + 1}, ${x}`))}.`;
  else { reply += ' Quais são suas três prioridades de hoje?'; setAwaiting(ctx, 'top3', 30); }
  vault.writeNote(ctx, { folder: 'outputs', slug: `resumo-${day}`, title: `Resumo da manhã — ${day}`, source: 'skill:caixa-de-entrada', content: `# Resumo da manhã — ${day}\n\n**${b.headline}**\n\n${b.items.map((i) => `- **${vault.autoLink(i.title)}** — ${i.text}`).join('\n')}\n\nFonte dos números: ${b.source}.\n` });
  return { reply, note: `outputs/resumo-${day}.md` };
}

async function tendencias(ctx) {
  const a = await buildAnalytics(scoped(ctx));
  const s = a.series || {}; const n = (a.days || []).length;
  if (n < 14) return { reply: 'Ainda não tenho dias suficientes para comparar semanas.' };
  const sum = (arr, from, to) => (arr || []).slice(from, to).reduce((x, y) => x + Number(y || 0), 0);
  const cmp = (arr) => { const now7 = sum(arr, n - 7, n); const prev7 = sum(arr, n - 14, n - 7); return { now7, prev7, delta: prev7 ? ((now7 - prev7) / prev7) * 100 : (now7 ? 100 : 0) }; };
  const k = { cadastros: cmp(s.signups), recebimentos: cmp(s.cash), cancelamentos: cmp(s.cancellations) };
  const desc = (name, c, isMoney) => `${name} ${c.delta > 2 ? 'subiram' : c.delta < -2 ? 'caíram' : 'ficaram estáveis'}${Math.abs(c.delta) > 2 ? ` ${pct(Math.abs(c.delta))}` : ''} (${isMoney ? money(c.now7) : c.now7} contra ${isMoney ? money(c.prev7) : c.prev7})`;
  const per = a.products.filter((p) => p.series).map((p) => ({ code: p.code, d: sum(p.series.cash, n - 7, n) - sum(p.series.cash, n - 14, n - 7) })).sort((x, y) => Math.abs(y.d) - Math.abs(x.d))[0];
  const small = k.cadastros.now7 + k.cadastros.prev7 < 6;
  const reply = `Comparando os últimos 7 dias com os 7 anteriores: ${desc('os recebimentos', k.recebimentos, true)}, ${desc('os cadastros', k.cadastros)} e ${desc('os cancelamentos', k.cancelamentos)}.${per && per.d ? ` Quem mais puxou foi o ${per.code} (${per.d > 0 ? '+' : '−'}${money(Math.abs(per.d))}).` : ''}${small ? ' A base ainda é pequena, então é cedo para chamar de tendência.' : ''}`;
  const day = today(ctx);
  vault.writeNote(ctx, { folder: 'outputs', slug: `tendencias-${day}`, title: `Tendências — ${day}`, source: 'skill:tendencias', content: `# Tendências — ${day}\n\n${vault.autoLink(reply)}\n\n| Indicador | 7 dias | 7 anteriores | Variação |\n|---|---|---|---|\n${Object.entries(k).map(([nm, c]) => `| ${nm} | ${nm === 'recebimentos' ? money(c.now7) : c.now7} | ${nm === 'recebimentos' ? money(c.prev7) : c.prev7} | ${pct(c.delta)} |`).join('\n')}\n` });
  return { reply, note: `outputs/tendencias-${day}.md` };
}

async function planoDeHoje(ctx, text) {
  const f = fold(text);
  const given = /\b(sao|:|e)\b/.test(f) && /\bprioridade|top ?3|plano\b/.test(f) ? parsePriorities(text) : [];
  if (given.length >= 1 && !/\?\s*$/.test(text) && !/^(qual|quais|me (diz|fala)|le|leia)/.test(f)) {
    saveTop3(ctx, given);
    return { reply: `Fechado, anotei seu top 3: ${listPt(given.map((x, i) => `${i + 1}, ${x}`))}. Vou te cobrar no fim do dia.`, note: `diario/${today(ctx)}.md` };
  }
  const t3 = readTop3(ctx);
  if (t3) return { reply: `Seu top 3 de hoje: ${listPt(t3.map((x, i) => `${i + 1}, ${x}`))}. Quer mudar alguma?` };
  const b = await buildBriefing(ctx).catch(() => null);
  const sug = [];
  if (b?.pending) sug.push(`revisar ${plural(b.pending, 'aprovação pendente', 'aprovações pendentes')}`);
  for (const i of (b?.items || []).filter((x) => x.level === 'danger' || x.level === 'warn')) if (sug.length < 3 && !/aprova/i.test(i.title)) sug.push(`olhar ${i.title.replace(/:.*/, '').trim()} — ${i.title.split(':').slice(1).join(':').trim() || i.text}`);
  setAwaiting(ctx, 'top3', 30);
  return { reply: sug.length ? `Ainda não temos o top 3 de hoje. Pelo que vejo, eu sugeriria: ${listPt(sug)}. Fecha assim ou me diz as suas três?` : 'Ainda não temos o top 3 de hoje. Quais são as três coisas mais importantes pra você hoje?', suggestions: sug };
}

async function cofre(ctx, text) {
  const f = fold(text).trim();
  const w = /^(lembr[ae](-se)?|anot[ae]|guard[ae]|registr[ae]|grav[ae]|nao esquec[ae])\b\s*(ai|isso|que|de que|disso|pra mim|para mim)?\s*[:,]?\s*/.exec(f);
  if (w && !/\?\s*$/.test(text)) {
    const cut = text.slice(text.length - (f.length - w[0].length)).trim();
    const r = vault.remember(ctx, cut);
    return { reply: `Anotado: ${clampText(cut.replace(/[.\s]+$/, ''), 200)}. Fica guardado no cofre${r.subject ? `, na nota de ${r.subject}` : ''}.`, note: r.path };
  }
  const about = /(sobre|de|do|da|dos|das)\s+(.+?)\??$/.exec(text)?.[2] || text;
  const found = vault.search(ctx, about, { limit: 4 });
  if (!found.length) return { reply: `Não tenho nada no cofre sobre ${clampText(about.replace(/[?.]+$/, ''), 80)} ainda. Se quiser, me fala que eu anoto.` };
  const lines = found.slice(0, 3).map((n) => `${n.title}: ${clampText(n.snippet, 200)}`);
  return { reply: `No cofre tem isto: ${lines.join(' | ')}`, notes: found.map((n) => n.path), rephrase: true };
}

export function dayRecap(ctx) {
  const day = today(ctx);
  const raw = vault.getNote(ctx, 'raw', `conversas-${day}`);
  const turns = raw ? (raw.content.match(/^\*\*\d{2}:\d{2} · /gm) || []).length : 0;
  const since = new Date(Date.now() - 18 * 3600_000).toISOString();
  const decisions = q.get('SELECT COUNT(*) AS c FROM decisions WHERE organization_id = ? AND created_at >= ?', ctx.orgId, since).c;
  const pending = q.get("SELECT COUNT(*) AS c FROM action_proposals WHERE organization_id = ? AND status = 'awaiting_approval'", ctx.orgId).c;
  const t3 = readTop3(ctx);
  return { day, turns, decisions, pending, top3: t3 };
}

async function encerrarDia(ctx, text) {
  const tz = tzOf(ctx); const r = dayRecap(ctx);
  const refl = /^reflexao[:\s]+(.+)$/i.exec(fold(text)) ? text.replace(/^\s*reflex[aã]o[:\s]+/i, '').trim() : '';
  if (refl) { saveReflection(ctx, refl); return { reply: 'Registrei a reflexão no diário de hoje. Bom descanso — amanhã de manhã te passo o resumo.', note: `diario/${r.day}.md` }; }
  const parts = [`Hoje foram ${plural(r.turns, 'conversa', 'conversas')} comigo`];
  if (r.decisions) parts.push(`${plural(r.decisions, 'análise aberta', 'análises abertas')}`);
  parts.push(r.pending ? `${plural(r.pending, 'aprovação ficou', 'aprovações ficaram')} para amanhã` : 'nenhuma aprovação pendente');
  const queue = [];
  if (r.pending) queue.push(`- [ ] Revisar ${plural(r.pending, 'aprovação pendente', 'aprovações pendentes')}`);
  if (r.top3) for (const x of r.top3) queue.push(`- [ ] Conferir: ${x}`);
  vault.appendTo(ctx, { folder: 'diario', slug: r.day, title: diaryTitle(r.day), heading: 'Encerramento', text: `- ${vault.localTime(tz)} — ${parts.join(', ')}.`, source: 'skill:encerrar-dia' });
  if (queue.length) vault.appendTo(ctx, { folder: 'diario', slug: r.day, title: diaryTitle(r.day), heading: 'Amanhã na fila', text: queue.join('\n'), source: 'skill:encerrar-dia' });
  setAwaiting(ctx, 'reflexao', 120);
  return { reply: `${listPt(parts)}.${r.top3 ? ` O top 3 era: ${listPt(r.top3)}.` : ''} Como foi o seu dia? Me conta numa frase que eu registro a reflexão.`, note: `diario/${r.day}.md` };
}

export function saveReflection(ctx, text) {
  const day = today(ctx);
  vault.appendTo(ctx, { folder: 'diario', slug: day, title: diaryTitle(day), heading: 'Reflexão', text: `> ${vault.autoLink(clampText(String(text).trim(), 1500))}`, source: 'reflexao' });
}

const HANDLERS = { metricas, 'caixa-de-entrada': caixaDeEntrada, tendencias, 'plano-de-hoje': planoDeHoje, cofre, 'encerrar-dia': encerrarDia };
export const runners = HANDLERS;

/** Resposta a uma pergunta que o Cérebro fez (top 3 da manhã, reflexão da noite). Devolve null se não for o caso. */
export function consumeAwaiting(ctx, text) {
  const r = getRoutine(ctx);
  if (!r.awaiting || !r.awaiting_until || r.awaiting_until < new Date().toISOString()) return null;
  const f = fold(text).trim();
  if (f.length < 4 || /\?\s*$/.test(text) || matchSkill(text)) return null;
  if (/^(nao|agora nao|depois|deixa|cancela|esquece)\b/.test(f)) { setAwaiting(ctx, null); return { reply: 'Tranquilo, fica pra depois.', skill: r.awaiting }; }
  if (r.awaiting === 'top3') {
    if (/^(fecha|pode|sim|ok|isso|beleza|perfeito|fechado|bora)\b/.test(f) && f.length < 30) return null; // aceitar sugestão: tratado pela conversa
    const items = parsePriorities(text);
    if (!items.length) return null;
    saveTop3(ctx, items); setAwaiting(ctx, null);
    return { reply: `Anotado no diário. Seu top 3: ${listPt(items.map((x, i) => `${i + 1}, ${x}`))}. Bora!`, skill: 'plano-de-hoje', note: `diario/${today(ctx)}.md` };
  }
  if (r.awaiting === 'reflexao') {
    saveReflection(ctx, text); setAwaiting(ctx, null);
    return { reply: 'Registrei a reflexão no diário. Obrigado por compartilhar — amanhã cedo te passo o resumo.', skill: 'encerrar-dia', note: `diario/${today(ctx)}.md` };
  }
  return null;
}

/** Roda a habilidade que bate com a frase. Devolve { reply, skill, instrucoes, note } ou null. */
export async function runSkill(ctx, text) {
  const s = matchSkill(text);
  if (!s) return null;
  try {
    const out = await HANDLERS[s.nome](ctx, text);
    if (!out) return null;
    return { ...out, intent: 'answer', skill: s.nome, instrucoes: s.instrucoes || '' };
  } catch (e) {
    console.warn(JSON.stringify({ level: 'warn', event: 'skill.failed', skill: s.nome, message: clampText(String(e.message), 200) }));
    return { reply: 'Tive um problema para rodar essa habilidade agora. Tenta de novo em instantes.', intent: 'answer', skill: s.nome };
  }
}
