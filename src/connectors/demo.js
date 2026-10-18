// DEMONSTRAÇÃO — DADOS FICTÍCIOS.
// Usado somente em decisões marcadas como demonstração (is_demo = 1). Nunca alimenta relatório real.
const m = (code, value, unit, quality = 'complete', extra = {}) => ({ code, value, unit, definition_version: '1.0', quality, source_ref: `demo/${code}`, ...extra });

const DATA = {
  ORBI: [
    m('active_subscriptions_at_period_start', '92', 'subscriptions'),
    m('active_subscriptions_at_period_end', '100', 'subscriptions'),
    m('new_subscriptions', '14', 'subscriptions'),
    m('cancellations', '6', 'subscriptions'),
    m('cohort_trials', '48', 'trials'),
    m('cohort_trial_subscriptions', '11', 'subscriptions'),
    m('plan_price_main', '99.00', 'money'),
    m('variable_cost_per_subscription', '25.00', 'money'),
    m('cash_received_in_period', '9900.00', 'money'),
    m('open_receivables', '594.00', 'money'),
    m('support_tickets', '63', 'tickets'),
    m('tickets_per_customer', '0.63', 'ratio'),
    m('support_capacity_monthly', '120', 'tickets'),
    m('first_response_hours', '3.4', 'hours', 'partial', { note: 'Somente horário comercial' }),
    m('incidents', '1', 'incidents'),
    m('error_rate_pct', '0.8', 'percent', 'partial', { note: 'Monitoramento parcial da API' }),
    m('infra_cost', '420.00', 'money'),
  ],
  TORVEN: [
    m('active_subscriptions_at_period_start', '31', 'subscriptions'),
    m('active_subscriptions_at_period_end', '34', 'subscriptions'),
    m('new_subscriptions', '5', 'subscriptions'),
    m('cancellations', '2', 'subscriptions'),
    m('cohort_trials', '19', 'trials'),
    m('cohort_trial_subscriptions', '5', 'subscriptions'),
    m('plan_price_main', '129.00', 'money'),
    m('variable_cost_per_subscription', '31.00', 'money'),
    m('cash_received_in_period', '4386.00', 'money'),
    m('open_receivables', '258.00', 'money'),
    m('support_tickets', '29', 'tickets'),
    m('tickets_per_customer', '0.85', 'ratio'),
    m('support_capacity_monthly', '40', 'tickets'),
    m('first_response_hours', '6.1', 'hours', 'partial'),
    m('incidents', '0', 'incidents'),
    m('infra_cost', '180.00', 'money'),
  ],
  RUSTEN: [
    m('active_subscriptions_at_period_start', '22', 'subscriptions'),
    m('active_subscriptions_at_period_end', '27', 'subscriptions'),
    m('new_subscriptions', '7', 'subscriptions'),
    m('cancellations', '2', 'subscriptions'),
    m('cohort_trials', '25', 'trials'),
    m('cohort_trial_subscriptions', '7', 'subscriptions'),
    m('plan_price_main', '149.00', 'money'),
    m('variable_cost_per_subscription', '38.00', 'money'),
    m('cash_received_in_period', '4023.00', 'money'),
    m('open_receivables', '447.00', 'money'),
    m('support_tickets', '41', 'tickets'),
    m('tickets_per_customer', '1.52', 'ratio'),
    m('support_capacity_monthly', '45', 'tickets'),
    m('first_response_hours', '5.2', 'hours', 'partial'),
    m('incidents', '2', 'incidents'),
    m('infra_cost', '260.00', 'money'),
  ],
  APOLVEN: [
    m('active_subscriptions_at_period_end', '8', 'subscriptions', 'partial', { note: 'Produto em lançamento' }),
    m('new_subscriptions', '8', 'subscriptions', 'partial'),
    m('cancellations', null, 'subscriptions', 'unavailable'),
    m('variable_cost_per_subscription', null, 'money', 'unavailable'),
  ],
};

export const DEMO_CANCEL_REASONS = {
  ORBI: [{ reason: 'Preço', share_pct: '33' }, { reason: 'Falta de recurso (estoque)', share_pct: '33' }, { reason: 'Fechou o negócio', share_pct: '17' }, { reason: 'Não informado', share_pct: '17' }],
  TORVEN: [{ reason: 'Dificuldade de uso', share_pct: '50' }, { reason: 'Preço', share_pct: '50' }],
  RUSTEN: [{ reason: 'Instabilidade na impressão de pedidos', share_pct: '50' }, { reason: 'Não informado', share_pct: '50' }],
};

export function demoMetrics(productCode, period) {
  const metrics = DATA[productCode];
  if (!metrics) return null;
  return {
    schema_version: '1.0',
    product_code: productCode,
    period,
    fetched_at: new Date().toISOString(),
    currency: 'BRL',
    metrics,
    cancel_reasons: DEMO_CANCEL_REASONS[productCode] || [],
    limitations: ['Demonstração — dados fictícios', 'Custos fixos e rateios não incluídos'],
  };
}

export const DEMO_DOCUMENTS = [
  {
    title: 'Política comercial de descontos (DEMO)',
    product: null,
    content: 'Descontos promocionais em planos mensais limitados a 15% por até 3 meses. Descontos acima de 10% exigem aprovação do owner. Não acumular com outros cupons. Toda campanha deve declarar público, período e custo máximo.',
    rules: { max_discount_pct: 15, approval_above_pct: 10, max_duration_months: 3 },
  },
  {
    title: 'Tabela de planos e preços (DEMO)',
    product: null,
    content: 'ORBI Essencial R$ 99,00/mês; TORVEN Oficina R$ 129,00/mês; RUSTEN Restaurante R$ 149,00/mês. Anual com 2 meses grátis.',
  },
  {
    title: 'Procedimento de atendimento (DEMO)',
    product: null,
    content: 'Atendimento em horário comercial (8h–18h, seg–sex). Meta de primeira resposta: 4 horas úteis. Capacidade atual: 1 atendente compartilhado entre os produtos.',
  },
  {
    title: 'Metas do trimestre (DEMO)',
    product: null,
    content: 'Meta: +20% de assinaturas ativas somando os produtos; cancelamento mensal abaixo de 5%; orçamento de marketing do trimestre R$ 1.500,00.',
    expires_in_days: 90,
  },
];

// Configuração comercial fictícia da Área Master (somente decisões de demonstração)
export function demoMasterConfig(productCode) {
  const p = String(productCode).toLowerCase();
  const price = { orbi: 99, torven: 129, rusten: 149, apolven: 79 }[p] || 99;
  return {
    kind: 'master_config', product: p, demo: true,
    plans: [
      { id: `demo-${p}-essencial`, code: 'ESSENCIAL', name: 'Essencial', monthly_price: String(price), annual_price: String(price * 10), active: true, tenants: 40 },
      { id: `demo-${p}-pro`, code: 'PRO', name: 'Profissional', monthly_price: String(price + 60), annual_price: String((price + 60) * 10), active: true, tenants: 12 },
    ],
    settings: { trial_default: '15_DAYS', grace_days: 5, renewal_notice_days: 7, signup_enabled: true, support_hours: '8h–18h, seg–sex' },
    overrides: {},
    limitations: ['Demonstração — dados fictícios'],
  };
}
