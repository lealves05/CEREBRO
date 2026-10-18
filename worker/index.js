// Central de Decisões LORLER no Cloudflare: Worker na borda + Durable Object com SQLite (o "cérebro").
// - Arquivos do painel (public/) servidos como assets estáticos.
// - /api/* e /healthz vão para um único Durable Object, que guarda o banco SQLite e roda a fila dos agentes.
import { DurableObject } from 'cloudflare:workers';
import { platform } from '../src/platform.js';
import { refreshConfig } from '../src/config.js';
import { setDriver, migrate, q } from '../src/db.js';
import { makeReq, makeRes } from './shim.js';
import { importSnapshot } from './snapshot.js';
import m001 from '../migrations/001_init.sql';
import m002 from '../migrations/002_marketing_instagram.sql';
import m003 from '../migrations/003_whatsapp.sql';
import m004 from '../migrations/004_conversation.sql';
import m005 from '../migrations/005_assistant.sql';
import pricing from '../config/pricing.json';

const MIGRATIONS = [
  { name: '001_init.sql', sql: m001 }, { name: '002_marketing_instagram.sql', sql: m002 },
  { name: '003_whatsapp.sql', sql: m003 }, { name: '004_conversation.sql', sql: m004 }, { name: '005_assistant.sql', sql: m005 },
];
const HEARTBEAT_MS = 2 * 60_000;

function loadEnv(env) {
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string') process.env[k] = v;
  process.env.LORLER_WORKER_IN_PROCESS = 'false';
  refreshConfig();
}

/** Driver sobre o SQLite do Durable Object (API síncrona, mesma linguagem SQL do node:sqlite). */
function doDriver(storage) {
  const clean = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  return {
    prepare(sql) {
      return {
        get: (...p) => storage.sql.exec(sql, ...clean(p)).toArray()[0],
        all: (...p) => storage.sql.exec(sql, ...clean(p)).toArray(),
        run: (...p) => { const c = storage.sql.exec(sql, ...clean(p)); c.toArray(); return { changes: c.rowsWritten }; },
      };
    },
    exec(sql) { storage.sql.exec(sql); },
    transaction(fn) { return storage.transactionSync(fn); },
    close() {},
  };
}

export class Cerebro extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    loadEnv(env);
    platform.migrations = MIGRATIONS;
    platform.pricing = pricing;
    platform.keyStore = { get: () => ctx.storage.kv.get('encryption_key') || null, set: (v) => ctx.storage.kv.put('encryption_key', v) };
    platform.wake = () => { ctx.storage.setAlarm(Date.now() + 250); };
    platform.defer = (p) => ctx.waitUntil(p);
    setDriver(doDriver(ctx.storage));
    this.ready = ctx.blockConcurrencyWhile(async () => this.init());
  }

  async init() {
    migrate();
    const { ensureSeed } = await import('../src/seed.js');
    const routes = await import('../src/api/routes.js');
    ensureSeed();
    if (!q.get('SELECT id FROM users LIMIT 1') && this.env.LORLER_SETUP_TOKEN) routes.setupState.token = this.env.LORLER_SETUP_TOKEN;
    const { dispatch } = await import('../src/app.js');
    this.dispatch = dispatch;
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    if (url.pathname === '/api/admin/import-snapshot' && request.method === 'POST') return importSnapshot(this, request);
    const req = makeReq(request, url);
    const res = makeRes(req);
    const body = ['GET', 'HEAD'].includes(request.method) ? null : Buffer.from(await request.arrayBuffer());
    const handled = await this.dispatch(req, res, { rawBody: body });
    if (handled === false) return new Response('Not found', { status: 404 });
    return res.done;
  }

  async alarm() {
    await this.ready;
    const { drainQueue } = await import('../src/orchestrator/engine.js');
    let r = { pending: 0 };
    try { r = await drainQueue({ concurrency: 2, maxMs: 12 * 60_000 }); } catch (e) { console.error('[alarme]', e.message); }
    await this.ctx.storage.setAlarm(Date.now() + (r.pending > 0 ? 1000 : HEARTBEAT_MS));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') {
      const stub = env.CEREBRO.get(env.CEREBRO.idFromName('lorler'));
      const res = await stub.fetch(request);
      if (url.pathname !== '/healthz') return res;
      const out = new Response(res.body, res);
      out.headers.set('x-lorler-runtime', 'cloudflare');
      return out;
    }
    return env.ASSETS.fetch(request);
  },
};
