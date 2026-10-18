// Ambiente de teste isolado: banco em memória, provedor de demonstração rápido, servidor em porta aleatória.
process.env.LORLER_DB_FILE = ':memory:';
process.env.LORLER_DEMO_FAST = '1';
process.env.LORLER_AI_PROVIDER = 'demo';
process.env.LORLER_DEMO_MODE = 'true';
process.env.LORLER_ENV = 'test';
process.env.LORLER_EVENTS_HMAC_SECRET = 'segredo-de-teste-hmac';

const { openDb, q, insert, uuid, now } = await import('../src/db.js');
const { createOrganization, addMember } = await import('../src/seed.js');
const { hashPassword } = await import('../src/auth/auth.js');
const { createServer } = await import('../src/server.js');
const engine = await import('../src/orchestrator/engine.js');

openDb(':memory:');
export const orgA = createOrganization('LORLER');
export const orgB = createOrganization('Outra Empresa Teste', { withDemoDocs: false });

export function createUser(orgId, email, role, { products = true } = {}) {
  const id = uuid();
  insert('users', { id, email, display_name: email.split('@')[0], password_hash: hashPassword('SenhaTeste123'), status: 'active', created_at: now() });
  if (orgId) addMember(orgId, id, role, { allProducts: products });
  return id;
}

let server; let base;
export async function startServer() {
  if (server) return base;
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}
export function stopServer() { server?.close(); server = null; }

export async function login(email, password = 'SenhaTeste123') {
  const b = await startServer();
  const res = await fetch(`${b}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  const data = await res.json();
  if (!res.ok) throw new Error(`login falhou: ${JSON.stringify(data)}`);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const client = {
    cookie, csrf: data.csrf,
    async call(method, path, body, { csrf = true } = {}) {
      const headers = { cookie };
      if (body !== undefined) headers['content-type'] = 'application/json';
      if (csrf && method !== 'GET') headers['x-csrf-token'] = client.csrf;
      const r = await fetch(`${b}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
  };
  return client;
}

export function productIds(orgId, codes = ['ORBI', 'TORVEN', 'RUSTEN']) {
  return codes.map((c) => q.get('SELECT id FROM products WHERE organization_id = ? AND code = ?', orgId, c).id);
}

export const period = { start: '2026-09-01T03:00:00.000Z', end_exclusive: '2026-10-01T03:00:00.000Z' };

// Processa a fila até esvaziar (sem depender do intervalo do worker)
export async function drain() {
  for (let i = 0; i < 20; i++) {
    const id = engine.claimNextRun('test-worker');
    if (!id) return;
    await engine.processRun(id, 'test-worker');
  }
}

export async function createDecision(client, question, extra = {}) {
  const r = await client.call('POST', '/api/decisions', { question, product_ids: productIds(orgA), decision_type: 'misto', mode: 'demo', period, ...extra });
  if (r.status !== 202) throw new Error(`criação falhou: ${JSON.stringify(r.body)}`);
  await drain();
  return r.body;
}

export { q, insert, uuid, now, engine };
