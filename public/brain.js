// LORLER · Núcleo neural — toroide de neurônios girando 360° com um buraco negro no centro que "suga" os dados
// (canvas 2D, sem dependências). Esquerda: agentes alimentando o núcleo · Direita: bases de dados · Centro: horizonte
// de eventos com disco de acreção. A superfície do toroide escoa continuamente para dentro (vórtice) e partículas de
// dados espiralam até o horizonte.
// Interações: arrastar gira/inclina · roda/pinça aproxima · passar o mouse excita os neurônios · clique dispara onda
// · duplo clique expande e remonta · botões laterais · microfone para comandos de voz (callback onVoice).
const TAU = Math.PI * 2;

export const REGION_COLORS = {
  coordinator: [25, 227, 255], commercial: [255, 181, 71], financial: [61, 255, 168],
  operations: [157, 140, 255], marketing: [255, 95, 162],
};
const AGENT_ORDER = ['coordinator', 'financial', 'commercial', 'operations', 'marketing'];
const LABELS = { coordinator: 'Coordenador', commercial: 'Comercial', financial: 'Financeiro', operations: 'Operacional', marketing: 'Marketing' };
const ROLE = { coordinator: 'orquestra e decide', financial: 'margem · caixa · risco', commercial: 'preço · conversão', operations: 'suporte · capacidade', marketing: 'conteúdo · Instagram' };

function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Toroide: raio maior RT, raio do tubo rt. Cada setor angular pertence a um agente.
const RT = 1.18, rt = 0.36, HOLE_R = 0.3;
function torusPos(p, flow) {
  const v = p.v + flow * p.fs; const rr = p.rr;
  const ring = RT + rr * Math.cos(v);
  p.x = ring * Math.cos(p.u); p.z = ring * Math.sin(p.u); p.y = rr * Math.sin(v);
  p.nx = Math.cos(v) * Math.cos(p.u); p.ny = Math.sin(v); p.nz = Math.cos(v) * Math.sin(p.u);
  p.inner = Math.cos(v) < -0.55; // lado voltado para o buraco negro
}
function buildCore(nu = 120, nv = 26) {
  const R = rng(20261007);
  const pts = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    const u = (i + R() * 0.6) / nu * TAU, v = (j + R() * 0.6) / nv * TAU;
    const p = { i, j, u, v, rr: rt * (0.9 + R() * 0.2), fs: 0.85 + R() * 0.3, region: AGENT_ORDER[Math.floor((u / TAU) * AGENT_ORDER.length) % AGENT_ORDER.length],
      a: 0, phase: R() * TAU, spike: R() < 0.07 ? 0.05 + R() * 0.22 : 0, hue: R(), ox: 0, oy: 0, oz: 0, vx: 0, vy: 0, vz: 0, jx: 0, jy: 0 };
    torusPos(p, 0); pts.push(p);
  }
  const idx = (i, j) => ((i + nu) % nu) * nv + ((j + nv) % nv);
  const edges = [];
  for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
    if (j % 2 === 0) edges.push([idx(i, j), idx(i + 1, j), 0]);   // anéis ao longo do toroide
    if (i % 3 === 0) edges.push([idx(i, j), idx(i, j + 1), 0]);   // anéis do tubo
    if (R() < 0.08) edges.push([idx(i, j), idx(i + 2 + ((R() * 3) | 0), j + ((R() * 5) | 0) - 2), 0]); // sinapses diagonais
  }
  const disk = Array.from({ length: 1500 }, () => { const r = HOLE_R + 0.04 + Math.pow(R(), 0.7) * 0.44; return { r, ang: R() * TAU, h: (R() - 0.5) * 0.03 * r, b: R() }; });
  const byRegion = {}; pts.forEach((p, k) => { (byRegion[p.region] ||= []).push(k); });
  return { pts, edges, disk, byRegion, nu, nv };
}

const spriteCache = {};
function glowSprite(col, size = 64) {
  const key = col.join(','); if (spriteCache[key]) return spriteCache[key];
  const [r, g, b] = col; const c = document.createElement('canvas'); c.width = c.height = size; const x = c.getContext('2d'); const h = size / 2;
  const grd = x.createRadialGradient(h, h, 0, h, h, h);
  grd.addColorStop(0, `rgba(${r},${g},${b},0.95)`); grd.addColorStop(0.3, `rgba(${r},${g},${b},0.35)`); grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
  x.fillStyle = grd; x.fillRect(0, 0, size, size); spriteCache[key] = c; return c;
}

export function createBrain(el, { label = 'Núcleo online', sources = [], onSource = null, onVoice = null } = {}) {
  el.classList.add('brain3d', 'core-bh');
  el.innerHTML = `<canvas></canvas><div class="b-status" id="b-status"></div>
    <div class="core-col core-agents"><div class="core-col-h">◆ Agentes · entradas</div></div>
    <div class="core-col core-sources"><div class="core-col-h">◆ Bases · dados</div></div>
    <div class="core-voice">${onVoice ? '<button type="button" class="core-mic" title="Falar com o LORLER (comandos de voz)"><span class="ring"></span><svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg></button>' : ''}<div class="core-transcript"></div></div>
    <div class="b-hint">giro 360° · clique: onda · duplo clique: expandir · arraste: girar</div>`;
  const canvas = el.querySelector('canvas'); const ctx = canvas.getContext('2d');
  const statusEl = el.querySelector('#b-status'); statusEl.textContent = label;
  const agentsCol = el.querySelector('.core-agents'); const srcCol = el.querySelector('.core-sources');
  const transcriptEl = el.querySelector('.core-transcript');
  const mobile = window.innerWidth < 700;
  const core = buildCore(mobile ? 84 : 128, mobile ? 20 : 26);
  const regionAct = Object.fromEntries(AGENT_ORDER.map((k) => [k, 0.12]));
  const regionTarget = { ...regionAct }; const regionState = {};
  let busy = false, listening = false, speaking = false, flow = 0;
  const pulses = []; const ripples = []; const rings = []; const infall = [];

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

  // ---- câmera e interação ----
  let yaw = 0.4, tilt = -0.95, auto = true, dragging = null, zoom = 1, zoomTarget = 1, active = false;
  const pointer = { x: -1e4, y: -1e4, inside: false, t: 0 };
  const touches = new Map(); let pinch = null; let lastProj = [];
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const nearestNode = (x, y, maxD = 1e9) => { let best = -1, bd = maxD; for (let i = 0; i < lastProj.length; i++) { const q = lastProj[i]; const d = Math.hypot(q.x - x, q.y - y); if (d < bd) { bd = d; best = i; } } return best; };
  function ripple(i, strong = false) {
    if (i < 0) return; const o = core.pts[i];
    ripples.push({ t0: performance.now(), speed: strong ? 2.2 : 1.5, ox: o.x, oy: o.y, oz: o.z });
    rings.push({ t0: performance.now(), i, col: REGION_COLORS[o.region] });
    regionTarget[o.region] = Math.min(1, regionTarget[o.region] + 0.4);
    for (let n = 0; n < 40; n++) spawnInfall(o.x, o.y, o.z, REGION_COLORS[o.region]);
  }
  function explode() { for (const p of core.pts) { const f = 1.4 + Math.random() * 1.2; p.vx += p.nx * f + p.x * 0.6; p.vy += p.ny * f + (Math.random() - 0.5); p.vz += p.nz * f + p.z * 0.6; p.a = 1; } }
  // partícula de dado sendo sugada: parte de um ponto e espirala até o horizonte
  function spawnInfall(x, y, z, col) {
    const r0 = Math.hypot(x, z) || RT; infall.push({ ang: Math.atan2(z, x), r: r0, y, col, life: 0, sp: 0.6 + Math.random() * 0.8 });
    if (infall.length > 900) infall.splice(0, infall.length - 900);
  }
  canvas.addEventListener('pointerdown', (e) => {
    active = true; touches.set(e.pointerId, local(e));
    if (touches.size === 2) { const [a1, b1] = [...touches.values()]; pinch = { d: Math.hypot(a1.x - b1.x, a1.y - b1.y), z: zoomTarget }; dragging = null; return; }
    dragging = { x: e.clientX, y: e.clientY, yaw, tilt, x0: e.clientX, y0: e.clientY }; auto = false; canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    const l = local(e); pointer.x = l.x; pointer.y = l.y; pointer.inside = true; pointer.t = performance.now();
    if (touches.has(e.pointerId)) touches.set(e.pointerId, l);
    if (pinch && touches.size === 2) { const [a1, b1] = [...touches.values()]; zoomTarget = Math.max(0.6, Math.min(2.4, pinch.z * Math.hypot(a1.x - b1.x, a1.y - b1.y) / pinch.d)); return; }
    if (!dragging) { canvas.style.cursor = 'crosshair'; return; }
    yaw = dragging.yaw + (e.clientX - dragging.x) * 0.008;
    tilt = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, dragging.tilt + (e.clientY - dragging.y) * 0.006));
  });
  canvas.addEventListener('pointerleave', () => { pointer.inside = false; active = false; });
  let lastTap = 0;
  const endDrag = (e) => {
    touches.delete(e?.pointerId); if (touches.size < 2) pinch = null;
    if (dragging && e?.type === 'pointerup' && Math.hypot(e.clientX - dragging.x0, e.clientY - dragging.y0) < 5) {
      const l = local(e); const now = performance.now();
      if (now - lastTap < 320) explode(); else { const n = nearestNode(l.x, l.y, 90); ripple(n >= 0 ? n : nearestNode(W / 2, H / 2)); }
      lastTap = now;
    }
    dragging = null; setTimeout(() => { if (!dragging) auto = true; }, 2200);
  };
  canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => { if (!active && !e.ctrlKey) return; e.preventDefault(); zoomTarget = Math.max(0.6, Math.min(2.4, zoomTarget * Math.exp(-e.deltaY * 0.0012))); }, { passive: false });
  const ctrl = document.createElement('div'); ctrl.className = 'b-ctrl';
  ctrl.innerHTML = '<button data-a="in" title="Aproximar">+</button><button data-a="out" title="Afastar">−</button><button data-a="reset" title="Centralizar">⟲</button><button data-a="pulse" title="Disparar onda neural">✦</button><button data-a="burst" title="Expandir e remontar">✺</button><button data-a="full" title="Tela cheia">⛶</button>';
  el.appendChild(ctrl);
  ctrl.onclick = (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return;
    if (a === 'in') zoomTarget = Math.min(2.4, zoomTarget * 1.25);
    if (a === 'out') zoomTarget = Math.max(0.6, zoomTarget / 1.25);
    if (a === 'reset') { zoomTarget = 1; yaw = 0.4; tilt = -0.95; auto = true; }
    if (a === 'pulse') ripple((Math.random() * core.pts.length) | 0, true);
    if (a === 'burst') explode();
    if (a === 'full') { if (document.fullscreenElement) document.exitFullscreen?.(); else el.requestFullscreen?.(); }
  };
  const micBtn = el.querySelector('.core-mic');
  if (micBtn) micBtn.onclick = () => onVoice?.();

  let W = 0, H = 0, DPR = 1;
  function resize() {
    const r = el.getBoundingClientRect(); DPR = Math.min(window.devicePixelRatio || 1, 1.6);
    W = Math.max(200, r.width); H = Math.max(220, r.height);
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
  function bez(P, s) { const u = 1 - s; return { x: u * u * u * P[0].x + 3 * u * u * s * P[1].x + 3 * u * s * s * P[2].x + s * s * s * P[3].x, y: u * u * u * P[0].y + 3 * u * u * s * P[1].y + 3 * u * s * s * P[2].y + s * s * s * P[3].y }; }

  let raf = null; let last = performance.now(); let spawnAcc = 0;
  function frame(t) {
    const dt = Math.min(0.05, (t - last) / 1000); last = t;
    const intensity = (busy ? 1 : 0.35) + (listening ? 0.5 : 0) + (speaking ? 0.3 : 0);
    if (auto) { yaw += dt * (busy ? 0.42 : 0.18); tilt += ((-0.95 + Math.sin(t * 0.00022) * 0.32) - tilt) * Math.min(1, dt * 0.8); } // giro contínuo de 360°
    cyaw = Math.cos(yaw); syaw = Math.sin(yaw); ctl = Math.cos(tilt); stl = Math.sin(tilt);
    flow += dt * (0.35 + intensity * 0.9); // superfície escoando para dentro (vórtice)
    zoom += (zoomTarget - zoom) * Math.min(1, dt * 8);
    for (const r of AGENT_ORDER) { regionAct[r] += (regionTarget[r] - regionAct[r]) * Math.min(1, dt * 3); regionTarget[r] = Math.max(regionState[r] === 'thinking' ? 0.95 : 0.12, regionTarget[r] - dt * 0.12); }

    const sideW = mobile ? 0 : Math.min(230, W * 0.19) + 72;
    cxs = W / 2; cys = H * 0.5;
    unit = Math.max(40, Math.min((W - sideW * 2 - 40) / 3.3, H * 0.31)) * zoom;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, W, H);

    const fog = ctx.createRadialGradient(cxs, cys, unit * 0.2, cxs, cys, unit * 2.2);
    fog.addColorStop(0, `rgba(40,70,140,${0.12 + intensity * 0.08})`); fog.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = fog; ctx.fillRect(0, 0, W, H);

    // física + vórtice
    const k = 6, damp = Math.pow(0.3, dt);
    const hover = pointer.inside && performance.now() - pointer.t < 4000; const HR = Math.max(60, unit * 0.35);
    const proj = core.pts.map((p) => {
      torusPos(p, flow);
      p.vx = (p.vx - p.ox * k * dt) * damp; p.vy = (p.vy - p.oy * k * dt) * damp; p.vz = (p.vz - p.oz * k * dt) * damp;
      p.ox += p.vx * dt; p.oy += p.vy * dt; p.oz += p.vz * dt;
      const q = project(p.x + p.ox, p.y + p.oy, p.z + p.oz);
      let tx = 0, ty = 0;
      if (hover) { const dx = q.x - pointer.x, dy = q.y - pointer.y; const d = Math.hypot(dx, dy); if (d < HR && d > 0.1) { const f = (1 - d / HR) ** 2; tx = (dx / d) * f * 20; ty = (dy / d) * f * 20; if (f > 0.25) p.a = Math.max(p.a, f * 0.9); } }
      p.jx += (tx - p.jx) * Math.min(1, dt * 9); p.jy += (ty - p.jy) * Math.min(1, dt * 9);
      q.x += p.jx; q.y += p.jy; return q;
    });
    lastProj = proj;
    // dados sendo sugados continuamente da borda interna do toroide
    spawnAcc += dt * (40 + intensity * 140);
    while (spawnAcc > 1) { spawnAcc -= 1; const p = core.pts[(Math.random() * core.pts.length) | 0]; if (p.inner || Math.random() < 0.25) spawnInfall(p.x, p.y, p.z, Math.random() < 0.7 ? [170, 205, 255] : REGION_COLORS[p.region]); }
    for (let w = ripples.length - 1; w >= 0; w--) {
      const rp = ripples[w]; const front = ((performance.now() - rp.t0) / 1000) * rp.speed;
      if (front > 3) { ripples.splice(w, 1); continue; }
      for (const p of core.pts) if (Math.abs(Math.hypot(p.x - rp.ox, p.y - rp.oy, p.z - rp.oz) - front) < 0.05) p.a = 1;
    }
    const fireRate = (busy ? 50 : 10) * dt;
    for (let n = 0; n < fireRate; n++) { const e = core.edges[(Math.random() * core.edges.length) | 0]; if (Math.random() < 0.3 + regionAct[core.pts[e[0]].region]) e[2] = 1; }

    // ---- fluxos das colunas laterais até o núcleo ----
    ctx.globalCompositeOperation = 'lighter';
    const streams = [];
    if (!mobile) {
      AGENT_ORDER.forEach((a, n) => { const chip = agentChips[a]; if (chip.offsetParent) streams.push({ from: anchor(chip, -1), col: REGION_COLORS[a], act: Math.max(0.15, regionState[a] === 'thinking' ? regionAct[a] : 0.15), code: a, side: -1, n, total: AGENT_ORDER.length }); });
      srcList.forEach((s, n) => { const chip = srcChips[s.code]; if (chip?.offsetParent) streams.push({ from: anchor(chip, 1), col: s.state === 'connected' ? [61, 255, 168] : s.state === 'demo' ? [255, 181, 71] : s.state === 'error' ? [255, 77, 106] : [90, 110, 130], act: s.state === 'pending' ? 0.05 : 0.35, code: s.code, side: 1, n, total: srcList.length, dim: s.state === 'pending' }); });
    }
    for (const st of streams) {
      const spread = (st.n + 0.5) / st.total - 0.5;
      const tx = cxs + st.side * unit * (RT + rt) * 0.95, ty = cys + spread * unit * 0.8;
      const c1 = { x: st.from.x - st.side * Math.abs(tx - st.from.x) * 0.5, y: st.from.y };
      const c2 = { x: tx + st.side * unit * 0.4, y: ty };
      st.path = [st.from, c1, c2, { x: tx, y: ty }];
      const [r, g, b] = st.col;
      ctx.lineWidth = 1 + st.act * 1.6; ctx.strokeStyle = `rgba(${r},${g},${b},${st.dim ? 0.07 : 0.14 + st.act * 0.35})`;
      ctx.beginPath(); ctx.moveTo(st.from.x, st.from.y); ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, tx, ty); ctx.stroke();
      if (!st.dim) {
        const nP = 3 + Math.round(st.act * 6);
        for (let q = 0; q < nP; q++) {
          const kk = (t * (0.00016 + st.act * 0.00035) + q / nP + st.n * 0.13) % 1;
          const pt = bez(st.path, kk);
          ctx.fillStyle = `rgba(${r},${g},${b},${0.4 + kk * 0.6})`; ctx.beginPath(); ctx.arc(pt.x, pt.y, 1.3 + st.act * 1.5, 0, TAU); ctx.fill();
        }
      }
    }

    // ---- buraco negro ----
    const c0 = project(0, 0, 0);
    const hole = unit * HOLE_R * c0.s;
    const diskPts = core.disk.map((d) => { d.ang += dt * (0.9 / Math.pow(d.r, 1.5)) * (0.7 + intensity * 0.8); return { d, q: project(Math.cos(d.ang) * d.r, d.h, Math.sin(d.ang) * d.r) }; });
    const drawDisk = (front) => {
      for (const { d, q } of diskPts) {
        if ((q.z > c0.z) !== front) continue;
        const heat = 1 - (d.r - HOLE_R - 0.04) / 0.44;
        ctx.fillStyle = `rgba(255,${Math.round(140 + heat * 110)},${Math.round(50 + heat * 180)},${0.22 + heat * 0.6})`;
        const sz = (1.1 + d.b * 1.9) * q.s * (unit / 140);
        ctx.fillRect(q.x - sz / 2, q.y - sz / 2, sz, sz);
      }
    };
    // partículas sendo sugadas (atrás do horizonte primeiro)
    const infallPts = [];
    for (let n = infall.length - 1; n >= 0; n--) {
      const f = infall[n]; f.life += dt;
      const pull = (0.35 + intensity * 0.6) * f.sp * (1 + 0.6 / Math.max(0.15, f.r));
      f.r -= dt * pull * 0.45; f.ang += dt * (1.6 / Math.pow(Math.max(f.r, 0.2), 1.5)) * f.sp; f.y *= Math.pow(0.15, dt);
      if (f.r <= HOLE_R * 0.95) { infall.splice(n, 1); continue; }
      infallPts.push({ f, q: project(Math.cos(f.ang) * f.r, f.y, Math.sin(f.ang) * f.r), tail: project(Math.cos(f.ang - 0.18) * (f.r + 0.03), f.y, Math.sin(f.ang - 0.18) * (f.r + 0.03)) });
    }
    const drawInfall = (front) => {
      for (const { f, q, tail } of infallPts) {
        if ((q.z > c0.z) !== front) continue;
        const near = Math.max(0, 1 - (f.r - HOLE_R) / (RT - HOLE_R));
        const [r, g, b] = near > 0.6 ? [255, 210, 150] : f.col;
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.25 + near * 0.6})`; ctx.lineWidth = 0.8 + near * 1.4;
        ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      }
    };
    // brilho difuso do disco de acreção (elipse no plano do toroide)
    { const rx = unit * 0.62 * c0.s, ry = rx * Math.max(0.08, Math.abs(Math.sin(tilt))); const g2 = ctx.createRadialGradient(c0.x, c0.y, hole * 0.9, c0.x, c0.y, rx);
      g2.addColorStop(0, `rgba(255,190,110,${0.30 + intensity * 0.15})`); g2.addColorStop(0.5, 'rgba(255,130,60,0.10)'); g2.addColorStop(1, 'rgba(255,100,40,0)');
      ctx.save(); ctx.translate(c0.x, c0.y); ctx.scale(1, ry / rx); ctx.translate(-c0.x, -c0.y); ctx.fillStyle = g2; ctx.beginPath(); ctx.arc(c0.x, c0.y, rx, 0, TAU); ctx.fill(); ctx.restore(); }
    drawDisk(false); drawInfall(false);
    ctx.lineWidth = Math.max(1.5, hole * 0.16);
    const lg = ctx.createLinearGradient(c0.x - hole * 1.7, 0, c0.x + hole * 1.7, 0);
    lg.addColorStop(0, 'rgba(255,140,60,0)'); lg.addColorStop(0.5, `rgba(255,210,150,${0.55 + intensity * 0.25})`); lg.addColorStop(1, 'rgba(255,140,60,0)');
    ctx.strokeStyle = lg; ctx.beginPath(); ctx.ellipse(c0.x, c0.y, hole * 1.6, hole * (0.55 + Math.abs(Math.cos(tilt)) * 0.6), 0, Math.PI * 1.05, Math.PI * 1.95); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    const hg = ctx.createRadialGradient(c0.x, c0.y, hole * 0.6, c0.x, c0.y, hole * 1.18);
    hg.addColorStop(0, 'rgba(0,0,0,1)'); hg.addColorStop(0.82, 'rgba(0,0,0,1)'); hg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(c0.x, c0.y, hole * 1.18, 0, TAU); ctx.fill();
    ctx.globalCompositeOperation = 'lighter';
    const pr = listening ? [25, 227, 255] : speaking ? [255, 95, 162] : [255, 196, 120];
    const pk = listening || speaking ? 0.55 + 0.45 * Math.sin(t * 0.012) : 0.75 + 0.25 * Math.sin(t * 0.003);
    ctx.lineWidth = Math.max(1, hole * 0.07); ctx.strokeStyle = `rgba(${pr[0]},${pr[1]},${pr[2]},${0.8 * pk})`;
    ctx.beginPath(); ctx.arc(c0.x, c0.y, hole * 1.02, 0, TAU); ctx.stroke();
    ctx.lineWidth = Math.max(4, hole * 0.32); ctx.strokeStyle = `rgba(${pr[0]},${pr[1]},${pr[2]},${0.12 * pk})`;
    ctx.beginPath(); ctx.arc(c0.x, c0.y, hole * 1.14, 0, TAU); ctx.stroke();
    drawDisk(true); drawInfall(true);

    // ---- toroide ----
    const order = core.edges.map((e, i) => [(proj[e[0]].z + proj[e[1]].z) / 2, i]).sort((a, b) => a[0] - b[0]);
    for (const [zm, i] of order) {
      const e = core.edges[i]; const a = proj[e[0]], b = proj[e[1]];
      if (Math.hypot(a.x - b.x, a.y - b.y) > unit * 0.7) { e[2] *= 0.9; continue; }
      const depth = Math.max(0, Math.min(1, (zm + 1.6) / 3.2));
      const reg = core.pts[e[0]].region; const act = regionState[reg] === 'thinking' ? regionAct[reg] : 0;
      const hot = Math.min(1, e[2] + (act > 0.5 ? act - 0.3 : 0));
      const [r, g, bl] = hot > 0.15 ? REGION_COLORS[reg] : [120, 160, 230];
      ctx.lineWidth = 0.5 + depth * 0.6 + hot; ctx.strokeStyle = `rgba(${r},${g},${bl},${0.05 + depth * 0.16 + hot * 0.55})`;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (e[2] > 0.5) { core.pts[e[0]].a = 1; core.pts[e[1]].a = 1; }
      e[2] *= Math.pow(0.05, dt);
    }
    for (let i = 0; i < core.pts.length; i++) {
      const p = core.pts[i], q = proj[i];
      const depth = Math.max(0, Math.min(1, (q.z + 1.6) / 3.2));
      const act = regionState[p.region] === 'thinking' ? regionAct[p.region] : 0;
      const base = p.hue < 0.55 ? [170, 205, 255] : p.hue < 0.8 ? [235, 240, 255] : [150, 140, 255];
      const lit = Math.max(p.a, act > 0.5 ? (act - 0.3) * (0.6 + 0.4 * Math.sin(t * 0.006 + p.phase)) : 0);
      const [r, g, b] = lit > 0.2 ? REGION_COLORS[p.region] : p.inner ? [255, 200, 140] : base; // borda interna aquecida pelo disco
      const sz = (0.9 + depth * 1.3 + lit * 1.8) * q.s;
      ctx.fillStyle = `rgba(${r},${g},${b},${0.25 + depth * 0.6 + lit * 0.4})`;
      ctx.fillRect(q.x - sz / 2, q.y - sz / 2, sz, sz);
      if (lit > 0.35) { const gs = sz * 7; ctx.globalAlpha = Math.min(0.8, lit); ctx.drawImage(glowSprite(REGION_COLORS[p.region]), q.x - gs / 2, q.y - gs / 2, gs, gs); ctx.globalAlpha = 1; }
      if (p.spike && !p.inner) {
        const fl = 0.5 + 0.5 * Math.sin(t * 0.0025 + p.phase * 4);
        const len = p.spike * (0.6 + fl * 0.6 + lit);
        const tip = project(p.x + p.ox + p.nx * len, p.y + p.oy + p.ny * len, p.z + p.oz + p.nz * len);
        const gr = ctx.createLinearGradient(q.x, q.y, tip.x, tip.y);
        gr.addColorStop(0, `rgba(255,214,110,${0.15 + depth * 0.5})`); gr.addColorStop(1, 'rgba(255,190,60,0)');
        ctx.strokeStyle = gr; ctx.lineWidth = 0.8 + depth * 0.6; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(tip.x + p.jx, tip.y + p.jy); ctx.stroke();
      }
      p.a *= Math.pow(0.03, dt);
    }

    if (hover) {
      const near = []; for (let i = 0; i < proj.length; i += 2) { const d = Math.hypot(proj[i].x - pointer.x, proj[i].y - pointer.y); if (d < HR) near.push([d, i]); }
      near.sort((x, y) => x[0] - y[0]);
      for (const [d, i] of near.slice(0, 8)) { const q = proj[i]; ctx.strokeStyle = `rgba(255,220,120,${0.6 * (1 - d / HR)})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(pointer.x, pointer.y); ctx.lineTo(q.x, q.y); ctx.stroke(); }
    }
    for (let w = rings.length - 1; w >= 0; w--) {
      const rg = rings[w]; const k2 = (performance.now() - rg.t0) / 1200; if (k2 >= 1) { rings.splice(w, 1); continue; }
      const q = proj[rg.i]; const [r0, g0, b0] = rg.col;
      ctx.lineWidth = 2 * (1 - k2) + 0.5; ctx.strokeStyle = `rgba(${r0},${g0},${b0},${0.8 * (1 - k2)})`;
      ctx.beginPath(); ctx.arc(q.x, q.y, 6 + k2 * unit * 0.9, 0, TAU); ctx.stroke();
    }

    // impulsos: das colunas até o toroide e depois sugados em espiral; arcos entre setores de agentes
    for (let i = pulses.length - 1; i >= 0; i--) {
      const pl = pulses[i]; const kq = Math.min(1, (t - pl.t0) / pl.dur);
      let pos;
      if (pl.kind === 'stream') {
        const st = streams.find((s) => s.code === pl.code);
        if (st?.path && kq < 0.5) pos = bez(st.path, kq / 0.5);
        else { const s2 = st?.path ? (kq - 0.5) / 0.5 : kq; const ang = pl.a0 + s2 * 6; const rad = (RT + rt) * (1 - s2) + HOLE_R * s2; pos = project(Math.cos(ang) * rad, 0, Math.sin(ang) * rad); }
      } else {
        const ang = pl.a0 + (pl.a1 - pl.a0) * kq; pos = project(Math.cos(ang) * RT, Math.sin(kq * Math.PI) * 0.5, Math.sin(ang) * RT);
      }
      const [r, g, b] = pl.col; const gs = pl.big ? 28 : 18;
      ctx.globalAlpha = 0.9; ctx.drawImage(glowSprite(pl.col), pos.x - gs / 2, pos.y - gs / 2, gs, gs); ctx.globalAlpha = 1;
      ctx.fillStyle = `rgba(${Math.min(255, r + 80)},${Math.min(255, g + 80)},${Math.min(255, b + 80)},1)`; ctx.beginPath(); ctx.arc(pos.x, pos.y, pl.big ? 2.6 : 1.9, 0, TAU); ctx.fill();
      if (kq >= 1) { if (pl.then) { regionTarget[pl.then] = Math.min(1, regionTarget[pl.then] + 0.15); const idx = core.byRegion[pl.then]; for (let n = 0; n < 6; n++) core.pts[idx[(Math.random() * idx.length) | 0]].a = 1; } pulses.splice(i, 1); }
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const a of AGENT_ORDER) { const c = agentChips[a]; c.classList.toggle('thinking', regionState[a] === 'thinking'); c.classList.toggle('failed', regionState[a] === 'failed'); c.querySelector('.v').textContent = regionState[a] === 'thinking' ? `${Math.round(regionAct[a] * 100)}%` : regionState[a] === 'failed' ? 'falha' : ''; }
    raf = requestAnimationFrame(frame);
  }
  raf = requestAnimationFrame(frame);

  const regionOf = (a) => (LABELS[a] ? a : 'coordinator');
  const sectorA = (r) => (AGENT_ORDER.indexOf(r) + 0.5) / AGENT_ORDER.length * TAU;
  return {
    setStatus(text, isBusy) { statusEl.textContent = text; busy = !!isBusy; if (isBusy) regionTarget.coordinator = 0.8; },
    agent(a, stateName, note = '') {
      const r = regionOf(a); regionState[r] = stateName || '';
      const small = agentChips[r]?.querySelector('small'); if (small) small.textContent = note || ROLE[r];
      if (stateName === 'thinking') { regionTarget[r] = 1; pulses.push({ kind: 'stream', code: r, t0: performance.now(), dur: 1800, col: REGION_COLORS[r], a0: sectorA(r), then: r, big: true }); }
    },
    activate(list) { list.forEach((a) => { regionTarget[regionOf(a)] = Math.max(regionTarget[regionOf(a)], 0.4); }); },
    pulse(from, to, type) {
      const col = REGION_COLORS[regionOf(from)] || REGION_COLORS.coordinator;
      const targets = to === 'all' ? AGENT_ORDER.filter((r) => r !== 'coordinator') : [regionOf(to)];
      for (const r of targets) { const a0 = sectorA(regionOf(from)); let a1 = sectorA(r); if (a1 < a0) a1 += TAU; pulses.push({ kind: 'arc', a0, a1, t0: performance.now(), dur: type === 'challenge' ? 1300 : 1000, col, then: r, big: type === 'challenge' || type === 'synthesis' }); }
      regionTarget[regionOf(from)] = Math.min(1, regionTarget[regionOf(from)] + 0.3);
    },
    feedFromSource(code) {
      const s = srcList.find((x) => x.code === code); if (!s) return;
      pulses.push({ kind: 'stream', code, t0: performance.now(), dur: 2400, col: s.state === 'connected' ? [61, 255, 168] : [255, 181, 71], a0: Math.random() * TAU, then: 'coordinator', big: true });
    },
    setSources,
    setListening(on) { listening = !!on; el.classList.toggle('listening', listening); },
    setSpeaking(on) { speaking = !!on; el.classList.toggle('speaking', speaking); },
    setTranscript(text, kind = '') { transcriptEl.textContent = text || ''; transcriptEl.className = `core-transcript ${kind}`; },
    destroy() { if (raf) cancelAnimationFrame(raf); ro.disconnect(); },
  };
}
