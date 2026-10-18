// Testes de unidade: cálculos determinísticos, contrato e segurança dos conectores, orçamento técnico.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgA, uuid } from './helpers.js';
import { calculate } from '../src/services/calculations.js';
import { assertUrlAllowed, validateContract, fetchMetrics } from '../src/connectors/connectors.js';
import { reserveTokens } from '../src/services/budget.js';
import { canonicalJson } from '../src/lib/util.js';

test('cenário de desconto reproduz o exemplo da especificação (R$ 99,00, 10%, custo R$ 25,00)', () => {
  const r = calculate('discount_scenario', { price: '99.00', discount_pct: 10, variable_cost: '25.00' });
  assert.equal(r.result.discounted_price, '89.10');
  assert.equal(r.result.contribution_before, '74.00');
  assert.equal(r.result.contribution_after, '64.10');
  assert.equal(r.result.contribution_reduction_pct, '13.38');
});

test('indicador sem denominador válido retorna indisponível', () => {
  assert.equal(calculate('conversion_rate', { cohort_subscriptions: 3, cohort_trials: 0 }).available, false);
  assert.equal(calculate('churn_rate', { cancellations: 1, active_at_start: 0 }).available, false);
  assert.equal(calculate('formula_inexistente', {}).available, false);
});

test('conector bloqueia HTTP, hosts não autorizados e endereços internos', async () => {
  await assert.rejects(assertUrlAllowed('http://api.exemplo.com'), /HTTPS/);
  await assert.rejects(assertUrlAllowed('https://api.nao-cadastrado.com'), /não autorizado/);
  await assert.rejects(assertUrlAllowed('https://169.254.169.254/latest'), /não autorizado|interno/);
  await assert.rejects(assertUrlAllowed('nota-url'), /inválida/);
});

test('contrato de resposta é validado antes de chegar ao modelo', () => {
  const p = { start: '2026-09-01T03:00:00.000Z', end_exclusive: '2026-10-01T03:00:00.000Z' };
  const ok = { schema_version: '1.0', product_code: 'ORBI', period: p, currency: 'BRL', metrics: [{ code: 'active_subscriptions_at_period_end', value: '100', quality: 'complete' }] };
  assert.deepEqual(validateContract(ok, 'ORBI', p), []);
  assert.ok(validateContract({ ...ok, product_code: 'RUSTEN' }, 'ORBI', p).length);
  assert.ok(validateContract({ ...ok, metrics: [{ code: 'x', value: 100, quality: 'ótima' }] }, 'ORBI', p).length >= 2);
  assert.ok(validateContract({ ...ok, currency: 'USD' }, 'ORBI', p).length);
});

test('credencial inválida é identificada separadamente (401) e falta de credencial não simula sucesso', async () => {
  process.env.LORLER_SECRET_ORBI = 'token-teste';
  process.env.LORLER_CONNECTOR_ALLOW_LOCALHOST = 'true';
  const { config } = await import('../src/config.js');
  config.connectors.allowInsecureLocalhost = true;
  const integ = { base_url: 'http://localhost:9', secret_ref: 'LORLER_SECRET_ORBI' };
  const p = { start: '2026-09-01T03:00:00.000Z', end_exclusive: '2026-10-01T03:00:00.000Z' };
  await assert.rejects(fetchMetrics(integ, 'ORBI', p, { fetchImpl: async () => new Response('{}', { status: 401 }) }), (e) => e.kind === 'auth');
  await assert.rejects(fetchMetrics(integ, 'ORBI', p, { fetchImpl: async () => new Response('{}', { status: 403 }) }), (e) => e.kind === 'forbidden');
  await assert.rejects(fetchMetrics(integ, 'ORBI', p, { fetchImpl: async () => new Response('nao-json', { status: 200 }) }), (e) => e.kind === 'contract');
  await assert.rejects(fetchMetrics({ ...integ, secret_ref: 'LORLER_SECRET_NAOEXISTE' }, 'ORBI', p), (e) => e.kind === 'config');
  config.connectors.allowInsecureLocalhost = false;
});

test('orçamento técnico: reservas concorrentes não ultrapassam o teto', () => {
  const budget = 300000;
  const ok = []; const fail = [];
  for (let i = 0; i < 5; i++) {
    try { reserveTokens(orgA, uuid(), 100000, budget); ok.push(i); } catch { fail.push(i); }
  }
  assert.ok(ok.length <= 3);
  assert.ok(fail.length >= 2);
});

test('JSON canônico independe da ordem das chaves', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 1, e: 0 }] } }), canonicalJson({ a: { c: [3, { e: 0, f: 1 }], d: 2 }, b: 1 }));
});
