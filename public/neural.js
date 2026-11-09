// LORLER · Cérebro neural 3D — cérebro anatômico (dois hemisférios com giros e sulcos, lobos temporais, cerebelo e
// tronco) formado por neurônios ligados por sinapses. Os impulsos percorrem as sinapses e disparam em cascata, como num
// cérebro real. Cada agente "mora" num lobo: quando ele pensa, o lobo acende e dispara mais.
//   Coordenador → pré-frontal · Financeiro → parietal esquerdo · Operacional → parietal direito
//   Comercial → lobos temporais · Marketing → occipital e cerebelo
// Mesma interface do núcleo anterior (createBrain): setStatus, agent, activate, pulse, feedFromSource, setSources,
// setListening, setSpeaking, setTranscript, destroy. Canvas 2D, sem dependências.
// Interações: arrastar gira · roda/pinça aproxima · passar o mouse excita · clique dispara · duplo clique: tempestade.
const TAU = Math.PI * 2;

export const REGION_COLORS = {
  coordinator: [45, 212, 191], financial: [74, 222, 128], commercial: [255, 138, 61],
  operations: [122, 162, 255], marketing: [196, 168, 255],
};
const FIRE = [255, 190, 130];
const AGENT_ORDER = ['coordinator', 'financial', 'commercial', 'operations', 'marketing'];
const LABELS = { coordinator: 'Coordenador', commercial: 'Comercial', financial: 'Financeiro', operations: 'Operacional', marketing: 'Marketing' };
const ROLE = { coordinator: 'pré-frontal · decide', financial: 'parietal esq. · caixa', commercial: 'temporal · preço', operations: 'parietal dir. · suporte', marketing: 'occipital · conteúdo' };
const SRC_COL = { connected: [74, 222, 128], demo: [255, 178, 125], error: [255, 120, 120], pending: [90, 110, 140] };

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---------- anatomia ----------
function buildBrain(n = 560) {
  const R = rng(20261109);
  const P = [];
  const folds = (a, b) => 1 + 0.06 * Math.sin(10 * a + 2.6 * Math.sin(6 * b)) * Math.sin(8 * b + 1.4 * Math.cos(5 * a)) + 0.025 * Math.sin(21 * a + 15 * b);
  const add = (x, y, z, region) => P.push({ x, y, z, bx: x, by: y, bz: z, region, a: 0, vx: 0, vy: 0, vz: 0, ox: 0, oy: 0, oz: 0, phase: R() * TAU, jx: 0, jy: 0 });
  for (const s of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const u = R() * 2 - 1, th = R() * TAU, rr = Math.sqrt(1 - u * u);
      let dx = rr * Math.cos(th), dy = u; const dz = rr * Math.sin(th);
      if (dx * s < 0) dx *= 0.22;                       // face medial achatada (fissura longitudinal)
      if (dy < -0.3) dy = -0.3 + (dy + 0.3) * 0.45;      // base achatada
      const g = folds(th, Math.acos(u));
      const inner = R() < 0.12 ? 0.55 + R() * 0.35 : 1;  // alguns neurônios profundos dão volume
      let x = s * 0.33 + dx * 0.6 * g * inner;
      let y = dy * 0.7 * g * inner - 0.02;
      const z = dz * g * inner * (1 - 0.1 * dy);
      const temporal = dy < 0.05 && dz > -0.35 && dz < 0.55 && Math.abs(dx) > 0.5;
      if (temporal) { y -= 0.31 * (0.05 - dy); x += s * 0.04; }
      let region;
      if (z > 0.42) region = 'coordinator';
      else if (temporal || (y < -0.16 && z > -0.3)) region = 'commercial';
      else if (z < -0.32) region = 'marketing';
      else region = s < 0 ? 'financial' : 'operations';
      add(x, y, z, region);
    }
    for (let i = 0; i < Math.round(n * 0.2); i++) {        // cerebelo com folhas finas
      const u = R() * 2 - 1, th = R() * TAU, rr = Math.sqrt(1 - u * u);
      const f = 1 + 0.08 * Math.sin(28 * u);
      add(s * 0.22 + rr * Math.cos(th) * 0.27 * f, -0.46 + u * 0.17 * f, -0.66 + rr * Math.sin(th) * 0.24 * f, 'marketing');
    }
  }
  for (let i = 0; i < 60; i++) {                          // tronco encefálico
    const t = R(), a = R() * TAU;
    add(Math.cos(a) * 0.09, -0.32 - t * 0.6, -0.3 - t * 0.12 + Math.sin(a) * 0.08, 'coordinator');
  }
  // sinapses: vizinhos mais próximos (grade espacial para não ser O(n²) puro)
  const N = P.length, adj = Array.from({ length: N }, () => []), E = [];
  const cell = 0.24, grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  P.forEach((p, i) => { const k = key(p.x, p.y, p.z); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  for (let i = 0; i < N; i++) {
    const p = P[i]; const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
    const best = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const j of grid.get(`${cx + a},${cy + b},${cz + c}`) || []) {
        if (j === i) continue;
        const d = (p.x - P[j].x) ** 2 + (p.y - P[j].y) ** 2 + (p.z - P[j].z) ** 2;
        if (d < 0.045) best.push([d, j]);
      }
    }
    best.sort((m, o) => m[0] - o[0]);
    for (const [, j] of best.slice(0, 3)) if (!adj[i].includes(j)) { adj[i].push(j); adj[j].push(i); E.push([i, j]); }
  }
  const byRegion = {}; P.forEach((p, k) => { (byRegion[p.region] ||= []).push(k); });
  const centroid = {};
  for (const r of AGENT_ORDER) { const ids = byRegion[r] || []; const c = ids.reduce((m, k) => ({ x: m.x + P[k].x, y: m.y + P[k].y, z: m.z + P[k].z }), { x: 0, y: 0, z: 0 }); centroid[r] = { x: c.x / ids.length, y: c.y / ids.length, z: c.z / ids.length }; }
  return { P, E, adj, byRegion, centroid };
}

const spriteCache = {};
function sprite(col, size = 48) {
  const key = col.join(',') + size; if (spriteCache[key]) return spriteCache[key];
  const c = document.createElement('canvas'); c.width = c.height = size; const g = c.getContext('2d'); const h = size / 2;
  const gr = g.createRadialGradient(h, h, 0, h, h, h);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.16, `rgba(${col},0.95)`); gr.addColorStop(0.5, `rgba(${col},0.22)`); gr.addColorStop(1, `rgba(${col},0)`);
  g.fillStyle = gr; g.fillRect(0, 0, size, size); spriteCache[key] = c; return c;
}

export function createBrain(el, { label = 'Núcleo online', sources = [], onSource = null, onVoice = null, compact = false } = {}) {
  el.classList.add('brain3d', 'neural');
  if (compact) el.classList.add('compact');
  el.innerHTML = `<canvas aria-label="Cérebro 3D: neurônios e sinapses dos agentes" role="img"></canvas><div class="b-status" id="b-status"></div>
    <div class="core-col core-agents"><div class="core-col-h">Agentes · lobos</div></div>
    <div class="core-col core-sources"><div class="core-col-h">Bases · dados</div></div>
    <div class="core-voice">${onVoice ? '<button type="button" class="core-mic" aria-label="Falar com o Cérebro"><span class="ring"></span><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg></button>' : ''}<div class="core-transcript"></div></div>
    <div class="b-hint">arraste: girar · clique: disparar · duplo clique: tempestade neural</div>`;
  const canvas = el.querySelector('canvas'); const ctx = canvas.getContext('2d');
  const statusEl = el.querySelector('#b-status'); statusEl.textContent = label;
  const agentsCol = el.querySelector('.core-agents'); const srcCol = el.querySelector('.core-sources');
  const transcriptEl = el.querySelector('.core-transcript');
  const mobile = window.innerWidth < 700;
  const brain = buildBrain(mobile || compact ? 380 : 560);
  const { P, E, adj, byRegion, centroid } = brain;
  const N = P.length;
  const regionAct = Object.fromEntries(AGENT_ORDER.map((k) => [k, 0.1]));
  const regionTarget = { ...regionAct }; const regionState = {};
  let busy = false, listening = false, speaking = false;
  let impulses = []; const flights = []; const rings = [];

  // ---- colunas laterais ----
  const agentChips = {};
  for (const a of AGENT_ORDER) {
    const d = document.createElement('div'); d.className = `core-chip agent c-${a}`;
    d.innerHTML = `<i></i><div><b>${LABELS[a]}</b><small>${ROLE[a]}</small></div><span class="v"></span>`;
    agentsCol.appendChild(d); agentChips[a] = d;
  }
  let srcList = []; const srcChips = {};
  const ST_TXT = { connected: 'conectado · ao vivo', demo: 'demonstração', error: 'falha na leitura', pending: 'não vinculado' };
  function setSources(list) {
    srcList = list;
    for (const k of Object.keys(srcChips)) if (!list.find((s) => s.code === k)) { srcChips[k].remove(); delete srcChips[k]; }
    for (const s of list) {
      let d = srcChips[s.code];
      if (!d) {
        d = document.createElement('div'); d.tabIndex = 0; d.setAttribute('role', 'button');
        const code = s.code; d.onclick = () => onSource?.(code); d.onkeydown = (ev) => { if (ev.key === 'Enter') onSource?.(code); };
        srcCol.appendChild(d); srcChips[s.code] = d;
      }
      d.className = `core-chip src st-${s.state}${onSource ? ' clickable' : ''}`;
      d.innerHTML = `<i></i><div><b>${s.label}</b><small>${ST_TXT[s.state] || s.state}</small></div><span class="v">${s.value ?? ''}</span>`;
      d.title = onSource ? `Relatório: últimas atividades e projeções de ${s.label}` : '';
    }
  }
  setSources(sources);

  // ---- disparos neurais ----
  const MAX_IMP = mobile ? 110 : 200;
  const fireNeuron = (i, strength = 1) => {
    const p = P[i]; p.a = Math.min(1, p.a + 0.9 * strength);
    for (const j of adj[i]) if (impulses.length < MAX_IMP && Math.random() < 0.7) impulses.push({ a: i, b: j, t: 0, v: 1.4 + Math.random() * 1.6, gen: strength > 0.9 ? 3 : 1 });
  };
  const fireRegion = (r, count = 3, strength = 1) => { const ids = byRegion[r] || []; for (let n = 0; n < count; n++) fireNeuron(ids[(Math.random() * ids.length) | 0], strength); };
  function storm() { for (let n = 0; n < 40; n++) fireNeuron((Math.random() * N) | 0, 1); for (const p of P) { const f = 0.6 + Math.random() * 0.6; p.vx += p.bx * f; p.vy += p.by * f; p.vz += p.bz * f; } }

  // ---- câmera e interação ----
  let yaw = 0.5, tilt = -0.22, auto = true, dragging = null, zoom = 1, zoomTarget = 1, active = false;
  const pointer = { x: -1e4, y: -1e4, inside: false, t: 0 };
  const touches = new Map(); let pinch = null;
  const sx = new Float32Array(N), sy = new Float32Array(N), sz = new Float32Array(N), ss = new Float32Array(N);
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const nearest = (x, y, maxD = 1e9) => { let best = -1, bd = maxD; for (let i = 0; i < N; i++) { const d = Math.hypot(sx[i] - x, sy[i] - y); if (d < bd && sz[i] > 0.35) { bd = d; best = i; } } return best; };
  canvas.addEventListener('pointerdown', (e) => {
    active = true; touches.set(e.pointerId, local(e));
    if (touches.size === 2) { const [a1, b1] = [...touches.values()]; pinch = { d: Math.hypot(a1.x - b1.x, a1.y - b1.y), z: zoomTarget }; dragging = null; return; }
    dragging = { x: e.clientX, y: e.clientY, yaw, tilt, x0: e.clientX, y0: e.clientY }; auto = false; canvas.setPointerCapture?.(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const l = local(e); pointer.x = l.x; pointer.y = l.y; pointer.inside = true; pointer.t = performance.now();
    if (touches.has(e.pointerId)) touches.set(e.pointerId, l);
    if (pinch && touches.size === 2) { const [a1, b1] = [...touches.values()]; zoomTarget = Math.max(0.6, Math.min(2.4, pinch.z * Math.hypot(a1.x - b1.x, a1.y - b1.y) / pinch.d)); return; }
    if (!dragging) { canvas.style.cursor = 'grab'; return; }
    canvas.style.cursor = 'grabbing';
    yaw = dragging.yaw + (e.clientX - dragging.x) * 0.008;
    tilt = Math.max(-1.2, Math.min(1.2, dragging.tilt + (e.clientY - dragging.y) * 0.006));
  });
  canvas.addEventListener('pointerleave', () => { pointer.inside = false; active = false; });
  let lastTap = 0;
  const endDrag = (e) => {
    touches.delete(e?.pointerId); if (touches.size < 2) pinch = null;
    if (dragging && e?.type === 'pointerup' && Math.hypot(e.clientX - dragging.x0, e.clientY - dragging.y0) < 5) {
      const l = local(e); const now = performance.now();
      if (now - lastTap < 320) storm();
      else { const i = nearest(l.x, l.y, 80); if (i >= 0) { fireNeuron(i, 1); rings.push({ t0: now, i, col: REGION_COLORS[P[i].region] }); regionTarget[P[i].region] = Math.min(1, regionTarget[P[i].region] + 0.35); } }
      lastTap = now;
    }
    dragging = null; setTimeout(() => { if (!dragging) auto = true; }, 2200);
  };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => { if (!active && !e.ctrlKey) return; e.preventDefault(); zoomTarget = Math.max(0.6, Math.min(2.4, zoomTarget * Math.exp(-e.deltaY * 0.0012))); }, { passive: false });
  const ctrl = document.createElement('div'); ctrl.className = 'b-ctrl';
  ctrl.innerHTML = '<button type="button" data-a="in" aria-label="Aproximar">+</button><button type="button" data-a="out" aria-label="Afastar">−</button><button type="button" data-a="reset" aria-label="Centralizar">⟲</button><button type="button" data-a="storm" aria-label="Tempestade neural">✦</button><button type="button" data-a="full" aria-label="Tela cheia">⛶</button>';
  el.appendChild(ctrl);
  ctrl.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    if (a === 'in') zoomTarget = Math.min(2.4, zoomTarget * 1.25);
    if (a === 'out') zoomTarget = Math.max(0.6, zoomTarget / 1.25);
    if (a === 'reset') { zoomTarget = 1; yaw = 0.5; tilt = -0.22; auto = true; }
    if (a === 'storm') storm();
    if (a === 'full') { if (document.fullscreenElement) document.exitFullscreen?.(); else el.requestFullscreen?.(); }
  };
  const micBtn = el.querySelector('.core-mic');
  if (micBtn) micBtn.onclick = () => onVoice?.();

  let W = 0, H = 0, DPR = 1;
  function resize() {
    const r = el.getBoundingClientRect(); DPR = Math.min(window.devicePixelRatio || 1, 1.75);
    W = Math.max(200, r.width); H = Math.max(200, r.height);
    canvas.width = W * DPR; canvas.height = H * DPR; canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
  }
  const ro = new ResizeObserver(resize); ro.observe(el); resize();

  let unit = 100, cxs = 0, cys = 0, cyaw = 1, syaw = 0, ctl = 1, stl = 0;
  function project(x, y, z) {
    const X = x * cyaw + z * syaw; let Z = -x * syaw + z * cyaw;
    const Y = y * ctl - Z * stl; Z = y * stl + Z * ctl;
    const persp = 3.4 / (3.4 - Z);
    return { x: cxs + X * unit * persp, y: cys - Y * unit * persp, z: Z, s: persp };
  }
  function anchor(elm, side) { const r = elm.getBoundingClientRect(); const c = canvas.getBoundingClientRect(); return { x: (side < 0 ? r.right : r.left) - c.left, y: r.top + r.height / 2 - c.top }; }
  function bez(Q, s) { const u = 1 - s; return { x: u * u * u * Q[0].x + 3 * u * u * s * Q[1].x + 3 * u * s * s * Q[2].x + s * s * s * Q[3].x, y: u * u * u * Q[0].y + 3 * u * u * s * Q[1].y + 3 * u * s * s * Q[2].y + s * s * s * Q[3].y }; }

  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let raf = null; let last = performance.now();
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    const intensity = (busy ? 1 : 0.3) + (listening ? 0.45 : 0) + (speaking ? 0.4 : 0);
    if (auto && !reduce) { yaw += dt * (busy ? 0.38 : 0.16); tilt += ((-0.22 + Math.sin(t * 0.0002) * 0.2) - tilt) * Math.min(1, dt * 0.8); }
    cyaw = Math.cos(yaw); syaw = Math.sin(yaw); ctl = Math.cos(tilt); stl = Math.sin(tilt);
    zoom += (zoomTarget - zoom) * Math.min(1, dt * 8);
    for (const r of AGENT_ORDER) { regionAct[r] += (regionTarget[r] - regionAct[r]) * Math.min(1, dt * 3); regionTarget[r] = Math.max(regionState[r] === 'thinking' ? 0.95 : 0.1, regionTarget[r] - dt * 0.12); }

    const sideW = mobile || compact ? 0 : Math.min(230, W * 0.19) + 64;
    cxs = W / 2; cys = H * 0.52;
    unit = Math.max(50, Math.min((W - sideW * 2 - 30) / 2.1, H * 0.46)) * zoom;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);

    // halo
    const fog = ctx.createRadialGradient(cxs, cys, unit * 0.1, cxs, cys, unit * 1.6);
    fog.addColorStop(0, `rgba(45,212,191,${0.08 + intensity * 0.07})`); fog.addColorStop(1, 'rgba(45,212,191,0)');
    ctx.fillStyle = fog; ctx.fillRect(0, 0, W, H);

    // física (volta à forma) + projeção
    const k = 7, damp = Math.pow(0.25, dt);
    const hover = pointer.inside && performance.now() - pointer.t < 4000; const HR = Math.max(50, unit * 0.3);
    for (let i = 0; i < N; i++) {
      const p = P[i];
      p.vx = (p.vx - p.ox * k * dt) * damp; p.vy = (p.vy - p.oy * k * dt) * damp; p.vz = (p.vz - p.oz * k * dt) * damp;
      p.ox += p.vx * dt; p.oy += p.vy * dt; p.oz += p.vz * dt;
      const breathe = 1 + Math.sin(t * 0.0012 + p.phase) * 0.004 * (1 + intensity);
      const q = project((p.bx + p.ox) * breathe, (p.by + p.oy) * breathe, (p.bz + p.oz) * breathe);
      let tx = 0, ty = 0;
      if (hover) { const dx = q.x - pointer.x, dy = q.y - pointer.y; const d = Math.hypot(dx, dy); if (d < HR && d > 0.1) { const f = (1 - d / HR) ** 2; tx = (dx / d) * f * 14; ty = (dy / d) * f * 14; if (f > 0.5 && Math.random() < dt * 3) fireNeuron(i, 0.6); } }
      p.jx += (tx - p.jx) * Math.min(1, dt * 9); p.jy += (ty - p.jy) * Math.min(1, dt * 9);
      sx[i] = q.x + p.jx; sy[i] = q.y + p.jy; sz[i] = Math.max(0, Math.min(1, (q.z + 1.2) / 2.4)); ss[i] = q.s;
      p.a *= Math.pow(0.04, dt);
    }

    // disparos espontâneos (mais quando ocupado, ouvindo ou falando; lobos ativos disparam mais)
    const rate = (2.5 + intensity * 12) * dt;
    for (let n = 0; n < rate; n++) {
      const r = Math.random() < 0.55 ? AGENT_ORDER[(Math.random() * AGENT_ORDER.length) | 0] : null;
      if (r && Math.random() < regionAct[r]) fireRegion(r, 1, 0.8); else fireNeuron((Math.random() * N) | 0, 0.7);
    }
    if (speaking) { const beat = Math.sin(t * 0.014); if (beat > 0.96) fireRegion('coordinator', 2, 1); }

    ctx.globalCompositeOperation = 'lighter';
    // ---- fluxos das colunas laterais até o lobo de cada agente ----
    const streams = [];
    if (!mobile && !compact) {
      AGENT_ORDER.forEach((a, n) => { const chip = agentChips[a]; if (chip.offsetParent) { const c = project(centroid[a].x, centroid[a].y, centroid[a].z); streams.push({ from: anchor(chip, -1), to: c, col: REGION_COLORS[a], act: Math.max(0.15, regionState[a] === 'thinking' ? regionAct[a] : 0.15), code: a, side: -1, n }); } });
      srcList.forEach((s, n) => { const chip = srcChips[s.code]; if (chip?.offsetParent) { const spread = (n + 0.5) / srcList.length - 0.5; const c = { x: cxs + unit * 0.75, y: cys + spread * unit * 0.9 }; streams.push({ from: anchor(chip, 1), to: c, col: SRC_COL[s.state] || SRC_COL.pending, act: s.state === 'pending' ? 0.05 : 0.3, code: s.code, side: 1, n, dim: s.state === 'pending' }); } });
    }
    for (const st of streams) {
      const c1 = { x: st.from.x - st.side * Math.abs(st.to.x - st.from.x) * 0.45, y: st.from.y };
      const c2 = { x: st.to.x + st.side * unit * 0.5, y: st.to.y };
      st.path = [st.from, c1, c2, st.to];
      const [r, g, b] = st.col;
      ctx.lineWidth = 0.8 + st.act * 1.4; ctx.strokeStyle = `rgba(${r},${g},${b},${st.dim ? 0.05 : 0.08 + st.act * 0.3})`;
      ctx.beginPath(); ctx.moveTo(st.from.x, st.from.y); ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, st.to.x, st.to.y); ctx.stroke();
      if (!st.dim) {
        const nP = 2 + Math.round(st.act * 5);
        for (let q = 0; q < nP; q++) {
          const kk = (t * (0.00014 + st.act * 0.0003) + q / nP + st.n * 0.13) % 1;
          const pt = bez(st.path, kk);
          ctx.fillStyle = `rgba(${r},${g},${b},${0.35 + kk * 0.6})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, 1.2 + st.act * 1.3, 0, TAU); ctx.fill();
        }
      }
    }

    // ---- sinapses em camadas de profundidade ----
    for (let L = 0; L < 4; L++) {
      ctx.beginPath();
      for (const [i, j] of E) { const d = (sz[i] + sz[j]) / 2; if (Math.min(3, (d * 4) | 0) !== L) continue; ctx.moveTo(sx[i], sy[i]); ctx.lineTo(sx[j], sy[j]); }
      ctx.strokeStyle = `rgba(120,200,230,${0.02 + L * 0.03 + intensity * 0.01})`; ctx.lineWidth = 0.5 + L * 0.22; ctx.stroke();
    }
    // sinapses dos lobos ativos ficam com a cor do agente
    for (const r of AGENT_ORDER) {
      if (regionState[r] !== 'thinking' && regionAct[r] < 0.35) continue;
      const [cr, cg, cb] = REGION_COLORS[r]; ctx.beginPath();
      for (const [i, j] of E) if (P[i].region === r && sz[i] > 0.3) { ctx.moveTo(sx[i], sy[i]); ctx.lineTo(sx[j], sy[j]); }
      ctx.strokeStyle = `rgba(${cr},${cg},${cb},${0.05 + regionAct[r] * 0.18})`; ctx.lineWidth = 0.8; ctx.stroke();
    }

    // ---- neurônios ----
    for (let i = 0; i < N; i++) {
      const p = P[i], d = sz[i];
      const act = regionState[p.region] === 'thinking' ? regionAct[p.region] * (0.55 + 0.45 * Math.sin(t * 0.006 + p.phase)) : regionAct[p.region] * 0.3;
      const col = act > 0.3 ? REGION_COLORS[p.region] : [150, 200, 235];
      const r = (1.4 + d * 3.4 + act * 2) * ss[i] * (unit / 160);
      ctx.globalAlpha = 0.18 + d * 0.7;
      ctx.drawImage(sprite(col, 32), sx[i] - r, sy[i] - r, r * 2, r * 2);
      if (p.a > 0.06) { const f = (3 + p.a * 8) * (0.5 + d) * (unit / 160); ctx.globalAlpha = p.a * 0.7; ctx.drawImage(sprite(FIRE, 64), sx[i] - f, sy[i] - f, f * 2, f * 2); }
    }

    // ---- impulsos percorrendo as sinapses (propagação em cascata) ----
    const next = [];
    for (const q of impulses) {
      q.t += q.v * dt * (0.8 + intensity * 0.6);
      if (q.t >= 1) {
        const p = P[q.b]; p.a = Math.min(1, p.a + 0.55);
        if (q.gen > 0 && Math.random() < 0.4 + regionAct[p.region] * 0.35) {
          const nb = adj[q.b].filter((x) => x !== q.a);
          for (let c = 0; c < Math.min(2, nb.length); c++) if (next.length < MAX_IMP) next.push({ a: q.b, b: nb[(Math.random() * nb.length) | 0], t: 0, v: 1.4 + Math.random() * 1.6, gen: q.gen - 1 });
        }
        continue;
      }
      const x = sx[q.a] + (sx[q.b] - sx[q.a]) * q.t, y = sy[q.a] + (sy[q.b] - sy[q.a]) * q.t;
      const d = sz[q.a] + (sz[q.b] - sz[q.a]) * q.t;
      const tt = Math.max(0, q.t - 0.4);
      ctx.globalAlpha = 0.25 + d * 0.5; ctx.strokeStyle = 'rgba(255,190,130,0.55)'; ctx.lineWidth = 0.8 + d * 0.8;
      ctx.beginPath(); ctx.moveTo(sx[q.a] + (sx[q.b] - sx[q.a]) * tt, sy[q.a] + (sy[q.b] - sy[q.a]) * tt); ctx.lineTo(x, y); ctx.stroke();
      const r = (2 + d * 2.6) * (unit / 160); ctx.drawImage(sprite(FIRE, 64), x - r, y - r, r * 2, r * 2);
      next.push(q);
    }
    impulses = next;

    // ---- voos: impulsos vindos das colunas e entre lobos ----
    ctx.globalAlpha = 1;
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i]; const kq = Math.min(1, (t - f.t0) / f.dur);
      let pos;
      if (f.kind === 'stream') { const st = streams.find((s) => s.code === f.code); pos = st?.path ? bez(st.path, kq) : project(centroid[f.then].x, centroid[f.then].y, centroid[f.then].z); }
      else { const A = centroid[f.from], B = centroid[f.to]; const m = (v) => A[v] + (B[v] - A[v]) * kq; pos = project(m('x'), m('y') + Math.sin(kq * Math.PI) * 0.55, m('z')); }
      const gs = f.big ? 30 : 20; ctx.drawImage(sprite(f.col, 48), pos.x - gs / 2, pos.y - gs / 2, gs, gs);
      if (kq >= 1) { if (f.then) { regionTarget[f.then] = Math.min(1, regionTarget[f.then] + 0.2); fireRegion(f.then, f.big ? 5 : 3, 1); } flights.splice(i, 1); }
    }
    for (let w = rings.length - 1; w >= 0; w--) {
      const rg = rings[w]; const k2 = (performance.now() - rg.t0) / 1100; if (k2 >= 1) { rings.splice(w, 1); continue; }
      const [r0, g0, b0] = rg.col; ctx.lineWidth = 2 * (1 - k2) + 0.4; ctx.strokeStyle = `rgba(${r0},${g0},${b0},${0.8 * (1 - k2)})`;
      ctx.beginPath(); ctx.arc(sx[rg.i], sy[rg.i], 5 + k2 * unit * 0.7, 0, TAU); ctx.stroke();
    }
    // anel de escuta / fala
    if (listening || speaking) {
      const pr = listening ? REGION_COLORS.coordinator : REGION_COLORS.commercial; const pk = 0.5 + 0.5 * Math.sin(t * 0.01);
      ctx.lineWidth = 2; ctx.strokeStyle = `rgba(${pr},${0.25 + pk * 0.35})`;
      ctx.beginPath(); ctx.ellipse(cxs, cys, unit * 1.08, unit * 0.86, 0, 0, TAU); ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
    for (const a of AGENT_ORDER) { const c = agentChips[a]; c.classList.toggle('thinking', regionState[a] === 'thinking'); c.classList.toggle('failed', regionState[a] === 'failed'); c.querySelector('.v').textContent = regionState[a] === 'thinking' ? `${Math.round(regionAct[a] * 100)}%` : regionState[a] === 'failed' ? 'falha' : ''; }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  const regionOf = (a) => (LABELS[a] ? a : 'coordinator');
  return {
    setStatus(text, isBusy) { statusEl.textContent = text; busy = !!isBusy; if (isBusy) regionTarget.coordinator = 0.8; },
    agent(a, stateName, note = '') {
      const r = regionOf(a); regionState[r] = stateName || '';
      const small = agentChips[r]?.querySelector('small'); if (small) small.textContent = note || ROLE[r];
      if (stateName === 'thinking') { regionTarget[r] = 1; flights.push({ kind: 'stream', code: r, t0: performance.now(), dur: 1600, col: REGION_COLORS[r], then: r, big: true }); }
    },
    activate(list) { list.forEach((a) => { regionTarget[regionOf(a)] = Math.max(regionTarget[regionOf(a)], 0.4); }); },
    pulse(from, to, type) {
      const col = REGION_COLORS[regionOf(from)] || REGION_COLORS.coordinator;
      const targets = to === 'all' ? AGENT_ORDER.filter((r) => r !== 'coordinator') : [regionOf(to)];
      for (const r of targets) flights.push({ kind: 'arc', from: regionOf(from), to: r, t0: performance.now(), dur: type === 'challenge' ? 1300 : 1000, col, then: r, big: type === 'challenge' || type === 'synthesis' });
      regionTarget[regionOf(from)] = Math.min(1, regionTarget[regionOf(from)] + 0.3);
      fireRegion(regionOf(from), 2, 1);
    },
    feedFromSource(code) {
      const s = srcList.find((x) => x.code === code); if (!s) return;
      flights.push({ kind: 'stream', code, t0: performance.now(), dur: 2200, col: SRC_COL[s.state] || SRC_COL.demo, then: 'coordinator', big: true });
    },
    setSources,
    setListening(on) { listening = !!on; el.classList.toggle('listening', listening); },
    setSpeaking(on) { speaking = !!on; el.classList.toggle('speaking', speaking); },
    setTranscript(text, kind = '') { transcriptEl.textContent = text || ''; transcriptEl.className = `core-transcript ${kind}`; },
    destroy() { if (raf) cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
