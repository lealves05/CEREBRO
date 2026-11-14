// Rotina do dia do JARVIS (por pessoa, no fuso da organização):
//   07:00 resumo da manhã (caixa de entrada) → outputs/ e pergunta o top 3
//   09:00 plano do dia → se o top 3 ainda não existe, pergunta (vai para o diário)
//   14:00 métricas → outputs/ (inscritos, recebimentos, cancelamentos monitorados)
//   19:00 encerrar o dia → diário (encerramento + amanhã na fila) e pergunta a reflexão
// Cada etapa roda uma vez por dia, até 2 h depois do horário. Pelo WhatsApp vinculado, as perguntas chegam como mensagem
// (e a resposta vai direto para o cofre). Nada aqui aprova ou executa ação — é leitura, registro e conversa.
import { q, now, json } from '../db.js';
import { errors, clampText } from '../lib/util.js';
import * as wa from '../connectors/whatsapp.js';

export const SLOTS = ['manha', 'plano', 'metricas', 'encerrar'];
export const SLOT_LABEL = { manha: 'Resumo da manhã', plano: 'Plano do dia (top 3)', metricas: 'Métricas monitoradas', encerrar: 'Encerrar o dia' };
export const DEFAULT_TIMES = Object.freeze({ manha: '07:00', plano: '09:00', metricas: '14:00', encerrar: '19:00' });
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function getRoutine(ctx) {
  let r = q.get('SELECT * FROM jarvis_routine WHERE user_id = ?', ctx.userId);
  if (!r) {
    q.run('INSERT OR IGNORE INTO jarvis_routine (user_id, organization_id, times, updated_at) VALUES (?, ?, ?, ?)', ctx.userId, ctx.orgId, JSON.stringify(DEFAULT_TIMES), now());
    r = q.get('SELECT * FROM jarvis_routine WHERE user_id = ?', ctx.userId);
  }
  return r;
}

export function publicRoutine(ctx) {
  const r = getRoutine(ctx);
  return { enabled: !!r.enabled, whatsapp: !!r.whatsapp, voice_reply: !!r.voice_reply, times: { ...DEFAULT_TIMES, ...json(r.times, {}) }, last_runs: json(r.last_runs, {}), awaiting: r.awaiting_until > now() ? r.awaiting : null };
}

export function setRoutine(ctx, body) {
  const r = getRoutine(ctx);
  const times = { ...DEFAULT_TIMES, ...json(r.times, {}) };
  if (body.times && typeof body.times === 'object') {
    for (const k of SLOTS) if (body.times[k] != null) { if (!HHMM.test(String(body.times[k]))) throw errors.invalid(`Horário inválido em ${SLOT_LABEL[k]} (use HH:MM).`); times[k] = String(body.times[k]); }
  }
  const b = (v, d) => (v == null ? d : v ? 1 : 0);
  q.run('UPDATE jarvis_routine SET enabled = ?, whatsapp = ?, voice_reply = ?, times = ?, updated_at = ? WHERE user_id = ?', b(body.enabled, r.enabled), b(body.whatsapp, r.whatsapp), b(body.voice_reply, r.voice_reply), JSON.stringify(times), now(), ctx.userId);
  return publicRoutine(ctx);
}

/** O Cérebro fez uma pergunta e espera a resposta (top3 | reflexao) por alguns minutos. kind=null limpa. */
export function setAwaiting(ctx, kind, minutes = 30) {
  getRoutine(ctx);
  q.run('UPDATE jarvis_routine SET awaiting = ?, awaiting_until = ? WHERE user_id = ?', kind, kind ? new Date(Date.now() + minutes * 60_000).toISOString() : null, ctx.userId);
}

function localParts(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}
const toMin = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

/** Agenda de hoje para o HUD: etapas da rotina com horário e se já rodaram. */
export function agendaToday(ctx, tz) {
  const r = publicRoutine(ctx); const lp = localParts(tz);
  return SLOTS.map((k) => ({ slot: k, label: SLOT_LABEL[k], time: r.times[k], done: r.last_runs[k] === lp.date, upcoming: r.last_runs[k] !== lp.date && toMin(r.times[k]) >= lp.minutes }));
}

function ctxForUser(row) {
  const m = q.get("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'", row.organization_id, row.user_id);
  if (!m) return null;
  const org = q.get('SELECT timezone FROM organizations WHERE id = ?', row.organization_id);
  const u = q.get('SELECT display_name FROM users WHERE id = ?', row.user_id);
  return { userId: row.user_id, orgId: row.organization_id, role: m.role, memberId: m.id, timezone: org?.timezone || 'America/Sao_Paulo', firstName: String(u?.display_name || '').split(' ')[0], productIds: new Set(q.all('SELECT product_id FROM member_product_scopes WHERE member_id = ?', m.id).map((x) => x.product_id)) };
}

/** Executa uma etapa da rotina agora (usado pelo worker e pelo botão do HUD). */
export async function runSlot(ctx, slot, { send = null } = {}) {
  const { runners, readTop3 } = await import('./skills.js');
  let out;
  if (slot === 'manha') out = await runners['caixa-de-entrada'](ctx, 'resumo da manhã');
  else if (slot === 'plano') {
    const t3 = readTop3(ctx);
    out = t3 ? { reply: `Seu top 3 de hoje já está no diário: ${t3.join('; ')}.`, quiet: true } : await runners['plano-de-hoje'](ctx, 'plano de hoje');
  } else if (slot === 'metricas') out = await runners.metricas(ctx, 'métricas');
  else if (slot === 'encerrar') out = await runners['encerrar-dia'](ctx, 'encerrar o dia');
  else throw errors.invalid('Etapa da rotina inválida.');
  const r = getRoutine(ctx); const lp = localParts(ctx.timezone);
  const last = { ...json(r.last_runs, {}), [slot]: lp.date };
  q.run('UPDATE jarvis_routine SET last_runs = ?, updated_at = ? WHERE user_id = ?', JSON.stringify(last), now(), ctx.userId);
  // pelo WhatsApp (se vinculado e ligado): a rotina vira conversa no celular
  if (r.whatsapp && !out.quiet) {
    const link = q.get("SELECT * FROM whatsapp_links WHERE user_id = ? AND organization_id = ? AND status = 'verified' AND wa_id IS NOT NULL", ctx.userId, ctx.orgId);
    const dup = slot === 'manha' && link?.briefing; // o briefing diário já vai pelo WhatsApp
    if (link && !dup && (send || wa.isConfigured())) {
      const head = { manha: '☀️ *Resumo da manhã*', plano: '🗒️ *Plano do dia*', metricas: '📊 *Métricas das 14h*', encerrar: '🌙 *Fim do dia*' }[slot];
      const text = `${head}\n${out.reply}`;
      try { if (send) await send(link.wa_id, text); else await wa.sendText(link.wa_id, text); } catch (e) { console.warn(JSON.stringify({ level: 'warn', event: 'routine.wa_failed', slot, message: clampText(String(e.message), 160) })); }
    }
  }
  return { slot, ...out };
}

/** Chamado pela rotina do worker (housekeeping). */
export async function processRoutine({ send = null } = {}) {
  const rows = q.all('SELECT * FROM jarvis_routine WHERE enabled = 1');
  let ran = 0;
  for (const row of rows) {
    const ctx = ctxForUser(row); if (!ctx) continue;
    const lp = localParts(ctx.timezone); const times = { ...DEFAULT_TIMES, ...json(row.times, {}) }; const last = json(row.last_runs, {});
    for (const slot of SLOTS) {
      const at = toMin(times[slot]);
      if (last[slot] === lp.date || lp.minutes < at || lp.minutes > at + 120) continue;
      // marca antes: nunca roda duas vezes no mesmo dia
      last[slot] = lp.date;
      q.run('UPDATE jarvis_routine SET last_runs = ? WHERE user_id = ?', JSON.stringify(last), row.user_id);
      try { await runSlot(ctx, slot, { send }); ran++; } catch (e) { console.error('[rotina]', slot, e.message); }
    }
  }
  return { ran };
}
