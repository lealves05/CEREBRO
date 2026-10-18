// Serviço de cálculo determinístico (ferramenta calculate_scenario).
// Agentes interpretam resultados; nunca calculam valores financeiros por conta própria.
import { toCents, fromCents } from '../lib/util.js';

const unavailable = (reason) => ({ available: false, reason });

function pct(numer, denom, digits = 4) {
  if (denom === 0 || denom === 0n) return null;
  return (Number(numer) / Number(denom) * 100).toFixed(digits);
}

export const FORMULAS = {
  discount_scenario: {
    description: 'Preço com desconto, contribuição por assinatura antes/depois e redução relativa',
    inputs: ['price', 'discount_pct', 'variable_cost'],
    run({ price, discount_pct, variable_cost }) {
      const p = toCents(price); const c = toCents(variable_cost); const d = Number(discount_pct);
      if (p === null || c === null || !Number.isFinite(d) || d < 0 || d > 100) return unavailable('Entradas inválidas (preço, custo variável ou desconto).');
      // preço com desconto arredondado ao centavo (half-up)
      const discounted = (p * BigInt(Math.round((100 - d) * 100)) + 5000n) / 10000n;
      const before = p - c; const after = discounted - c;
      const reduction = before === 0n ? null : pct(before - after, before, 2);
      const extraVolume = after <= 0n ? null : pct(before - after, after, 2);
      return {
        available: true,
        formula: [
          `Preço com desconto = ${fromCents(p)} × (1 − ${d / 100}) = ${fromCents(discounted)}`,
          `Contribuição anterior = ${fromCents(p)} − ${fromCents(c)} = ${fromCents(before)}`,
          `Contribuição com desconto = ${fromCents(discounted)} − ${fromCents(c)} = ${fromCents(after)}`,
          reduction === null ? 'Redução relativa indisponível (contribuição anterior igual a zero)' : `Redução relativa = (${fromCents(before)} − ${fromCents(after)}) ÷ ${fromCents(before)} × 100 ≈ ${reduction}%`,
          extraVolume === null ? 'Volume adicional de equilíbrio indisponível (contribuição com desconto ≤ 0)' : `Volume adicional para manter a contribuição total ≈ ${extraVolume}%`,
        ],
        result: {
          discounted_price: fromCents(discounted),
          contribution_before: fromCents(before),
          contribution_after: fromCents(after),
          contribution_reduction_pct: reduction,
          breakeven_extra_volume_pct: extraVolume,
          currency: 'BRL',
        },
        limitations: ['Considera apenas custo variável conhecido; custos fixos e efeitos de retenção não incluídos.'],
      };
    },
  },
  conversion_rate: {
    description: 'Conversão de teste = assinaturas da coorte ÷ testes elegíveis da mesma coorte',
    inputs: ['cohort_subscriptions', 'cohort_trials'],
    run({ cohort_subscriptions, cohort_trials }) {
      const s = Number(cohort_subscriptions); const t = Number(cohort_trials);
      if (!Number.isInteger(s) || !Number.isInteger(t) || s < 0 || t < 0) return unavailable('Contagens inválidas.');
      if (t === 0) return unavailable('Denominador zero: não há testes elegíveis na coorte.');
      return { available: true, formula: [`Conversão = ${s} ÷ ${t} × 100`], result: { conversion_pct: pct(s, t, 2) } };
    },
  },
  churn_rate: {
    description: 'Cancelamento de clientes = cancelamentos no período ÷ base ativa no início do período',
    inputs: ['cancellations', 'active_at_start'],
    run({ cancellations, active_at_start }) {
      const c = Number(cancellations); const b = Number(active_at_start);
      if (!Number.isInteger(c) || !Number.isInteger(b) || c < 0 || b < 0) return unavailable('Contagens inválidas.');
      if (b === 0) return unavailable('Denominador zero: base inicial vazia.');
      return { available: true, formula: [`Cancelamento (clientes) = ${c} ÷ ${b} × 100`], result: { churn_pct: pct(c, b, 2), basis: 'clientes' } };
    },
  },
  contribution: {
    description: 'Contribuição = receita definida − custos variáveis conhecidos (não é lucro líquido)',
    inputs: ['revenue', 'variable_costs'],
    run({ revenue, variable_costs }) {
      const r = toCents(revenue); const c = toCents(variable_costs);
      if (r === null || c === null) return unavailable('Valores monetários inválidos.');
      return {
        available: true,
        formula: [`Contribuição = ${fromCents(r)} − ${fromCents(c)} = ${fromCents(r - c)}`],
        result: { contribution: fromCents(r - c), margin_pct: r === 0n ? null : pct(r - c, r, 2), currency: 'BRL' },
        limitations: ['Não inclui custos fixos nem custos ausentes; não deve ser apresentado como lucro líquido.'],
      };
    },
  },
  capacity_check: {
    description: 'Compara chamados previstos com a capacidade mensal de atendimento',
    inputs: ['expected_new_customers', 'tickets_per_customer', 'current_tickets', 'monthly_capacity'],
    run({ expected_new_customers, tickets_per_customer, current_tickets, monthly_capacity }) {
      const n = Number(expected_new_customers); const t = Number(tickets_per_customer);
      const cur = Number(current_tickets); const cap = Number(monthly_capacity);
      if (![n, t, cur, cap].every(Number.isFinite) || cap <= 0) return unavailable('Entradas inválidas ou capacidade não informada.');
      const projected = cur + n * t;
      return {
        available: true,
        formula: [`Chamados projetados = ${cur} + ${n} × ${t} = ${projected.toFixed(1)}`, `Utilização = ${projected.toFixed(1)} ÷ ${cap} × 100`],
        result: { projected_tickets: projected.toFixed(1), utilization_pct: (projected / cap * 100).toFixed(1), over_capacity: projected > cap },
      };
    },
  },
};

export function calculate(formula, inputs) {
  const f = FORMULAS[formula];
  if (!f) return unavailable(`Fórmula não cadastrada: ${formula}`);
  return { formula_code: formula, inputs, ...f.run(inputs || {}) };
}
