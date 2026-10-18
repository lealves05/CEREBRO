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
