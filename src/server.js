// Central de Decisões LORLER — servidor HTTP (API + painel). Sem dependências externas.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';
import { openDb, q } from './db.js';
import { ensureSeed } from './seed.js';
import { randomToken } from './lib/util.js';
import { securityHeaders } from './http/http.js';
import { setupState } from './api/routes.js';
import { dispatch } from './app.js';
import { startWorker } from './orchestrator/engine.js';
import { startInboxWatcher } from './services/inbox.js';
import { getProvider } from './ai/provider.js';

const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(PUBLIC, 'index.html'); // SPA
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Cache-Control': target.endsWith('.html') ? 'no-store' : 'no-cache' });
    fs.createReadStream(target).pipe(res);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const handled = await dispatch(req, res);
    if (handled === false) { securityHeaders(res); serveStatic(req, res, new URL(req.url, 'http://localhost').pathname); }
  });
}

export function boot() {
  openDb();
  ensureSeed();
  if (!q.get('SELECT id FROM users LIMIT 1')) {
    setupState.token = randomToken(9);
    console.log('\n================ INSTALAÇÃO INICIAL — LORLER ================');
    console.log('Nenhum usuário cadastrado. Abra o painel e informe o código abaixo');
    console.log('para criar o primeiro owner (válido enquanto o servidor estiver aberto):');
    console.log(`\n    CÓDIGO DE INSTALAÇÃO: ${setupState.token}\n`);
    console.log('=============================================================\n');
  }
  const server = createServer();
  server.listen(config.port, config.host, () => {
    console.log(`Central de Decisões LORLER em http://${config.host}:${config.port}`);
    console.log(`Ambiente: ${config.env} | Provedor de IA: ${getProvider().name}${getProvider().name === 'demo' ? ' (DEMONSTRAÇÃO — sem IA real)' : ''} | Dados demo: ${config.demoMode ? 'habilitados' : 'desabilitados'}`);
  });
  if (config.workerInProcess) startWorker();
  startInboxWatcher(); // importa data/inbox/*.md (rotinas agendadas) para a base de conhecimento
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(ROOT, 'src', 'server.js')) boot();
