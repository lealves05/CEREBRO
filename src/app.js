// Despacho da API, independente de plataforma: usado pelo servidor Node (server.js) e pelo Cloudflare Worker
// (worker/index.js), que entrega objetos req/res compatíveis.
import { config } from './config.js';
import { parseCookies, readJson, securityHeaders, sendJson, sendError, newRequestId } from './http/http.js';
import { sessionFromToken, checkCsrf } from './auth/auth.js';
import { buildContext } from './auth/authz.js';
import { router, handleSse, handleOrgSse } from './api/routes.js';
import { AppError } from './lib/util.js';

/** Trata /healthz e /api/*. rawBody: Buffer já lido (Worker) ou null (Node lê do req). Retorna false se não for da API. */
export async function dispatch(req, res, { rawBody = null } = {}) {
  const requestId = newRequestId();
  securityHeaders(res);
  res.setHeader('X-Request-Id', requestId);
  const url = new URL(req.url, 'http://localhost');
  if (config.cookieSecure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return true; }
  if (!url.pathname.startsWith('/api/')) return false;
  try {
    const token = parseCookies(req.headers.cookie || '').lorler_session;
    const sseMatch = /^\/api\/runs\/([^/]+)\/events$/.exec(url.pathname);
    if (sseMatch && req.method === 'GET') {
      const s = sessionFromToken(token);
      if (!s) throw new AppError(401, 'unauthenticated', 'Sessão inválida.');
      handleSse(req, res, buildContext(s, req.headers['x-org-id']), sseMatch[1]); return true;
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const s = sessionFromToken(token);
      if (!s) throw new AppError(401, 'unauthenticated', 'Sessão inválida.');
      handleOrgSse(req, res, buildContext(s, req.headers['x-org-id'])); return true;
    }
    const route = router.match(req.method, url.pathname);
    if (!route) throw new AppError(404, 'not_found', 'Rota inexistente.');
    let body = {}; let raw = Buffer.alloc(0);
    if (req.method !== 'GET') {
      if (rawBody) {
        raw = rawBody;
        if (raw.length > (route.opts.bigBody ? 1024 * 1024 : 256 * 1024)) throw new AppError(413, 'payload_too_large', 'Requisição grande demais.');
        if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw new AppError(400, 'invalid_json', 'JSON inválido.'); } }
      } else ({ body, raw } = await readJson(req, route.opts.bigBody ? 1024 * 1024 : undefined));
    }
    let ctx = null;
    if (!route.opts.public) {
      const s = sessionFromToken(token);
      if (!s) throw new AppError(401, 'unauthenticated', 'Sessão inválida ou expirada.');
      if (req.method !== 'GET' && !route.opts.noCsrf) checkCsrf(s, req.headers['x-csrf-token']);
      ctx = buildContext(s, req.headers['x-org-id']);
    } else if (req.method !== 'GET' && !route.opts.noCsrf) {
      // Rotas públicas que alteram estado exigem origem do próprio painel
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw new AppError(403, 'forbidden', 'Origem não permitida.');
    }
    const result = await route.handler({ req, res, url, params: route.params, body, raw, ctx, token, requestId });
    if (res.headersSent) return true;
    if (result && typeof result.status === 'number' && 'data' in result) { sendJson(res, result.status, result.data); return true; }
    sendJson(res, 200, result ?? { ok: true }); return true;
  } catch (err) {
    sendError(res, err, requestId); return true;
  }
}
