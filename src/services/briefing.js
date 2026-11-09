// Briefing do dia: leitura curta dos números dos sistemas + o que espera decisão. Usado na tela Comando, no comando
// RESUMO do WhatsApp e no envio automático diário (horário escolhido por cada pessoa, no fuso da organização).
// Tudo aqui é cálculo sobre os dados lidos (Área Master ou demonstração) — não é parecer de IA.
import { q, now } from '../db.js';
import { clampText } from '../lib/util.js';
import { buildAnalytics } from './analytics.js';
import * as wa from '../connectors/whatsapp.js';

const money = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 }));
const pct = (v) => `${Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

function scopedProducts(orgId, productIds) {
  return q.all("SELECT id, code, name, description FROM products WHERE organization_id = ? AND status = 'active' ORDER BY code", orgId)
    .filter((p) => !productIds || productIds.has(p.id));
}

/** Itens do briefing (nível: info | warn | danger | good). */
export async function buildBriefing(ctx, { analytics = null } = {}) {
  const a = analytics || await buildAnalytics(scopedProducts(ctx.orgId, ctx.productIds));
  const ps = a.products.filter((p) => p.kpis); const t = a.totals || {};
  const items = [];
  if (ps.length) {
    items.push({ level: 'info', title: `Receita recorrente: ${money(t.mrr)}`, text: `Recebido nos últimos 30 dias: ${money(t.cash)}. ${t.open_receivables ? `Em aberto: ${money(t.open_receivables)}.` : 'Nada em aberto.'}` });
    const churn = ps.map((p) => ({ p, v: (p.kpis.cancellations || 0) / Math.max(1, p.kpis.active || 0) * 100 })).sort((x, y) => y.v - x.v)[0];
    const debt = ps.map((p) => ({ p, v: (p.kpis.past_due || 0) / Math.max(1, (p.kpis.active || 0) + (p.kpis.past_due || 0)) * 100 })).sort((x, y) => y.v - x.v)[0];
    if (churn && churn.v >= (debt?.v || 0) && churn.v > 0) items.push({ level: churn.v >= 5 ? 'danger' : 'warn', title: `${churn.p.code}: cancelamento de ${pct(churn.v)} em 30 dias`, text: `${churn.p.kpis.cancellations} cancelamento(s) sobre ${churn.p.kpis.active} assinaturas ativas. Referência: abaixo de 5%.` });
    else if (debt && debt.v > 0) items.push({ level: debt.v >= 10 ? 'danger' : 'warn', title: `${debt.p.code}: inadimplência de ${pct(debt.v)}`, text: `${debt.p.kpis.past_due} empresa(s) com pagamento atrasado (${money(debt.p.kpis.open_receivables)} em aberto).` });
    const net = ps.map((p) => ({ p, v: (p.kpis.new_subscriptions || 0) - (p.kpis.cancellations || 0) })).sort((x, y) => y.v - x.v)[0];
    if (net) items.push({ level: net.v > 0 ? 'good' : 'info', title: `Melhor crescimento: ${net.p.code} (${net.v >= 0 ? '+' : ''}${net.v})`, text: `${net.p.kpis.new_subscriptions || 0} nova(s) assinatura(s) e ${net.p.kpis.cancellations || 0} cancelamento(s). ${t.trial ? `${t.trial} empresa(s) em teste agora.` : ''}`.trim() });
  }
  const pend = q.all(`SELECT p.summary FROM action_proposals p WHERE p.organization_id = ? AND p.status = 'awaiting_approval' ORDER BY p.created_at DESC LIMIT 5`, ctx.orgId);
  if (pend.length) items.push({ level: 'warn', title: `${pend.length} decisão(ões) esperando aprovação`, text: pend.slice(0, 3).map((x) => clampText(x.summary, 70)).join(' · ') });
  const failed = q.get("SELECT COUNT(*) AS c FROM runs WHERE organization_id = ? AND status = 'failed' AND queued_at >= ?", ctx.orgId, new Date(Date.now() - 86400_000).toISOString()).c;
  if (failed) items.push({ level: 'warn', title: `${failed} análise(s) falharam nas últimas 24 h`, text: 'Abra a Sala de Decisão para refazer.' });
  const worst = items.find((i) => i.level === 'danger') || items.find((i) => i.level === 'warn');
  const headline = !ps.length ? 'Sem dados dos sistemas no momento.' : worst ? `Atenção — ${worst.title}.` : 'Tudo dentro do esperado hoje.';
  return { generated_at: new Date().toISOString(), source: a.source, headline, items, pending: pend.length, totals: t };
}

export function briefingText(b, firstName = '', tz = 'America/Sao_Paulo') {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: tz }).format(new Date()));
  const hi = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
  const icon = { danger: '🔴', warn: '🟠', good: '🟢', info: '•' };
  const lines = [`${hi}${firstName ? `, ${firstName}` : ''}. *Briefing do Cérebro LORLER*`, b.headline, ''];
  for (const i of b.items) lines.push(`${icon[i.level] || '•'} *${i.title}*\n${i.text}`);
  if (b.source === 'demo') lines.push('', '_Números de demonstração: ligue a Área Master para ver os reais._');
  lines.push('', b.pending ? 'Envie *PENDENTES* para ver as aprovações.' : 'Envie *RADAR* para ver cada sistema.');
  return lines.join('\n');
}

export function radarText(a) {
  const rows = a.products.map((p) => (p.kpis
    ? `*${p.code}* · saúde ${p.health ?? '—'} · MRR ${money(p.kpis.mrr)} · ${p.kpis.active ?? 0} ativas · ${p.kpis.cancellations ?? 0} canc. · ${p.kpis.past_due ?? 0} atrasadas`
    : `*${p.code}* · sem dados`));
  return [`*Radar dos sistemas*${a.source === 'demo' ? ' (demonstração)' : ''}`, ...rows, '', `Saúde geral: ${a.totals?.health ?? '—'}`].join('\n');
}

export async function radarForCtx(ctx) { return radarText(await buildAnalytics(scopedProducts(ctx.orgId, ctx.productIds))); }

// ---------- envio automático ----------
function localParts(tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const o = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute) };
}
const toMin = (hhmm) => { const [h, m] = String(hhmm || '07:30').split(':').map(Number); return h * 60 + m; };

/** Chamado pela rotina do worker: envia o briefing a quem ligou, uma vez por dia, até 3 h depois do horário. */
export async function processBriefings({ send = null } = {}) {
  if (!wa.isConfigured() && !send) return { skipped: 'not_configured' };
  const links = q.all(`SELECT l.*, o.timezone FROM whatsapp_links l JOIN organizations o ON o.id = l.organization_id
    JOIN organization_members m ON m.user_id = l.user_id AND m.organization_id = l.organization_id AND m.status = 'active'
    WHERE l.status = 'verified' AND l.briefing = 1 AND l.wa_id IS NOT NULL`);
  let sent = 0;
  for (const l of links) {
    const lp = localParts(l.timezone);
    const at = toMin(l.briefing_time);
    if (l.briefing_last === lp.date || lp.minutes < at || lp.minutes > at + 180) continue;
    q.run('UPDATE whatsapp_links SET briefing_last = ? WHERE id = ?', lp.date, l.id); // marca antes: nunca manda duas vezes
    try { await sendBriefingTo(l, { send }); sent++; } catch (e) { console.error('[briefing]', e.message); }
  }
  return { sent };
}

export async function sendBriefingTo(link, { send = null } = {}) {
  const m = q.get("SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'", link.organization_id, link.user_id);
  const productIds = m ? new Set(q.all('SELECT product_id FROM member_product_scopes WHERE member_id = ?', m.id).map((r) => r.product_id)) : new Set();
  const u = q.get('SELECT display_name FROM users WHERE id = ?', link.user_id);
  const b = await buildBriefing({ orgId: link.organization_id, userId: link.user_id, productIds });
  const tz = link.timezone || q.get('SELECT timezone FROM organizations WHERE id = ?', link.organization_id)?.timezone;
  const text = briefingText(b, String(u?.display_name || '').split(' ')[0], tz || undefined);
  if (send) return send(link.wa_id, text);
  const c = wa.waConfig();
  // fora da janela de 24 h a Meta só entrega modelo aprovado: manda o modelo (1 variável) e o texto completo em seguida
  if (c.briefingTemplate) { await wa.sendTemplate(link.wa_id, c.briefingTemplate, c.templateLang, [clampText(b.headline, 250)]); try { await wa.sendText(link.wa_id, text); } catch { /* fora da janela: o modelo já chegou */ } }
  else await wa.sendText(link.wa_id, text);
  return { ok: true, at: now() };
}
