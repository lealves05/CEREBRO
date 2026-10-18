// Objetos req/res no formato do Node para reaproveitar a API (src/app.js) dentro do Durable Object.
const enc = new TextEncoder();
const toBytes = (c) => (c == null ? new Uint8Array(0) : typeof c === 'string' ? enc.encode(c) : c instanceof Uint8Array ? c : enc.encode(String(c)));

export function makeReq(request, rawUrl) {
  const headers = {};
  for (const [k, v] of request.headers) headers[k.toLowerCase()] = v;
  const listeners = { close: [] };
  const req = {
    method: request.method,
    url: rawUrl.pathname + rawUrl.search,
    headers,
    socket: { remoteAddress: headers['cf-connecting-ip'] || '' },
    on(ev, cb) { (listeners[ev] ||= []).push(cb); return req; },
    _emit(ev) { for (const cb of listeners[ev] || []) { try { cb(); } catch { /* */ } } listeners[ev] = []; },
  };
  request.signal?.addEventListener?.('abort', () => req._emit('close'));
  return req;
}

export function makeRes(req) {
  let resolve; const done = new Promise((r) => { resolve = r; });
  const headers = new Headers();
  const chunks = [];
  let writer = null;
  const res = {
    statusCode: 200, headersSent: false, done,
    setHeader(k, v) { if (Array.isArray(v)) { headers.delete(k); v.forEach((x) => headers.append(k, String(x))); } else headers.set(k, String(v)); },
    getHeader(k) { return headers.get(k); },
    removeHeader(k) { headers.delete(k); },
    writeHead(status, h = {}) {
      res.statusCode = status;
      for (const [k, v] of Object.entries(h)) res.setHeader(k, v);
      res.headersSent = true;
      if (String(headers.get('content-type') || '').includes('text/event-stream')) {
        const ts = new TransformStream();
        writer = ts.writable.getWriter();
        resolve(new Response(ts.readable, { status, headers }));
      }
      return res;
    },
    write(chunk) {
      if (writer) { writer.write(toBytes(chunk)).catch(() => req._emit('close')); return true; }
      chunks.push(toBytes(chunk)); return true;
    },
    end(chunk) {
      if (chunk != null) res.write(chunk);
      if (writer) { writer.close().catch(() => {}); req._emit('close'); return res; }
      res.headersSent = true;
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const body = new Uint8Array(total); let o = 0; for (const c of chunks) { body.set(c, o); o += c.length; }
      const noBody = [101, 204, 205, 304].includes(res.statusCode);
      resolve(new Response(noBody ? null : body, { status: res.statusCode, headers }));
      return res;
    },
  };
  return res;
}
