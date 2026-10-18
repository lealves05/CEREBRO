// Avatar animado do assistente (canvas, sem dependências).
// Estilos: nucleo (orbe de energia), rosto (rosto de linhas que pisca e mexe a boca), holograma (cabeça em linhas de varredura),
// onda (ondas de voz em círculo). Se houver foto, ela vira o centro com um anel que reage à voz.
// Sincronia labial: setLevel(0..1) com o volume real do áudio (voz neural) ou pulse() a cada palavra (voz do navegador).
const TAU = Math.PI * 2;

function hexToRgb(h) { const n = parseInt(String(h || '#22d3ee').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function createAvatar(container, settings = {}, { size = 160, label = true } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'avatar-wrap';
  wrap.innerHTML = `<canvas class="avatar-cv" width="${size}" height="${size}" aria-hidden="true"></canvas>${label ? '<div class="avatar-name"></div>' : ''}`;
  container.appendChild(wrap);
  const cv = wrap.querySelector('canvas');
  const nameEl = wrap.querySelector('.avatar-name');
  const ctx = cv.getContext('2d');
  let dpr = 1; let W = size; let H = size;
  const st = { s: null, c1: null, c2: null, img: null, speaking: false, listening: false, thinking: false, level: 0, target: 0, kick: 0, blink: 0, nextBlink: 2 + Math.random() * 3, look: 0, t0: performance.now(), raf: 0 };

  function resize() {
    const r = cv.getBoundingClientRect();
    const px = Math.max(60, Math.round(r.width || size));
    dpr = Math.min(2, window.devicePixelRatio || 1);
    W = H = px; cv.width = px * dpr; cv.height = px * dpr;
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null;
  ro?.observe(cv);

  function update(s) {
    st.s = { name: 'Cérebro', avatar: { style: 'nucleo', color: '#22d3ee', color2: '#a855f7', image: '' }, ...s, avatar: { style: 'nucleo', color: '#22d3ee', color2: '#a855f7', image: '', ...(s?.avatar || {}) } };
    st.c1 = hexToRgb(st.s.avatar.color); st.c2 = hexToRgb(st.s.avatar.color2);
    if (nameEl) nameEl.textContent = st.s.name;
    wrap.style.setProperty('--av1', st.s.avatar.color); wrap.style.setProperty('--av2', st.s.avatar.color2);
    st.img = null;
    if (st.s.avatar.image) { const im = new Image(); im.onload = () => { st.img = im; }; im.src = st.s.avatar.image; }
  }

  // ---------- desenho ----------
  function glowCircle(x, y, r, c, a) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(1, r));
    g.addColorStop(0, rgba(c, a)); g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, Math.max(1, r), 0, TAU); ctx.fill();
  }

  function drawNucleo(t, cx, cy, R, L) {
    glowCircle(cx, cy, R * (1.05 + L * 0.35), st.c2, 0.35 + L * 0.3);
    for (let i = 0; i < 3; i++) {
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(t * (0.4 + i * 0.25) * (i % 2 ? -1 : 1));
      ctx.strokeStyle = rgba(i % 2 ? st.c2 : st.c1, 0.75 - i * 0.18); ctx.lineWidth = Math.max(1, R * 0.03);
      ctx.beginPath(); ctx.ellipse(0, 0, R * (0.62 + i * 0.13), R * (0.24 + i * 0.1 + L * 0.08), i * 0.9, 0, TAU * 0.78); ctx.stroke();
      ctx.restore();
    }
    const core = R * (0.28 + L * 0.16 + Math.sin(t * 2.2) * 0.015);
    glowCircle(cx, cy, core * 2.1, st.c1, 0.9);
    ctx.fillStyle = 'rgba(255,255,255,.92)'; ctx.beginPath(); ctx.arc(cx, cy, core * 0.55, 0, TAU); ctx.fill();
    for (let i = 0; i < 14; i++) {
      const a = t * 0.6 + i * (TAU / 14); const rr = R * (0.85 + 0.08 * Math.sin(t * 1.7 + i));
      ctx.fillStyle = rgba(i % 2 ? st.c1 : st.c2, 0.8); ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.9, Math.max(0.8, R * 0.018), 0, TAU); ctx.fill();
    }
  }

  function drawRosto(t, cx, cy, R, L) {
    glowCircle(cx, cy, R * 1.15, st.c2, 0.22 + L * 0.2);
    ctx.lineWidth = Math.max(1.2, R * 0.035); ctx.strokeStyle = rgba(st.c1, 0.95); ctx.shadowColor = rgba(st.c1, 0.9); ctx.shadowBlur = R * 0.12;
    // contorno do rosto
    ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.02, R * 0.62, R * 0.78, 0, 0, TAU); ctx.stroke();
    // olhos (piscam; olham levemente para os lados)
    const ey = cy - R * 0.16; const ex = R * 0.24; const lx = Math.sin(st.look) * R * 0.03;
    const open = Math.max(0.08, 1 - st.blink) * (st.listening ? 1.25 : 1);
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(cx + s * ex + lx, ey, R * 0.085, R * 0.085 * open, 0, 0, TAU); ctx.stroke();
      ctx.fillStyle = rgba(st.c1, 0.95); ctx.beginPath(); ctx.arc(cx + s * ex + lx, ey, R * 0.035 * Math.min(1, open), 0, TAU); ctx.fill();
    }
    // sobrancelhas (sobem ao ouvir/pensar)
    const lift = (st.listening ? 0.05 : 0) + (st.thinking ? 0.03 * Math.sin(t * 3) : 0);
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + s * (ex - R * 0.11), ey - R * (0.16 + lift)); ctx.quadraticCurveTo(cx + s * ex, ey - R * (0.21 + lift), cx + s * (ex + R * 0.11), ey - R * (0.15 + lift)); ctx.stroke(); }
    // boca: abre com a voz; sorriso leve em repouso
    const my = cy + R * 0.33; const mw = R * (0.2 + L * 0.06); const mh = R * (0.015 + L * 0.2);
    ctx.beginPath();
    if (mh < R * 0.03) { ctx.moveTo(cx - mw, my - R * 0.01); ctx.quadraticCurveTo(cx, my + R * 0.07, cx + mw, my - R * 0.01); ctx.stroke(); }
    else { ctx.ellipse(cx, my, mw, mh, 0, 0, TAU); ctx.stroke(); ctx.fillStyle = rgba(st.c2, 0.35 + L * 0.4); ctx.fill(); }
    ctx.shadowBlur = 0;
    // linhas de circuito laterais
    ctx.lineWidth = Math.max(1, R * 0.015); ctx.strokeStyle = rgba(st.c2, 0.55);
    for (const s of [-1, 1]) { ctx.beginPath(); ctx.moveTo(cx + s * R * 0.62, cy); ctx.lineTo(cx + s * R * 0.8, cy); ctx.lineTo(cx + s * R * 0.86, cy - R * 0.12); ctx.stroke(); }
  }

  function drawHolograma(t, cx, cy, R, L) {
    glowCircle(cx, cy, R * 1.1, st.c1, 0.18 + L * 0.2);
    const lines = 26;
    for (let i = 0; i < lines; i++) {
      const y = -0.85 + (i / (lines - 1)) * 1.7;
      // perfil de cabeça: crânio + queixo + pescoço
      let w = y < 0.35 ? Math.sqrt(Math.max(0, 1 - ((y + 0.1) / 0.78) ** 2)) * 0.6 : Math.max(0.18, 0.42 - (y - 0.35) * 0.9);
      const mouth = y > 0.18 && y < 0.38 ? 1 : 0;
      const flick = 0.75 + 0.25 * Math.sin(t * 9 + i * 1.3);
      ctx.strokeStyle = rgba(i % 3 ? st.c1 : st.c2, (0.35 + 0.5 * flick) * (st.thinking ? 0.8 + 0.2 * Math.sin(t * 6) : 1));
      ctx.lineWidth = Math.max(1, R * 0.018);
      const yy = cy + y * R; const ww = w * R;
      ctx.beginPath();
      if (mouth && L > 0.05) {
        const gap = R * (0.05 + L * 0.12);
        ctx.moveTo(cx - ww, yy); ctx.lineTo(cx - gap, yy); ctx.moveTo(cx + gap, yy); ctx.lineTo(cx + ww, yy);
      } else { ctx.moveTo(cx - ww, yy); ctx.lineTo(cx + ww, yy); }
      ctx.stroke();
    }
    // olhos
    for (const s of [-1, 1]) glowCircle(cx + s * R * 0.2, cy - R * 0.12, R * 0.09 * Math.max(0.2, 1 - st.blink), st.c1, 0.95);
    // varredura
    const sy = cy + ((t * 0.5) % 1.8 - 0.9) * R;
    ctx.fillStyle = rgba(st.c1, 0.12); ctx.fillRect(cx - R, sy, R * 2, R * 0.05);
  }

  function drawOnda(t, cx, cy, R, L) {
    glowCircle(cx, cy, R * (0.7 + L * 0.4), st.c2, 0.35);
    const bars = 64;
    for (let i = 0; i < bars; i++) {
      const a = (i / bars) * TAU - Math.PI / 2;
      const n = Math.abs(Math.sin(i * 0.7 + t * 5)) * 0.5 + Math.abs(Math.sin(i * 0.23 - t * 3)) * 0.5;
      const len = R * (0.08 + (0.04 + L * 0.42) * n);
      const r0 = R * 0.48;
      ctx.strokeStyle = rgba(i % 2 ? st.c1 : st.c2, 0.85); ctx.lineWidth = Math.max(1.2, R * 0.03); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * (r0 + len), cy + Math.sin(a) * (r0 + len)); ctx.stroke();
    }
    ctx.fillStyle = rgba(st.c1, 0.9); ctx.beginPath(); ctx.arc(cx, cy, R * (0.2 + L * 0.08), 0, TAU); ctx.fill();
  }

  function drawFoto(t, cx, cy, R, L) {
    drawOnda(t, cx, cy, R, L);
    const r = R * 0.46;
    ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.clip();
    const im = st.img; const k = Math.max((r * 2) / im.width, (r * 2) / im.height);
    ctx.drawImage(im, cx - (im.width * k) / 2, cy - (im.height * k) / 2, im.width * k, im.height * k);
    ctx.restore();
    ctx.strokeStyle = rgba(st.c1, 0.9 - L * 0.3); ctx.lineWidth = Math.max(1.5, R * 0.03 + L * R * 0.05);
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke();
  }

  function frame(now) {
    st.raf = requestAnimationFrame(frame);
    const t = (now - st.t0) / 1000;
    // nível da voz: valor real (setLevel) ou animação procedural enquanto fala, com "chutes" por palavra
    st.kick *= 0.88;
    const proc = st.speaking ? 0.25 + 0.35 * Math.abs(Math.sin(t * 11)) * Math.abs(Math.sin(t * 3.7 + 1)) + st.kick : 0;
    const want = Math.max(st.target, proc, st.listening ? 0.08 + 0.05 * Math.sin(t * 4) : 0);
    st.level += (Math.min(1, want) - st.level) * 0.35;
    st.target *= 0.9;
    // piscar e olhar
    st.nextBlink -= 1 / 60;
    if (st.nextBlink <= 0) { st.blink = 1; st.nextBlink = 2.5 + Math.random() * 4; }
    st.blink = Math.max(0, st.blink - 0.12);
    st.look += 0.01 + (st.thinking ? 0.03 : 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2; const cy = H / 2; const R = W * 0.42;
    const style = st.s?.avatar?.style || 'nucleo';
    if (st.img) drawFoto(t, cx, cy, R, st.level);
    else if (style === 'rosto') drawRosto(t, cx, cy, R, st.level);
    else if (style === 'holograma') drawHolograma(t, cx, cy, R, st.level);
    else if (style === 'onda') drawOnda(t, cx, cy, R, st.level);
    else drawNucleo(t, cx, cy, R, st.level);
    if (st.listening) { ctx.strokeStyle = rgba(st.c1, 0.5 + 0.3 * Math.sin(t * 6)); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, R * 1.02, 0, TAU); ctx.stroke(); }
  }

  update(settings);
  resize();
  st.raf = requestAnimationFrame(frame);
  return {
    el: wrap,
    update,
    setSpeaking(on) { st.speaking = !!on; wrap.classList.toggle('speaking', !!on); },
    setListening(on) { st.listening = !!on; wrap.classList.toggle('listening', !!on); },
    setThinking(on) { st.thinking = !!on; wrap.classList.toggle('thinking', !!on); },
    setLevel(v) { st.target = Math.max(st.target, Math.min(1, Number(v) || 0)); },
    pulse(a = 0.45) { st.kick = Math.min(0.8, st.kick + a); },
    destroy() { cancelAnimationFrame(st.raf); ro?.disconnect(); wrap.remove(); },
  };
}
