// Importação única dos dados do servidor local (PC) para o Durable Object.
// Protegida por LORLER_IMPORT_TOKEN (segredo gerado pelo script de publicação) e permitida uma única vez
// (marca "import_done" no armazenamento do objeto). Substitui todo o banco da nuvem pelo do PC.
import { timingSafeEqual } from 'node:crypto';
import { migrate, q } from '../src/db.js';

const SKIP = new Set(['schema_migrations', 'sqlite_sequence']);

function sameToken(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export async function importSnapshot(obj, request) {
  const { ctx, env } = obj;
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  // sempre consome o corpo antes de responder (responder com o corpo pendente derruba a conexão no proxy)
  const refuse = async (status, error) => { try { await request.arrayBuffer(); } catch { /* */ } return json(status, { error }); };
  if (!env.LORLER_IMPORT_TOKEN || !sameToken(request.headers.get('x-import-token'), env.LORLER_IMPORT_TOKEN)) return refuse(403, 'token inválido');
  if (ctx.storage.kv.get('import_done')) return refuse(409, 'A importação já foi feita.');
  let snap;
  try { snap = await request.json(); } catch { return json(400, { error: 'JSON inválido' }); }
  if (!Array.isArray(snap?.tables)) return json(400, { error: 'formato inválido' });
  const encKey = ctx.storage.kv.get('encryption_key');
  await ctx.storage.deleteAll();
  if (encKey) ctx.storage.kv.put('encryption_key', encKey);
  migrate();
  const counts = {};
  ctx.storage.transactionSync(() => {
    ctx.storage.sql.exec('PRAGMA defer_foreign_keys = ON');
    for (const t of snap.tables) {
      if (!t?.name || SKIP.has(t.name) || !/^[a-z_][a-z0-9_]*$/i.test(t.name)) continue;
      const cols = new Set(ctx.storage.sql.exec(`PRAGMA table_info(${t.name})`).toArray().map((c) => c.name));
      if (!cols.size) continue;
      let n = 0;
      for (const row of t.rows || []) {
        const keys = Object.keys(row).filter((k) => cols.has(k));
        if (!keys.length) continue;
        ctx.storage.sql.exec(`INSERT OR REPLACE INTO ${t.name} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...keys.map((k) => row[k]));
        n++;
      }
      counts[t.name] = n;
    }
  });
  const { ensureSeed } = await import('../src/seed.js');
  ensureSeed();
  ctx.storage.kv.put('import_done', new Date().toISOString());
  await ctx.storage.setAlarm(Date.now() + 2000);
  return json(200, { ok: true, users: q.get('SELECT COUNT(*) AS c FROM users').c, counts });
}

// ---------- saída da nuvem (mudança para a VPS) ----------
// GET  /api/admin/export-snapshot?congelar=1  → todas as tabelas do banco do Durable Object, no mesmo formato do
//      exportSnapshot do PC (scripts/nuvem.js). Com congelar=1 a nuvem passa a recusar gravações (503) e para a fila dos
//      agentes, para nada ser gravado aqui depois da cópia (o WhatsApp da Meta tenta de novo e chega no servidor novo).
// POST /api/admin/unfreeze                    → desfaz o congelamento (se a mudança for cancelada).
// Ambos exigem o x-import-token (LORLER_IMPORT_TOKEN, guardado em data/nuvem.json no PC).
export const isFrozen = (ctx) => !!ctx.storage.kv.get('frozen_at');

export async function exportSnapshotDO(obj, request) {
  const { ctx, env } = obj;
  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (!env.LORLER_IMPORT_TOKEN || !sameToken(request.headers.get('x-import-token'), env.LORLER_IMPORT_TOKEN)) return json(403, { error: 'token inválido' });
  const url = new URL(request.url);
  if (url.searchParams.get('congelar') === '1' && !isFrozen(ctx)) ctx.storage.kv.put('frozen_at', new Date().toISOString());
  const names = ctx.storage.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'schema_migrations' ORDER BY rowid")
    .toArray().map((r) => r.name);
  const tables = names.map((name) => ({
    name,
    rows: ctx.storage.sql.exec(`SELECT * FROM "${name.replace(/"/g, '""')}"`).toArray().map((row) => {
      const o = {};
      for (const [k, v] of Object.entries(row)) o[k] = v instanceof ArrayBuffer ? Buffer.from(v).toString('base64') : v;
      return o;
    }),
  }));
  const migrations = ctx.storage.sql.exec('SELECT version FROM schema_migrations ORDER BY version').toArray().map((r) => r.version);
  return json(200, { exported_at: new Date().toISOString(), source: 'cloudflare-durable-object', frozen_at: ctx.storage.kv.get('frozen_at') || null, migrations, tables });
}

export async function unfreezeDO(obj, request) {
  const { ctx, env } = obj;
  try { await request.arrayBuffer(); } catch { /* */ }
  if (!env.LORLER_IMPORT_TOKEN || !sameToken(request.headers.get('x-import-token'), env.LORLER_IMPORT_TOKEN)) return new Response(JSON.stringify({ error: 'token inválido' }), { status: 403 });
  ctx.storage.kv.delete('frozen_at');
  await ctx.storage.setAlarm(Date.now() + 1000);
  return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
}
