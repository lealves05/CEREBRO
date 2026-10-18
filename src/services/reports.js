// Relatório por base (clicar numa base em órbita do cérebro): últimas atividades + projeções.
// Projeções = tendência linear simples dos últimos 30 dias (cálculo determinístico, não é parecer da IA).
import { q } from '../db.js';
import { buildAnalytics } from './analytics.js';
import * as master from '../connectors/master.js';
import { activePolicy } from './policy.js';

const DAY = 86400_000;
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

// Regressão linear: valores ajustados para os próximos `ahead` dias
export function linearTrend(series, ahead = 30) {
  const ys = (series || []).map((v) => Number(v) || 0); const n = ys.length;
  if (n < 2) return { slope: 0, next: Array(ahead).fill(0), total: 0, trend: 'estável' };
  const mx = (n - 1) / 2; const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0; let den = 0;
  ys.forEach((y, x) => { num += (x - mx) * (y - my); den += (x - mx) ** 2; });
  const slope = den ? num / den : 0; const icpt = my - slope * mx;
  const next = Array.from({ length: ahead }, (_, k) => Math.max(0, icpt + slope * (n + k)));
  const rel = my ? (slope * n) / my : 0;
  return { slope, next: next.map(r2), total: r2(next.reduce((a, b) => a + b, 0)), trend: rel > 0.15 ? 'alta' : rel < -0.15 ? 'queda' : 'estável', avg: my };
}

const STATUS_PT = { awaiting_approval: 'aguardando aprovação', approved: 'aprovada', executed: 'executada', rejected: 'rejeitada', denied: 'negada pela política', failed: 'falhou', uncertain: 'resultado incerto', executing: 'executando', revision_requested: 'revisão pedida', canceled: 'cancelada', expired: 'expirada', advisory: 'recomendação', draft: 'rascunho' };
const proposalsFor = (orgId, where, ...args) => q.all(`SELECT id, decision_id, tool_code, summary, status, created_at FROM action_proposals WHERE organization_id = ? AND ${where} ORDER BY created_at DESC LIMIT 10`, orgId, ...args)
  .map((x) => ({ at: x.created_at, type: x.status === 'executed' ? 'done' : x.status === 'awaiting_approval' ? 'pending' : ['failed', 'denied', 'rejected'].includes(x.status) ? 'fail' : 'info', text: `${x.summary} · ${STATUS_PT[x.status] || x.status}`, href: `#/decisao/${x.decision_id}` }));

function productProjections(k, s) {
  const sign = linearTrend(s.signups); const cash = linearTrend(s.cash); const canc = linearTrend(s.cancellations);
  const net = (k.new_subscriptions || 0) - (k.cancellations || 0);
  const active30 = Math.max(0, (k.active || 0) + net);
  const mrr30 = k.mrr != null && k.active ? r2(k.mrr * (active30 / k.active)) : null;
  const convExpected = k.trial && k.conversion_pct != null ? Math.round(k.trial * k.conversion_pct / 100) : null;
  return {
    chart: { label: 'Recebido por dia', fmt: 'money', actual: s.cash, projected: cash.next },
    list: [
      { label: 'Recebimento nos próximos 30 dias', value: cash.total, fmt: 'money', note: `tendência de ${cash.trend}` },
      { label: 'Novos cadastros nos próximos 30 dias', value: Math.round(sign.total), fmt: 'num', note: `tendência de ${sign.trend}` },
      { label: 'Cancelamentos nos próximos 30 dias', value: Math.round(canc.total), fmt: 'num', note: canc.total > (k.active || 0) * 0.05 ? 'acima da meta de 5%' : 'dentro da meta de 5%' },
      { label: 'Assinaturas ativas em 30 dias', value: active30, fmt: 'num', note: `mantido o saldo de ${net >= 0 ? '+' : ''}${net} do último mês` },
      { label: 'MRR em 30 dias', value: mrr30, fmt: 'money', note: mrr30 == null ? 'sem base (nenhuma assinatura ativa ou MRR ausente)' : 'proporcional às assinaturas ativas' },
      { label: 'Testes que devem converter', value: convExpected, fmt: 'num', note: convExpected == null ? 'sem conversão medida' : `${k.trial} em teste × ${k.conversion_pct}% de conversão` },
    ],
  };
}

function productKpis(k) {
  return [
    { label: 'MRR', value: k.mrr, fmt: 'money' }, { label: 'Ativas', value: k.active, fmt: 'num' }, { label: 'Em teste', value: k.trial, fmt: 'num' },
    { label: 'Inadimplentes', value: k.past_due, fmt: 'num' }, { label: 'Recebido 30d', value: k.cash, fmt: 'money' }, { label: 'Em aberto', value: k.open_receivables, fmt: 'money' },
  ];
}
function alertsFor(k, label) {
  const out = [];
  if (k.active === 0 && k.trial > 0) out.push(`${label}: nenhuma assinatura paga ainda — ${k.trial} empresa(s) em teste. Foco em converter os testes.`);
  if (k.past_due > 0) out.push(`${label}: ${k.past_due} empresa(s) inadimplente(s), ${Number(k.open_receivables || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} em aberto.`);
  if (k.active && k.cancellations / k.active > 0.05) out.push(`${label}: cancelamento acima de 5% no mês.`);
  return out;
}

export async function sourceReport(ctx, code, products) {
  const C = String(code || '').toUpperCase();
  const base = { code: C, generated_at: new Date().toISOString(), method: 'Projeções por tendência linear dos últimos 30 dias, mantido o ritmo atual. São estimativas, não garantias.' };
  const prod = products.find((p) => p.code === C);
  if (prod || C === 'MASTER') {
    const a = await buildAnalytics(products);
    if (prod) {
      const p = a.products.find((x) => x.code === C);
      if (!p?.kpis) return { ...base, title: C, subtitle: 'Sem dados disponíveis', source: 'unavailable', kpis: [], projections: [], activities: [], notes: ['Ligue a Área Master ou o modo de demonstração.'] };
      const pj = productProjections(p.kpis, p.series);
      const local = proposalsFor(ctx.orgId, 'product_id = ?', prod.id);
      return {
        ...base, title: C, subtitle: p.description || prod.name, source: p.source, days: a.days,
        kpis: productKpis(p.kpis), health: p.health, chart: pj.chart, projections: pj.list,
        activities: [...(p.recent || []), ...local].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 18),
        notes: [...alertsFor(p.kpis, C), ...(p.notes || [])],
        ask: `Com base nas últimas atividades e projeções do ${C}, o que devo priorizar nos próximos 30 dias?`,
      };
    }
    // Área Master: visão consolidada dos sistemas + mudanças feitas pelo cérebro no Master
    const t = a.totals;
    const pj = productProjections(t, a.series);
    const recent = a.products.flatMap((p) => (p.recent || []).map((e) => ({ ...e, text: `${p.code} · ${e.text}` })));
    const changes = proposalsFor(ctx.orgId, "tool_code LIKE 'master_%'");
    const st = master.lastMasterStatus();
    return {
      ...base, title: 'Área Master', subtitle: 'Consolidado de ORBI, TORVEN, RUSTEN e APOLVEN', source: a.source, days: a.days,
      kpis: [...productKpis(t), { label: 'Empresas', value: t.tenants, fmt: 'num' }, { label: 'Saúde', value: t.health, fmt: 'num' }],
      chart: pj.chart, projections: pj.list,
      by_product: a.products.filter((p) => p.kpis).map((p) => ({ code: p.code, mrr: p.kpis.mrr, active: p.kpis.active, trial: p.kpis.trial, cash: p.kpis.cash, next30: linearTrend(p.series.cash).total })),
      activities: [...changes.map((x) => ({ ...x, text: `Cérebro → Master: ${x.text}` })), ...recent].sort((x, y) => Date.parse(y.at) - Date.parse(x.at)).slice(0, 20),
      notes: [...a.products.filter((p) => p.kpis).flatMap((p) => alertsFor(p.kpis, p.code)), a.master.error ? `Falha ao ler o Master: ${a.master.error.message}` : null, st?.checked_at ? `Último teste de conexão: ${st.ok ? 'ok' : 'falhou'} (${new Date(st.checked_at).toLocaleString('pt-BR')})` : null].filter(Boolean),
      ask: 'Com base nas últimas atividades e projeções de todos os sistemas na Área Master, quais ações devo priorizar nos próximos 30 dias?',
    };
  }
  if (C === 'INSTAGRAM') {
    const acc = q.get("SELECT username, account_type, status, token_expires_at, connected_at FROM social_accounts WHERE organization_id = ? AND provider = 'instagram' AND status <> 'disconnected' ORDER BY connected_at DESC LIMIT 1", ctx.orgId);
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const count = (st) => q.get(`SELECT COUNT(*) AS c FROM action_proposals WHERE organization_id = ? AND tool_code = 'publish_instagram_post' AND status ${st} AND created_at >= ?`, ctx.orgId, since).c;
    const published = count("= 'executed'"); const pending = count("= 'awaiting_approval'"); const drafted = count("IS NOT NULL");
    const maxDay = activePolicy(ctx.orgId).rules.tools?.publish_instagram_post?.max_posts_per_day ?? null;
    const perDay = q.all("SELECT substr(created_at,1,10) AS d, COUNT(*) AS c FROM action_proposals WHERE organization_id = ? AND tool_code = 'publish_instagram_post' AND status = 'executed' AND created_at >= ? GROUP BY d", ctx.orgId, since);
    const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * DAY).toISOString().slice(0, 10));
    const series = days.map((d) => perDay.find((x) => x.d === d)?.c || 0);
    const tr = linearTrend(series);
    return {
      ...base, title: 'Instagram', subtitle: acc ? `@${acc.username || 'conta'} · ${acc.account_type || ''}` : 'Conta não vinculada', source: acc ? 'connected' : 'pending', days,
      kpis: [{ label: 'Posts publicados 30d', value: published, fmt: 'num' }, { label: 'Aguardando aprovação', value: pending, fmt: 'num' }, { label: 'Rascunhos do agente 30d', value: drafted, fmt: 'num' }, { label: 'Limite por dia', value: maxDay, fmt: 'num' }],
      chart: { label: 'Posts publicados por dia', fmt: 'num', actual: series, projected: tr.next },
      projections: [
        { label: 'Posts nos próximos 30 dias', value: Math.round(tr.total), fmt: 'num', note: published ? `ritmo atual (${tr.trend})` : 'nenhum post publicado ainda' },
        { label: 'Token da conta expira em', value: acc?.token_expires_at ? Math.max(0, Math.round((Date.parse(acc.token_expires_at) - Date.now()) / DAY)) : null, fmt: 'days', note: acc?.token_expires_at ? 'renove antes de vencer' : 'sem data informada' },
      ],
      activities: proposalsFor(ctx.orgId, "tool_code = 'publish_instagram_post'"),
      notes: [!acc ? 'Vincule a conta em Integrações → Instagram para publicar.' : null, pending ? `${pending} post(s) esperando sua aprovação.` : null].filter(Boolean),
      ask: 'Crie um plano de posts para o Instagram dos próximos 30 dias para aumentar os cadastros nos sistemas LORLER.',
    };
  }
  if (C === 'WHATSAPP') {
    const link = q.get('SELECT status, notify, verified_at FROM whatsapp_links WHERE organization_id = ? AND user_id = ?', ctx.orgId, ctx.userId);
    const since = new Date(Date.now() - 30 * DAY).toISOString();
    const rows = q.all('SELECT status, created_at, decided_at, action_proposal_id FROM whatsapp_requests WHERE organization_id = ? AND created_at >= ? ORDER BY created_at DESC', ctx.orgId, since);
    const by = (s) => rows.filter((x) => x.status === s).length;
    const decided = rows.filter((x) => x.decided_at);
    const avgMin = decided.length ? Math.round(decided.reduce((a, x) => a + (Date.parse(x.decided_at) - Date.parse(x.created_at)), 0) / decided.length / 60000) : null;
    const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - (29 - i) * DAY).toISOString().slice(0, 10));
    const series = days.map((d) => rows.filter((x) => x.created_at.slice(0, 10) === d).length);
    const tr = linearTrend(series);
    const ST = { sent: 'enviado', awaiting_pin: 'aguardando PIN', approved: 'aprovado', rejected: 'rejeitado', revision: 'revisão pedida', expired: 'expirado', failed: 'falha no envio', superseded: 'substituído' };
    const summaries = Object.fromEntries(q.all('SELECT id, summary, decision_id FROM action_proposals WHERE organization_id = ?', ctx.orgId).map((x) => [x.id, x]));
    return {
      ...base, title: 'WhatsApp', subtitle: link?.status === 'verified' ? 'Número vinculado · aprovações por mensagem' : 'Número não vinculado', source: link?.status === 'verified' ? 'connected' : 'pending', days,
      kpis: [{ label: 'Pedidos enviados 30d', value: rows.length, fmt: 'num' }, { label: 'Aprovados', value: by('approved'), fmt: 'num' }, { label: 'Rejeitados', value: by('rejected'), fmt: 'num' }, { label: 'Tempo médio de resposta', value: avgMin, fmt: 'min' }],
      chart: { label: 'Pedidos de aprovação por dia', fmt: 'num', actual: series, projected: tr.next },
      projections: [{ label: 'Pedidos nos próximos 30 dias', value: Math.round(tr.total), fmt: 'num', note: rows.length ? `ritmo atual (${tr.trend})` : 'nenhum pedido enviado ainda' }],
      activities: rows.slice(0, 15).map((x) => ({ at: x.created_at, type: x.status === 'approved' ? 'done' : ['failed', 'rejected', 'expired'].includes(x.status) ? 'fail' : 'pending', text: `${summaries[x.action_proposal_id]?.summary || 'Proposta'} · ${ST[x.status] || x.status}`, href: summaries[x.action_proposal_id] ? `#/decisao/${summaries[x.action_proposal_id].decision_id}` : undefined })),
      notes: [link?.status !== 'verified' ? 'Vincule seu número em Administração → WhatsApp.' : null].filter(Boolean),
      ask: null,
    };
  }
  return null;
}
