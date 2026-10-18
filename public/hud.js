// Componentes visuais do Centro de Análise (SVG puro, sem dependências).
const NS = 'http://www.w3.org/2000/svg';
export const SYS_COLORS = { ORBI: '#19e3ff', TORVEN: '#ffb547', RUSTEN: '#ff5fa2', APOLVEN: '#9d8cff' };
export const sysColor = (code) => SYS_COLORS[code] || '#3dffa8';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let uid = 0;

// Linha de tendência compacta com área em degradê
export function sparkline(values, color = '#19e3ff', { w = 120, h = 32 } = {}) {
  const v = (values || []).map((x) => Number(x) || 0);
  if (v.length < 2) return `<svg class="spark" viewBox="0 0 ${w} ${h}"></svg>`;
  const max = Math.max(...v, 1); const min = Math.min(...v, 0);
  const pts = v.map((y, i) => [(i / (v.length - 1)) * w, h - 2 - ((y - min) / (max - min || 1)) * (h - 4)]);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
  const id = `sg${++uid}`;
  const last = pts[pts.length - 1];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity=".45"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs>
    <path d="${d}L${w},${h}L0,${h}Z" fill="url(#${id})"/><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="${color}" class="spark-dot"/></svg>`;
}

// Anel de progresso (0–100) com marcações
export function ring(value, { color = '#19e3ff', size = 120, label = '', sub = '' } = {}) {
  const r = 44; const c = 2 * Math.PI * r; const pct = value == null ? 0 : Math.max(0, Math.min(100, value));
  const ticks = Array.from({ length: 60 }, (_, i) => { const a = (i / 60) * 2 * Math.PI - Math.PI / 2; const r1 = i % 5 ? 52 : 50; return `<line x1="${60 + Math.cos(a) * r1}" y1="${60 + Math.sin(a) * r1}" x2="${60 + Math.cos(a) * 55}" y2="${60 + Math.sin(a) * 55}"/>`; }).join('');
  const col = value == null ? '#6f9aa6' : value >= 75 ? '#3dffa8' : value >= 50 ? '#ffb547' : '#ff4d6a';
  const use = color === 'auto' ? col : color;
  return `<svg class="ring" viewBox="0 0 120 120" width="${size}" height="${size}">
    <g class="ring-ticks" stroke="${use}">${ticks}</g>
    <circle cx="60" cy="60" r="${r}" fill="none" stroke="rgba(25,227,255,.12)" stroke-width="7"/>
    <circle class="ring-val" cx="60" cy="60" r="${r}" fill="none" stroke="${use}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - pct / 100)}" transform="rotate(-90 60 60)" style="filter:drop-shadow(0 0 6px ${use})"/>
    <g class="ring-spin"><circle cx="60" cy="60" r="36" fill="none" stroke="${use}" stroke-opacity=".35" stroke-dasharray="2 6"/></g>
    <text x="60" y="${sub ? 60 : 66}" text-anchor="middle" class="ring-num" fill="#d9fbff">${value == null ? '—' : Math.round(pct)}</text>
    ${sub ? `<text x="60" y="76" text-anchor="middle" class="ring-sub" fill="${use}">${esc(sub)}</text>` : ''}
    ${label ? `<text x="60" y="92" text-anchor="middle" class="ring-lbl">${esc(label)}</text>` : ''}</svg>`;
}
export function animateRings(root) {
  requestAnimationFrame(() => root.querySelectorAll('.ring-val').forEach((c) => { c.style.transition = 'stroke-dashoffset 1.4s cubic-bezier(.2,.8,.2,1)'; c.style.strokeDashoffset = c.dataset.target; }));
}

// Radar comparativo entre sistemas (valores já normalizados 0–1)
export function radar(axes, series, { size = 300 } = {}) {
  const cx = 150; const cy = 150; const R = 108; const N = axes.length;
  const pt = (i, v) => { const a = (i / N) * 2 * Math.PI - Math.PI / 2; return [cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v]; };
  const grid = [0.25, 0.5, 0.75, 1].map((k) => `<polygon points="${axes.map((_, i) => pt(i, k).join(',')).join(' ')}" class="rd-grid"/>`).join('');
  const spokes = axes.map((_, i) => `<line x1="${cx}" y1="${cy}" x2="${pt(i, 1)[0]}" y2="${pt(i, 1)[1]}" class="rd-grid"/>`).join('');
  const labels = axes.map((a, i) => { const [x, y] = pt(i, 1.2); return `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" class="rd-lbl">${esc(a)}</text>`; }).join('');
  const polys = series.map((s) => `<g class="rd-series" data-code="${esc(s.code)}"><polygon points="${s.values.map((v, i) => pt(i, Math.max(0.03, v)).join(',')).join(' ')}" fill="${s.color}" fill-opacity=".14" stroke="${s.color}" stroke-width="1.6" style="filter:drop-shadow(0 0 4px ${s.color})"/>
    ${s.values.map((v, i) => { const [x, y] = pt(i, Math.max(0.03, v)); return `<circle cx="${x}" cy="${y}" r="2.5" fill="${s.color}"/>`; }).join('')}</g>`).join('');
  return `<svg class="radar" viewBox="-20 -10 340 320" width="100%" style="max-width:${size}px"><g class="rd-sweep"><path d="M150,150 L150,42 A108,108 0 0,1 219.4,67.3 Z" fill="url(#rdg)"/></g>
    <defs><linearGradient id="rdg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#19e3ff" stop-opacity=".25"/><stop offset="1" stop-color="#19e3ff" stop-opacity="0"/></linearGradient></defs>
    ${grid}${spokes}${polys}${labels}</svg>`;
}

// Barra de distribuição por situação
const STATUS_LABEL = { ACTIVE: 'Ativas', TRIAL: 'Em teste', PAST_DUE: 'Inadimplentes', PAYMENT_PENDING: 'Pagamento pendente', SUSPENDED: 'Suspensas', CANCELED: 'Canceladas', BLOCKED: 'Bloqueadas' };
const STATUS_COLOR = { ACTIVE: '#3dffa8', TRIAL: '#19e3ff', PAST_DUE: '#ffb547', PAYMENT_PENDING: '#ffb547', SUSPENDED: '#ff4d6a', CANCELED: '#6f9aa6', BLOCKED: '#ff4d6a' };
export function statusBar(status) {
  const entries = Object.entries(status || {}).filter(([, v]) => v > 0);
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return '<div class="sbar empty"></div>';
  return `<div class="sbar">${entries.map(([k, v]) => `<i style="flex:${v};background:${STATUS_COLOR[k] || '#9d8cff'}" title="${esc(STATUS_LABEL[k] || k)}: ${v}"></i>`).join('')}</div>
    <div class="sbar-legend">${entries.map(([k, v]) => `<span><b style="background:${STATUS_COLOR[k] || '#9d8cff'}"></b>${esc(STATUS_LABEL[k] || k)} ${v}</span>`).join('')}</div>`;
}

// Gráfico de fluxo (barras de recebimento + linhas de cadastros e cancelamentos) com mira interativa
export function flowChart(el, { days, cash, signups, cancellations, money }) {
  const W = 1000; const H = 260; const P = { l: 56, r: 46, t: 18, b: 28 };
  const iw = W - P.l - P.r; const ih = H - P.t - P.b; const N = days.length;
  const maxC = Math.max(...cash, 1); const maxL = Math.max(...signups, ...cancellations, 1);
  const x = (i) => P.l + (i + 0.5) * (iw / N);
  const yC = (v) => P.t + ih - (v / maxC) * ih; const yL = (v) => P.t + ih - (v / maxL) * ih;
  const bw = Math.max(2, iw / N - 6);
  const line = (arr) => arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yL(v).toFixed(1)}`).join('');
  const grid = [0, 0.25, 0.5, 0.75, 1].map((k) => { const y = P.t + ih - k * ih; return `<line x1="${P.l}" x2="${W - P.r}" y1="${y}" y2="${y}" class="fc-grid"/><text x="${P.l - 8}" y="${y + 4}" text-anchor="end" class="fc-ax">${money(maxC * k, true)}</text><text x="${W - P.r + 8}" y="${y + 4}" class="fc-ax">${Math.round(maxL * k)}</text>`; }).join('');
  const xl = days.map((d, i) => (i % 5 === 0 || i === N - 1 ? `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="fc-ax">${d.slice(8, 10)}/${d.slice(5, 7)}</text>` : '')).join('');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="flow" preserveAspectRatio="none">
    <defs><linearGradient id="fcb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3dffa8" stop-opacity=".85"/><stop offset="1" stop-color="#3dffa8" stop-opacity=".08"/></linearGradient></defs>
    ${grid}${xl}
    <g class="fc-bars">${cash.map((v, i) => `<rect x="${x(i) - bw / 2}" y="${yC(v)}" width="${bw}" height="${P.t + ih - yC(v)}" fill="url(#fcb)" style="animation-delay:${i * 18}ms"/>`).join('')}</g>
    <path d="${line(signups)}" class="fc-line" stroke="#19e3ff"/><path d="${line(cancellations)}" class="fc-line" stroke="#ff4d6a"/>
    <line class="fc-cross" y1="${P.t}" y2="${P.t + ih}" x1="-10" x2="-10"/></svg>
    <div class="fc-tip hidden"></div>`;
  const svg = el.querySelector('svg'); const tip = el.querySelector('.fc-tip'); const cross = el.querySelector('.fc-cross');
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(N - 1, Math.floor((px - P.l) / (iw / N))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    tip.classList.remove('hidden');
    tip.innerHTML = `<b>${days[i].split('-').reverse().join('/')}</b><span class="g">Recebido ${money(cash[i])}</span><span class="c">Cadastros ${signups[i]}</span><span class="r">Cancelamentos ${cancellations[i]}</span>`;
    const left = (x(i) / W) * r.width; tip.style.left = `${Math.min(r.width - 170, Math.max(0, left + 12))}px`;
  };
  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', () => { tip.classList.add('hidden'); cross.setAttribute('x1', -10); cross.setAttribute('x2', -10); });
}

// Contador animado
export function countUp(root) {
  root.querySelectorAll('[data-count]').forEach((el) => {
    const target = Number(el.dataset.count); const fmt = el.dataset.fmt;
    if (!Number.isFinite(target)) return;
    const from = Number(el.dataset.from || 0); const t0 = performance.now(); const dur = 1200;
    const f = (v) => (fmt === 'money' ? v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : fmt === 'pct' ? `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%` : Math.round(v).toLocaleString('pt-BR'));
    const step = (t) => { const k = Math.min(1, (t - t0) / dur); const e = 1 - (1 - k) ** 3; el.textContent = f(from + (target - from) * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
    el.dataset.from = target;
  });
}

// Histórico (barras) + projeção (linha tracejada com faixa) para o relatório das bases
export function projectionChart({ days, actual, projected, fmt }, money) {
  const W = 900; const H = 220; const P = { l: 54, r: 16, t: 26, b: 26 };
  const a = (actual || []).map((v) => Number(v) || 0); const p = (projected || []).map((v) => Number(v) || 0);
  const N = a.length + p.length; if (!N) return '';
  const max = Math.max(...a, ...p, 1);
  const iw = W - P.l - P.r; const ih = H - P.t - P.b; const bw = iw / N;
  const x = (i) => P.l + (i + 0.5) * bw; const y = (v) => P.t + ih - (v / max) * ih;
  const f = (v) => (fmt === 'money' ? money(v, true) : Math.round(v).toLocaleString('pt-BR'));
  const grid = [0, 0.5, 1].map((k) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(max * k)}" y2="${y(max * k)}" class="fc-grid"/><text x="${P.l - 8}" y="${y(max * k) + 4}" text-anchor="end" class="fc-ax">${f(max * k)}</text>`).join('');
  const bars = a.map((v, i) => `<rect x="${x(i) - Math.max(1.5, bw * 0.34)}" y="${y(v)}" width="${Math.max(3, bw * 0.68)}" height="${P.t + ih - y(v)}" fill="url(#pjb)" style="animation-delay:${i * 15}ms"/>`).join('');
  const line = p.map((v, i) => `${i ? 'L' : 'M'}${x(a.length + i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = p.length ? `${line}L${x(N - 1)},${P.t + ih}L${x(a.length)},${P.t + ih}Z` : '';
  const split = P.l + a.length * bw;
  const lab = (i, t) => `<text x="${x(i)}" y="${H - 7}" text-anchor="middle" class="fc-ax">${t}</text>`;
  const fmtD = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const future = (k) => { const d = new Date(Date.parse(days[days.length - 1]) + k * 86400_000); return fmtD(d.toISOString().slice(0, 10)); };
  return `<svg viewBox="0 0 ${W} ${H}" class="pj-chart" preserveAspectRatio="none">
    <defs><linearGradient id="pjb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#19e3ff" stop-opacity=".9"/><stop offset="1" stop-color="#19e3ff" stop-opacity=".1"/></linearGradient>
    <linearGradient id="pja" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff5fa2" stop-opacity=".28"/><stop offset="1" stop-color="#ff5fa2" stop-opacity="0"/></linearGradient></defs>
    ${grid}<rect x="${split}" y="${P.t}" width="${W - P.r - split}" height="${ih}" fill="rgba(255,95,162,.04)"/>
    <g class="fc-bars">${bars}</g>${area ? `<path d="${area}" fill="url(#pja)"/>` : ''}
    ${line ? `<path d="${line}" fill="none" stroke="#ff5fa2" stroke-width="2.2" stroke-dasharray="6 5" vector-effect="non-scaling-stroke" style="filter:drop-shadow(0 0 4px #ff5fa2)"/>` : ''}
    <line x1="${split}" x2="${split}" y1="${P.t}" y2="${P.t + ih}" stroke="#d9fbff" stroke-dasharray="2 4" opacity=".6"/>
    <text x="${split - 6}" y="12" text-anchor="end" class="pj-tag">ÚLTIMOS 30 DIAS</text><text x="${split + 6}" y="12" class="pj-tag pj-f">PROJEÇÃO 30 DIAS</text>
    ${days?.length ? lab(0, fmtD(days[0])) + lab(a.length - 1, 'hoje') + (p.length ? lab(N - 1, future(p.length)) : '') : ''}</svg>`;
}
