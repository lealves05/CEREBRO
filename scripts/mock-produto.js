// Servidor de exemplo do contrato de métricas (para testar o conector localmente).
// NÃO é integração real: retorna valores fictícios marcados como tal.
// Uso: node scripts/mock-produto.js ORBI 4001   e no .env: LORLER_CONNECTOR_ALLOW_LOCALHOST=true e LORLER_SECRET_ORBI=token-local
import http from 'node:http';
const product = (process.argv[2] || 'ORBI').toUpperCase();
const port = Number(process.argv[3] || 4001);
const token = process.env.MOCK_TOKEN || 'token-local';
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/lorler/v1/metrics') { res.writeHead(404); return res.end(); }
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401); return res.end('{}'); }
  const body = {
    schema_version: '1.0', product_code: product,
    period: { start: url.searchParams.get('start'), end_exclusive: url.searchParams.get('end_exclusive'), timezone: url.searchParams.get('timezone') },
    fetched_at: new Date().toISOString(), currency: 'BRL',
    metrics: [
      { code: 'active_subscriptions_at_period_start', value: '40', unit: 'subscriptions', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'active_subscriptions_at_period_end', value: '44', unit: 'subscriptions', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'new_subscriptions', value: '6', unit: 'subscriptions', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'cancellations', value: '2', unit: 'subscriptions', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'cohort_trials', value: '20', unit: 'trials', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'cohort_trial_subscriptions', value: '6', unit: 'subscriptions', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'plan_price_main', value: '99.00', unit: 'money', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'variable_cost_per_subscription', value: '25.00', unit: 'money', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'cash_received_in_period', value: '4356.00', unit: 'money', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'support_tickets', value: '30', unit: 'tickets', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'tickets_per_customer', value: '0.7', unit: 'ratio', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
      { code: 'support_capacity_monthly', value: '80', unit: 'tickets', definition_version: '1.0', quality: 'complete', source_ref: 'mock' },
    ],
    limitations: ['Servidor de exemplo — valores fictícios'],
  };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}).listen(port, '127.0.0.1', () => console.log(`Mock ${product} em http://localhost:${port}/lorler/v1/metrics (token: ${token})`));
