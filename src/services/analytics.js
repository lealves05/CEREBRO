// Centro de Análise — consolida as bases dos sistemas (ORBI, TORVEN, RUSTEN, APOLVEN) a partir da Área Master.
// Somente leitura. Sem Área Master configurada (ou com falha), devolve dados de demonstração claramente sinalizados.
import * as master from '../connectors/master.js';
import { demoMetrics } from '../connectors/demo.js';
import { config } from '../config.js';

const DAYS = 30;
const TTL = 60_000;
const cache = new Map(); // chave: códigos de produto → { at, data }

const dayKey = (d) => new Date(d).toISOString().slice(0, 10);
function dayList() {
  const out = []; const t = new Date(); t.setUTCHours(0, 0, 0, 0);
  for (let i = DAYS - 1; i >= 0; i--) out.push(dayKey(t.getTime() - i * 86400_000));
  return out;
}
const n = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// Índice de saúde (0–100), fórmula fixa e exibida na tela:
// 100 − 3×cancelamento% − 1,5×inadimplência% + 0,5×crescimento% (limitado), sem dados → null
export function healthIndex(k) {
  if (!k.active) return null; // sem assinaturas pagas não há base para o índice
  const base = Math.max(1, (k.active || 0) + (k.past_due || 0));
  const churn = ((k.cancellations || 0) / base) * 100;
  const delinq = ((k.past_due || 0) / base) * 100;
  const growth = (((k.new_subscriptions || 0) - (k.cancellations || 0)) / base) * 100;
  return Math.max(0, Math.min(100, Math.round(100 - 3 * churn - 1.5 * delinq + 0.5 * Math.max(-20, Math.min(20, growth)))));
}

async function fromMaster(code, days) {
  const p = code.toLowerCase(); const qs = `?product=${encodeURIComponent(p)}`;
  const [tenantsRes, subsRes, paysRes, plansRes] = await Promise.all([
    master.call(`/tenants${qs}`), master.call(`/subscriptions${qs}`), master.call(`/payments${qs}`), master.call(`/plans${qs}`),
  ]);
  let dash = null; try { dash = await master.call(`/dashboard${qs}`); } catch { dash = null; }
  const list = (r, ...keys) => (Array.isArray(r) ? r : keys.map((k) => r?.[k]).find(Array.isArray) || []);
  const tenants = list(tenantsRes, 'items', 'tenants');
  const subs = list(subsRes, 'items', 'subscriptions');
  const pays = list(paysRes, 'items', 'payments');
  const plans = list(plansRes, 'items', 'plans').filter((x) => !x.product || x.product === p);
  const from = Date.parse(days[0]);
  const idx = Object.fromEntries(days.map((d, i) => [d, i]));
  const series = { signups: days.map(() => 0), cash: days.map(() => 0), cancellations: days.map(() => 0) };
  for (const t of tenants) if (t.created_at && Date.parse(t.created_at) >= from) { const i = idx[dayKey(t.created_at)]; if (i != null) series.signups[i]++; }
  for (const s of subs) if (s.canceled_at && Date.parse(s.canceled_at) >= from) { const i = idx[dayKey(s.canceled_at)]; if (i != null) series.cancellations[i]++; }
  for (const x of pays) if (x.status === 'CONFIRMED' && x.paid_at && Date.parse(x.paid_at) >= from) { const i = idx[dayKey(x.paid_at)]; if (i != null) series.cash[i] += Number(x.amount || 0); }
  series.cash = series.cash.map(round2);
  const status = {};
  for (const t of tenants) status[t.status || 'DESCONHECIDO'] = (status[t.status || 'DESCONHECIDO'] || 0) + 1;
  const cohort = tenants.filter((t) => t.trial_type && t.created_at && Date.parse(t.created_at) >= from);
  const kpis = {
    active: status.ACTIVE || 0,
    trial: status.TRIAL || 0,
    past_due: (status.PAST_DUE || 0) + (status.PAYMENT_PENDING || 0),
    suspended: status.SUSPENDED || 0,
    tenants: tenants.length,
    signups: series.signups.reduce((a, b) => a + b, 0),
    new_subscriptions: subs.filter((s) => s.started_at && Date.parse(s.started_at) >= from).length,
    cancellations: series.cancellations.reduce((a, b) => a + b, 0),
    cash: round2(series.cash.reduce((a, b) => a + b, 0)),
    open_receivables: round2(pays.filter((x) => ['PENDING', 'OVERDUE', 'PAYMENT_PENDING'].includes(x.status)).reduce((a, x) => a + Number(x.amount || 0), 0)),
    mrr: round2(n(dash?.kpis?.mrr)),
    conversion_pct: cohort.length ? round2((cohort.filter((t) => t.last_payment).length / cohort.length) * 100) : null,
  };
  const partial = tenants.length >= 500 || subs.length >= 500 || pays.length >= 500;
  // últimas atividades (sem dados pessoais além do nome da empresa)
  const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const recent = [
    ...tenants.filter((t) => t.created_at).map((t) => ({ at: t.created_at, type: 'signup', text: `Novo cadastro: ${t.name || 'empresa'}${t.trial_type ? ' · em teste' : ''}` })),
    ...pays.filter((x) => x.status === 'CONFIRMED' && x.paid_at).map((x) => ({ at: x.paid_at, type: 'payment', text: `Pagamento confirmado · ${brl(x.amount)}` })),
    ...pays.filter((x) => x.status === 'OVERDUE').map((x) => ({ at: x.due_date || x.due_at || x.created_at, type: 'overdue', text: `Cobrança vencida · ${brl(x.amount)}` })),
    ...subs.filter((x) => x.canceled_at).map((x) => ({ at: x.canceled_at, type: 'cancel', text: 'Assinatura cancelada' })),
    ...subs.filter((x) => x.started_at).map((x) => ({ at: x.started_at, type: 'subscription', text: 'Nova assinatura' })),
  ].filter((e) => e.at && Number.isFinite(Date.parse(e.at))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 15);
  return {
    kpis, series, status, recent,
    plans: plans.map((x) => ({ name: x.name, price: n(x.monthly_price), tenants: n(x.tenants), active: !!x.active })),
    notes: [partial ? 'Listas limitadas a 500 registros — valores parciais' : null, kpis.mrr == null ? 'MRR não informado pelo painel do Master' : null].filter(Boolean),
  };
}

// Demonstração determinística (mesmos números a cada carga), ancorada nos indicadores fictícios do produto
function seeded(seed) { let s = seed; return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648); }
function fromDemo(code, days) {
  const dm = demoMetrics(code, null);
  const get = (c) => n(dm?.metrics.find((m) => m.code === c)?.value);
  const active = get('active_subscriptions_at_period_end') || 0;
  const price = { ORBI: 99, TORVEN: 129, RUSTEN: 149, APOLVEN: 79 }[code] || 99;
  const rnd = seeded([...code].reduce((a, ch) => a + ch.charCodeAt(0) * 31, 7));
  const newSubs = get('new_subscriptions') || 0; const canc = get('cancellations') || 0;
  const spread = (total) => { const w = days.map(() => rnd() ** 2); const sum = w.reduce((a, b) => a + b, 0) || 1; const raw = w.map((x) => Math.floor((x / sum) * total)); let rest = total - raw.reduce((a, b) => a + b, 0); for (let i = 0; rest > 0; i = (i + 7) % raw.length, rest--) raw[i]++; return raw; };
  const signups = spread(Math.round(newSubs * 1.8));
  const cancellations = spread(canc);
  const cashTotal = get('cash_received_in_period') ?? active * price * 0.92;
  const cash = spread(Math.round(cashTotal / price)).map((x) => round2(x * price));
  const trial = Math.round(active * 0.18) + 2; const pastDue = Math.round(active * 0.06); const susp = Math.round(active * 0.02);
  const kpis = {
    active, trial, past_due: pastDue, suspended: susp, tenants: active + trial + pastDue + susp + canc,
    signups: signups.reduce((a, b) => a + b, 0), new_subscriptions: newSubs, cancellations: canc,
    cash: round2(cash.reduce((a, b) => a + b, 0)), open_receivables: round2(pastDue * price),
    mrr: round2(active * price * 1.04), conversion_pct: active ? round2(28 + rnd() * 22) : null,
  };
  return {
    recent: days.flatMap((d, i) => [
      ...Array.from({ length: signups[i] }, (_, k) => ({ at: `${d}T1${k % 9}:20:00Z`, type: 'signup', text: `Novo cadastro: Empresa demo ${code}-${i * 3 + k}` })),
      ...(cash[i] ? [{ at: `${d}T14:05:00Z`, type: 'payment', text: `Pagamento confirmado · ${cash[i].toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` }] : []),
      ...Array.from({ length: cancellations[i] }, () => ({ at: `${d}T17:40:00Z`, type: 'cancel', text: 'Assinatura cancelada' })),
    ]).filter((e) => Date.parse(e.at) <= Date.now()).reverse().slice(0, 15),
    kpis, series: { signups, cash, cancellations },
    status: { ACTIVE: active, TRIAL: trial, PAST_DUE: pastDue, SUSPENDED: susp, CANCELED: canc },
    plans: [{ name: 'Essencial', price, tenants: Math.round(active * 0.7), active: true }, { name: 'Profissional', price: price + 60, tenants: active - Math.round(active * 0.7), active: true }],
    notes: ['Demonstração — dados fictícios'],
  };
}

export async function buildAnalytics(products, { force = false } = {}) {
  const key = products.map((p) => p.id).sort().join(',');
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL) return { ...hit.data, cached: true };
  const days = dayList();
  const configured = master.isConfigured();
  let masterError = null;
  // login uma vez e leitura dos sistemas em paralelo
  if (configured) { try { await master.call('/dashboard'); } catch (e) { masterError = { kind: e.kind || 'error', message: e.message }; } }
  const raw = await Promise.all(products.map(async (p) => {
    if (configured && !masterError) { try { return { p, d: await fromMaster(p.code, days), src: 'master' }; } catch (e) { return { p, err: { kind: e.kind || 'error', message: e.message } }; } }
    return { p };
  }));
  const out = [];
  for (const { p, d: dm, src: sm, err } of raw) {
    if (err && !masterError) masterError = err;
    let d = dm; const src = sm || 'demo';
    if (!d) { if (!config.demoMode) { out.push({ code: p.code, name: p.name, description: p.description, source: 'unavailable', kpis: null }); continue; } d = fromDemo(p.code, days); }
    out.push({ code: p.code, name: p.name, description: p.description, source: src, ...d, health: healthIndex(d.kpis) });
  }
  const sum = (k) => { const v = out.filter((x) => x.kpis && x.kpis[k] != null); return v.length ? round2(v.reduce((a, x) => a + x.kpis[k], 0)) : null; };
  const totals = Object.fromEntries(['mrr', 'active', 'trial', 'past_due', 'suspended', 'tenants', 'signups', 'new_subscriptions', 'cancellations', 'cash', 'open_receivables'].map((k) => [k, sum(k)]));
  const conv = out.filter((x) => x.kpis?.conversion_pct != null);
  totals.conversion_pct = conv.length ? round2(conv.reduce((a, x) => a + x.kpis.conversion_pct, 0) / conv.length) : null;
  totals.health = healthIndex(totals);
  const daily = (k) => days.map((_, i) => round2(out.reduce((a, x) => a + (x.series?.[k]?.[i] || 0), 0)));
  const sources = [...new Set(out.map((x) => x.source))];
  const data = {
    generated_at: new Date().toISOString(), days, totals,
    series: { signups: daily('signups'), cash: daily('cash'), cancellations: daily('cancellations') },
    products: out,
    source: sources.length === 1 ? sources[0] : 'mixed',
    master: { configured, error: masterError },
    formula: 'Saúde = 100 − 3×cancelamento% − 1,5×inadimplência% + 0,5×crescimento líquido% (−20 a +20), sobre ativos + inadimplentes',
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}
export const clearAnalyticsCache = () => cache.clear();
