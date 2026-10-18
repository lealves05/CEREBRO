// Acesso ao banco (SQLite embutido do Node — node:sqlite). Sem dependências nativas externas.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT, config } from './config.js';
import { platform } from './platform.js';

// Driver: no Node usa node:sqlite (DatabaseSync); no Cloudflare o Worker injeta um driver sobre o SQLite do
// Durable Object (setDriver). Interface: prepare(sql) -> { get, all, run }, exec(sql), close(), transaction?(fn).
let db = null;
export function setDriver(driver) { db = driver; }

export function uuid() { return crypto.randomUUID(); }
export function now() { return new Date().toISOString(); }
export function addMs(ms, from = Date.now()) { return new Date(from + ms).toISOString(); }

export function openDb(file = config.dbFile) {
  if (db) return db;
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule('node:sqlite'); // carregado só no Node
  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  migrate(db);
  return db;
}

export function getDb() { return db || openDb(); }
export function hasDb() { return !!db; }

export function closeDb() { if (db) { db.close(); db = null; } }

export function migrationFiles() {
  if (platform.migrations) return platform.migrations;
  const dir = path.join(ROOT, 'migrations');
  return fs.readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f) && !f.endsWith('.down.sql')).sort().map((name) => ({ name, sql: fs.readFileSync(path.join(dir, name), 'utf8') }));
}

export function migrate(conn = db) {
  conn.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(conn.prepare('SELECT version FROM schema_migrations').all().map((r) => r.version));
  for (const { name: f, sql } of migrationFiles()) {
    if (applied.has(f)) continue;
    const apply = () => { conn.exec(sql); conn.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(f, now()); };
    try {
      if (conn.transaction) conn.transaction(apply);
      else { conn.exec('BEGIN'); try { apply(); conn.exec('COMMIT'); } catch (e) { conn.exec('ROLLBACK'); throw e; } }
    } catch (e) {
      throw new Error(`Falha na migration ${f}: ${e.message}`);
    }
  }
}

// Helpers
export const q = {
  get: (sql, ...p) => getDb().prepare(sql).get(...p),
  all: (sql, ...p) => getDb().prepare(sql).all(...p),
  run: (sql, ...p) => getDb().prepare(sql).run(...p),
};

let txDepth = 0;
export function tx(fn) {
  const conn = getDb();
  if (txDepth > 0) return fn();
  if (conn.transaction) { txDepth++; try { return conn.transaction(fn); } finally { txDepth--; } }
  conn.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const r = fn();
    txDepth--;
    conn.exec('COMMIT');
    return r;
  } catch (e) {
    txDepth--;
    try { conn.exec('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  }
}

export function insert(table, row) {
  const keys = Object.keys(row);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  getDb().prepare(sql).run(...keys.map((k) => normalize(row[k])));
  return row;
}

function normalize(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

export function json(v, fallback = null) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
