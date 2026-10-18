// Mudança para a VPS: snapshot do banco → banco novo (scripts/importar-snapshot.js) e passe do Master oculto.
// Cada caso roda em processo próprio, com banco em arquivo temporário (não usa o banco em memória dos outros testes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cerebro-vps-'));
const node = (args, env = {}) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, LORLER_ENV: 'test', ...env } });
const contar = (file) => {
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const out = {};
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations'").all()) out[name] = db.prepare(`SELECT COUNT(*) AS c FROM "${name}"`).get().c;
    return out;
  } finally { db.close(); }
};

test('snapshot do banco vira um banco novo igual (mesmas tabelas e linhas) e não sobrescreve sem --substituir', () => {
  const origem = path.join(tmp, 'origem.db');
  const criar = node(['--input-type=module', '-e', `
    const { openDb, insert, uuid, now } = await import('./src/db.js');
    const { createOrganization, addMember } = await import('./src/seed.js');
    openDb(${JSON.stringify(origem)});
    const org = createOrganization('LORLER');
    const id = uuid();
    insert('users', { id, email: 'dono@lorler.test', display_name: 'dono', password_hash: 'x', status: 'active', created_at: now() });
    addMember(org, id, 'owner');
    const { getDb } = await import('./src/db.js'); getDb().exec('PRAGMA wal_checkpoint(TRUNCATE)');
  `], { LORLER_DB_FILE: origem });
  assert.equal(criar.status, 0, criar.stderr);

  const snap = path.join(tmp, 'snap.json');
  const exp = node(['scripts/nuvem.js', 'exportar', snap], { LORLER_DB_FILE: origem });
  assert.equal(exp.status, 0, exp.stderr);

  const destino = path.join(tmp, 'vps', 'lorler.db');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const imp = node(['scripts/importar-snapshot.js', snap, destino], { LORLER_DB_FILE: destino });
  assert.equal(imp.status, 0, imp.stderr);
  const r = JSON.parse(imp.stdout.trim().split('\n').pop());
  assert.equal(r.ok, true);
  assert.equal(r.usuarios, 1);
  assert.equal(r.avisos_chave_estrangeira, 0);
  assert.deepEqual(contar(destino), contar(origem));

  const de_novo = node(['scripts/importar-snapshot.js', snap, destino], { LORLER_DB_FILE: destino });
  assert.equal(de_novo.status, 3, 'sem --substituir o banco existente fica intacto');
  const troca = node(['scripts/importar-snapshot.js', snap, destino, '--substituir'], { LORLER_DB_FILE: destino });
  assert.equal(troca.status, 0, troca.stderr);
  assert.ok(fs.readdirSync(path.dirname(destino)).some((f) => f.startsWith('lorler.db.antes-')), 'o banco anterior é guardado ao lado');
});

test('arquivo que não é snapshot é recusado', () => {
  const ruim = path.join(tmp, 'ruim.json'); fs.writeFileSync(ruim, '{"x":1}');
  const r = node(['scripts/importar-snapshot.js', ruim, path.join(tmp, 'nao.db')]);
  assert.equal(r.status, 2);
  assert.equal(fs.existsSync(path.join(tmp, 'nao.db')), false);
});

test('Master oculto: o cérebro manda o passe da porta (cookie lorler_porta) só quando configurado e válido', () => {
  const script = `
    const { masterHooks, testConnection } = await import('./src/connectors/master.js');
    const vistos = [];
    masterHooks.fetch = async (url, opts) => { vistos.push(opts.headers.Cookie || null); return new Response(JSON.stringify({ token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
    await testConnection().catch(() => {});
    console.log(JSON.stringify(vistos));
  `;
  const base = { LORLER_MASTER_URL: 'http://localhost:9', LORLER_MASTER_USERNAME: 'cerebro', LORLER_SECRET_MASTER_PASSWORD: 'senha-x-12345', LORLER_CONNECTOR_ALLOW_LOCALHOST: 'true', LORLER_DB_FILE: ':memory:' };
  const com = node(['--input-type=module', '-e', script], { ...base, LORLER_MASTER_PORTA: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd' });
  assert.equal(com.status, 0, com.stderr);
  const c1 = JSON.parse(com.stdout.trim().split('\n').pop());
  assert.ok(c1.length > 0 && c1.every((c) => c === 'lorler_porta=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcd'));
  const sem = node(['--input-type=module', '-e', script], { ...base, LORLER_MASTER_PORTA: '' });
  assert.ok(JSON.parse(sem.stdout.trim().split('\n').pop()).every((c) => c === null));
  const injecao = node(['--input-type=module', '-e', script], { ...base, LORLER_MASTER_PORTA: 'abc; outro=1\r\nX: y' });
  assert.ok(JSON.parse(injecao.stdout.trim().split('\n').pop()).every((c) => c === null), 'valor fora do formato não vira cabeçalho');
});

test('nuvem: saída de dados exige o token, devolve todas as tabelas e congela as gravações', async () => {
  const { exportSnapshotDO, unfreezeDO, isFrozen } = await import('../worker/snapshot.js');
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE TABLE schema_migrations (version TEXT); INSERT INTO schema_migrations VALUES ('001_init.sql'); CREATE TABLE users (id TEXT, email TEXT); INSERT INTO users VALUES ('u1','a@b.c'),('u2','d@e.f'); CREATE TABLE notas (id INTEGER, dado BLOB); INSERT INTO notas VALUES (1, x'0102');");
  const kv = new Map(); let alarme = 0;
  const ctx = { storage: {
    sql: { exec: (sql, ...p) => { const st = db.prepare(sql); const rows = /^\s*select/i.test(sql) ? st.all(...p).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v]))) : (st.run(...p), []); return { toArray: () => rows }; } },
    kv: { get: (k) => kv.get(k), put: (k, v) => kv.set(k, v), delete: (k) => kv.delete(k) },
    setAlarm: async (t) => { alarme = t; },
  } };
  const obj = { ctx, env: { LORLER_IMPORT_TOKEN: 'token-certo-123' } };
  const req = (url, token, method = 'GET') => new Request(url, { method, headers: token ? { 'x-import-token': token } : {} });

  assert.equal((await exportSnapshotDO(obj, req('https://x/api/admin/export-snapshot?congelar=1', 'errado'))).status, 403);
  assert.equal((await exportSnapshotDO(obj, req('https://x/api/admin/export-snapshot?congelar=1'))).status, 403);
  assert.equal(isFrozen(ctx), false, 'token errado não congela');

  const r = await exportSnapshotDO(obj, req('https://x/api/admin/export-snapshot?congelar=1', 'token-certo-123'));
  assert.equal(r.status, 200);
  const snap = await r.json();
  assert.deepEqual(snap.tables.map((t) => t.name), ['users', 'notas']);
  assert.equal(snap.tables[0].rows.length, 2);
  assert.equal(snap.tables[1].rows[0].dado, 'AQI=', 'binário sai em base64');
  assert.deepEqual(snap.migrations, ['001_init.sql']);
  assert.ok(snap.frozen_at && isFrozen(ctx));

  assert.equal((await unfreezeDO(obj, req('https://x/api/admin/unfreeze', 'errado', 'POST'))).status, 403);
  assert.equal(isFrozen(ctx), true);
  assert.equal((await unfreezeDO(obj, req('https://x/api/admin/unfreeze', 'token-certo-123', 'POST'))).status, 200);
  assert.equal(isFrozen(ctx), false);
  assert.ok(alarme > 0, 'a fila volta a rodar');
});
