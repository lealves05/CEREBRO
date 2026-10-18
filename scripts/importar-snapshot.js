// Cria um banco SQLite novo a partir de um snapshot JSON (o que sai de "node scripts/nuvem.js trazer" ou "exportar").
// Usado na mudança para a VPS: o banco é montado com as migrations deste código e recebe todas as linhas do snapshot.
//   node scripts/importar-snapshot.js <snapshot.json> <banco.db> [--substituir]
// Sem --substituir, recusa se o banco já existir (nunca apaga dados por engano). Com --substituir, o banco antigo é
// renomeado para <banco>.antes-<data> (não é apagado).
import fs from 'node:fs';
import path from 'node:path';

const [arq, destino, ...flags] = process.argv.slice(2);
if (!arq || !destino) { console.error('Uso: node scripts/importar-snapshot.js <snapshot.json> <banco.db> [--substituir]'); process.exit(2); }
const SKIP = new Set(['schema_migrations', 'sqlite_sequence']);

const snap = JSON.parse(fs.readFileSync(arq, 'utf8'));
if (!Array.isArray(snap?.tables)) { console.error('Arquivo não é um snapshot do cérebro (falta "tables").'); process.exit(2); }

const alvo = path.resolve(destino);
if (fs.existsSync(alvo)) {
  if (!flags.includes('--substituir')) { console.error(`O banco ${alvo} já existe. Use --substituir para trocar (o antigo é guardado ao lado).`); process.exit(3); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const suf of ['', '-wal', '-shm']) if (fs.existsSync(alvo + suf)) fs.renameSync(alvo + suf, `${alvo}.antes-${stamp}${suf}`);
  console.log(`Banco anterior guardado como ${alvo}.antes-${stamp}`);
}

process.env.LORLER_DB_FILE = alvo;
const { openDb, getDb, closeDb } = await import('../src/db.js');
openDb(alvo); // cria o arquivo e aplica as migrations deste código
const db = getDb();
const counts = {}; let total = 0; const ignoradas = [];
db.exec('PRAGMA foreign_keys = OFF');
db.exec('BEGIN');
try {
  for (const t of snap.tables) {
    if (!t?.name || SKIP.has(t.name) || !/^[a-z_][a-z0-9_]*$/i.test(t.name)) continue;
    const cols = new Set(db.prepare(`PRAGMA table_info(${t.name})`).all().map((c) => c.name));
    if (!cols.size) { ignoradas.push(t.name); continue; }
    let n = 0;
    for (const row of t.rows || []) {
      const keys = Object.keys(row).filter((k) => cols.has(k));
      if (!keys.length) continue;
      db.prepare(`INSERT OR REPLACE INTO ${t.name} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map((k) => (row[k] === undefined ? null : typeof row[k] === 'boolean' ? (row[k] ? 1 : 0) : row[k])));
      n++;
    }
    counts[t.name] = n; total += n;
  }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); closeDb(); fs.rmSync(alvo, { force: true }); console.error(`Falha ao importar: ${e.message}`); process.exit(1); }
db.exec('PRAGMA foreign_keys = ON');
const fk = db.prepare('PRAGMA foreign_key_check').all();
const { ensureSeed } = await import('../src/seed.js');
ensureSeed();
const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
closeDb();
console.log(JSON.stringify({ ok: true, origem: snap.source || null, exportado_em: snap.exported_at || null, tabelas: Object.keys(counts).length, registros: total, usuarios: users, avisos_chave_estrangeira: fk.length, ignoradas, counts }));
