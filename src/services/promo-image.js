// Imagem promocional dos sistemas LORLER (feed 1080x1350).
// Com o rsvg-convert na VPS (librsvg2-bin), monta a arte: foto da biblioteca de fundo + faixa escura + título, apoio,
// chamada e o selo do sistema. Sem ele, usa a arte pronta da biblioteca (já é uma peça promocional do sistema).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as mkt from './marketing.js';

const run = promisify(execFile);
export const imgHooks = { fetch: (...a) => fetch(...a), rsvg: null };
const COLORS = { ORBI: ['#7c3aed', '#c026d3'], TORVEN: ['#ea580c', '#f59e0b'], RUSTEN: ['#b91c1c', '#f97316'], APOLVEN: ['#0369a1', '#22d3ee'], ANIBI: ['#15803d', '#84cc16'], CIFREN: ['#0f766e', '#14b8a6'], LORLER: ['#111827', '#6366f1'] };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Quebra o texto em linhas de até `max` caracteres (sem cortar palavra). */
export function wrap(text, max, lines = 4) {
  const out = []; let cur = '';
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '…'); }
  return out;
}

/** SVG da arte. bg = data URL da foto (opcional). */
export function buildSvg({ sistema = 'LORLER', titulo, apoio = '', cta = '', bg = null }) {
  const [c1, c2] = COLORS[sistema] || COLORS.LORLER;
  const t = wrap(titulo, 18, 4); const a = wrap(apoio, 34, 3);
  const ty = 1350 - 330 - (t.length - 1) * 92 - (a.length ? a.length * 52 + 30 : 0);
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1080" height="1350" viewBox="0 0 1080 1350">
<defs>
  <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient>
  <linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0.25" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.88"/></linearGradient>
</defs>
<rect width="1080" height="1350" fill="url(#g)"/>
${bg ? `<image href="${bg}" xlink:href="${bg}" x="0" y="0" width="1080" height="1350" preserveAspectRatio="xMidYMid slice"/>` : `<circle cx="900" cy="220" r="320" fill="#fff" opacity="0.08"/><circle cx="120" cy="560" r="220" fill="#fff" opacity="0.06"/>`}
<rect width="1080" height="1350" fill="url(#v)"/>
<rect x="64" y="64" rx="30" ry="30" width="${60 + sistema.length * 34}" height="72" fill="url(#g)"/>
<text x="${94}" y="113" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" font-weight="700" fill="#fff" letter-spacing="3">${esc(sistema)}</text>
${t.map((l, i) => `<text x="72" y="${ty + i * 92}" font-family="DejaVu Sans, Arial, sans-serif" font-size="80" font-weight="800" fill="#fff">${esc(l)}</text>`).join('\n')}
${a.map((l, i) => `<text x="74" y="${ty + (t.length - 1) * 92 + 80 + i * 52}" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="#e5e7eb">${esc(l)}</text>`).join('\n')}
${cta ? `<rect x="64" y="1170" rx="40" ry="40" width="${Math.min(952, 80 + cta.length * 22)}" height="96" fill="#fff"/><text x="104" y="1232" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" font-weight="700" fill="${c1}">${esc(cta)}</text>` : ''}
<text x="1016" y="1310" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="#fff" opacity="0.7">lorler.com.br</text>
</svg>`;
}

async function rsvgPath() {
  if (imgHooks.rsvg !== null) return imgHooks.rsvg;
  try { await run('rsvg-convert', ['--version'], { timeout: 5000 }); imgHooks.rsvg = 'rsvg-convert'; } catch { imgHooks.rsvg = ''; }
  return imgHooks.rsvg;
}
async function rasterize(svg) {
  const bin = await rsvgPath(); if (!bin) return null;
  return new Promise((resolve) => {
    const p = execFile(bin, ['-f', 'png', '-w', '1080', '-h', '1350'], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024, timeout: 30000 }, (err, stdout) => resolve(err || !stdout?.length ? null : Buffer.from(stdout)));
    p.stdin.end(svg);
  });
}
async function download(url) {
  try {
    const r = await imgHooks.fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 0 && b.length < 12 * 1024 * 1024 ? { buffer: b, mime: (r.headers.get('content-type') || 'image/jpeg').split(';')[0] } : null;
  } catch { return null; }
}

/** Escolhe a peça da biblioteca pelo sistema e pelo tema (quando houver). */
export function pick(sistema, tema = '') {
  const lib = mkt.library().filter((x) => !sistema || x.sistema === sistema);
  if (!lib.length) return null;
  const words = fold(tema).split(/\W+/).filter((w) => w.length > 3);
  const score = (x) => words.reduce((n, w) => n + (fold(`${x.tema} ${x.gancho} ${x.apoio}`).includes(w) ? 1 : 0), 0);
  return words.length ? [...lib].sort((a, b) => score(b) - score(a))[0] : lib[Math.floor(Date.now() / 86400000) % lib.length];
}

/** Gera a imagem. Devolve { buffer, mime, how: 'arte'|'biblioteca', lib }. */
export async function generate({ sistema = 'ORBI', tema = '', titulo = '', apoio = '', cta = '' } = {}) {
  sistema = String(sistema || 'ORBI').toUpperCase();
  const lib = pick(sistema, tema || titulo);
  const head = titulo || lib?.gancho || `${sistema}: gestão simples`;
  const sub = apoio || lib?.apoio || '';
  const chamada = cta || lib?.cta || `Teste grátis: ${sistema.toLowerCase()}.lorler.com.br`;
  const photo = lib ? await download(lib.feed) : null;
  const png = await rasterize(buildSvg({ sistema, titulo: head, apoio: sub, cta: chamada, bg: photo ? `data:${photo.mime};base64,${photo.buffer.toString('base64')}` : null }));
  if (png) return { buffer: png, mime: 'image/png', how: 'arte', lib, titulo: head };
  if (photo) return { buffer: photo.buffer, mime: photo.mime === 'image/png' ? 'image/png' : 'image/jpeg', how: 'biblioteca', lib, titulo: lib.gancho };
  return null;
}
