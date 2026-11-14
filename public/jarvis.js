// JARVIS — HUD de tela única do Cérebro LORLER: sinais vitais, comandos, agenda, áudio, cofre e conversa por voz.
// Também: "apertar para falar" (barra de espaço no computador, botão grande no celular) e o navegador do cofre.
import { createBrain } from './neural.js?v=20261109a';
import { sparkline } from './hud.js?v=20261007a';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FOLDER_ICON = { raw: '◌', wiki: '◆', outputs: '▲', diario: '●' };
const FOLDER_NAME = { raw: 'raw', wiki: 'wiki', outputs: 'outputs', diario: 'diário' };
const COLORS = { cpu: '#4ade80', mem: '#2dd4bf', disk: '#7aa2ff', net: '#c4a8ff' };

// ------------------------------------------------------------------------------------------------
// Apertar para falar. Dois ouvidos:
//   - "local": grava com o MediaRecorder e manda para o Whisper da VPS (o áudio não sai do servidor);
//   - "navegador": reconhecimento do próprio navegador enquanto o botão está apertado (fallback).
export function createPtt({ api, state, voice, handsFree, toast }) {
  const p = {
    active: false, rec: null, chunks: [], stream: null, actx: null, raf: 0, sr: null, onText: null, onState: null, onLevel: null, started: 0,
    engine() {
      const want = state.assistant?.settings?.voice?.stt || 'local';
      const local = !!state.assistant?.stt_local && !!window.MediaRecorder && !!navigator.mediaDevices?.getUserMedia;
      if (want === 'local' && local) return 'local';
      if (window.SpeechRecognition || window.webkitSpeechRecognition) return 'navegador';
      return local ? 'local' : null;
    },
    emit(st, extra) { (this.onState || this.defaultState)?.(st, extra); },
    async start() {
      if (this.active) return;
      const eng = this.engine();
      if (!eng) { toast('Este navegador não consegue ouvir. Use o Chrome ou o Edge, ou instale a voz local na VPS.', true); return; }
      this.active = true; this.started = Date.now();
      voice.stop(); handsFree.hold(true);
      voice.emit({ listening: true }); this.emit('ouvindo', { engine: eng });
      if (eng === 'navegador') return this.startBrowser();
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      } catch { this.active = false; handsFree.hold(false); voice.emit({ listening: false }); this.emit('erro'); toast('Permita o uso do microfone para falar comigo.', true); return; }
      if (!this.active) { this.stream.getTracks().forEach((t) => t.stop()); return; } // soltou antes de liberar o microfone
      const mime = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder.isTypeSupported?.(m)) || '';
      this.chunks = [];
      this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
      this.rec.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
      this.rec.start(250);
      this.meter(this.stream);
      this.limit = setTimeout(() => this.stop(), 55_000); // o servidor aceita até ~60 s
    },
    meter(stream) {
      try {
        this.actx ||= new (window.AudioContext || window.webkitAudioContext)();
        const src = this.actx.createMediaStreamSource(stream); const an = this.actx.createAnalyser(); an.fftSize = 512; src.connect(an);
        const buf = new Uint8Array(an.fftSize);
        const loop = () => { an.getByteTimeDomainData(buf); let s = 0; for (const x of buf) s += ((x - 128) / 128) ** 2; const lv = Math.min(1, Math.sqrt(s / buf.length) * 5); this.onLevel?.(lv); voice.emit({ level: lv }); this.raf = requestAnimationFrame(loop); };
        loop();
      } catch { /* sem medidor */ }
    },
    startBrowser() {
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const sr = new SR(); this.sr = sr; this.heard = '';
      sr.lang = 'pt-BR'; sr.interimResults = true; sr.continuous = true;
      sr.onresult = (e) => { this.heard = [...e.results].map((r) => r[0].transcript).join(' '); this.emit('ouvindo', { engine: 'navegador', partial: this.heard }); };
      sr.onerror = (e) => { if (e.error === 'not-allowed') toast('Permita o uso do microfone para falar comigo.', true); };
      sr.onend = () => { if (this.sr === sr) this.finishBrowser(); };
      try { sr.start(); } catch { /* já iniciado */ }
    },
    finishBrowser() {
      const t = (this.heard || '').trim(); this.sr = null;
      this.done(); if (t) (this.onText || this.defaultText)?.(t); else this.emit('vazio');
    },
    async stop() {
      if (!this.active) return;
      this.active = false; clearTimeout(this.limit);
      if (this.sr) { const sr = this.sr; setTimeout(() => { try { sr.stop(); } catch { /* */ } }, 350); return; } // deixa terminar a última palavra
      const rec = this.rec; this.rec = null;
      if (!rec) { this.done(); return; }
      const stopped = new Promise((r) => { rec.onstop = r; });
      try { rec.stop(); } catch { /* */ }
      await stopped;
      this.stream?.getTracks().forEach((t) => t.stop()); this.stream = null;
      cancelAnimationFrame(this.raf); this.onLevel?.(0);
      const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
      if (Date.now() - this.started < 450 || blob.size < 1500) { this.done(); this.emit('vazio'); return; }
      this.emit('transcrevendo');
      try {
        const b64 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.onerror = rej; fr.readAsDataURL(blob); });
        const r = await api('POST', '/api/stt', { audio: b64, mime: blob.type });
        this.done();
        if (r.text?.trim()) (this.onText || this.defaultText)?.(r.text.trim()); else this.emit('vazio');
      } catch (e) { this.done(); this.emit('erro'); toast(`Voz: ${e.message}`, true); }
    },
    done() { cancelAnimationFrame(this.raf); voice.emit({ listening: false }); handsFree.hold(false); this.emit('pronto'); },
  };
  return p;
}

// Liga a barra de espaço (segurar = falar) em qualquer tela, fora de campos de texto.
export function bindSpacebar(ptt) {
  if (window.__pttBound) return; window.__pttBound = true;
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.altKey || e.metaKey || typing(document.activeElement) || document.querySelector('.modal:not(.hidden)')) return;
    e.preventDefault(); ptt.start();
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space' && ptt.active) { e.preventDefault(); ptt.stop(); } });
  window.addEventListener('blur', () => { if (ptt.active) ptt.stop(); });
}

// Botão "segure para falar" (toque e segure no celular; clique e segure no computador).
export function bindHoldButton(btn, ptt) {
  const down = (e) => { e.preventDefault(); btn.setPointerCapture?.(e.pointerId); ptt.start(); };
  const up = (e) => { e.preventDefault(); ptt.stop(); };
  btn.addEventListener('pointerdown', down);
  btn.addEventListener('pointerup', up); btn.addEventListener('pointercancel', up);
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ------------------------------------------------------------------------------------------------
// HUD
export async function viewJarvis(c, deps) {
  const { api, state, voice, toast, fail, svg, modal, ptt } = deps;
  const st = await api('GET', '/api/jarvis/state');
  const s = state.assistant?.settings || { name: 'Cérebro' };
  const name = (s.name || 'Cérebro').toUpperCase();
  const hist = { cpu: [], mem: [], disk: [], net: [] };
  c.innerHTML = `<div class="jv">
    <div class="jv-vitals">
      ${['cpu', 'mem', 'disk', 'net'].map((k) => `<div class="panel jv-vital" data-v="${k}"><span class="jv-lbl">${{ cpu: 'CPU', mem: 'MEMÓRIA', disk: 'DISCO', net: 'REDE' }[k]}</span><b class="jv-val mono">—</b><div class="jv-spark"></div></div>`).join('')}
      <div class="panel jv-clock"><b class="mono" id="jv-time">--:--</b><span class="small" id="jv-date"></span><span class="jv-secure ${st.status.acesso_seguro ? 'on' : ''}">${svg('shield')} ${st.status.acesso_seguro ? 'SISTEMA SEGURO' : 'AMBIENTE LOCAL'}</span></div>
    </div>
    <div class="jv-main">
      <section class="panel jv-cmds">
        <h3 class="jv-h">COMANDOS RÁPIDOS</h3>
        <div class="jv-cmd-list">
          ${[['falar', 'falar', 'Segure para falar'], ['plano', 'plano de hoje', 'Seu top 3'], ['lembrar', 'lembrar', 'Guardar no cofre'], ['resumo', 'resumo da manhã', 'Caixa de entrada'], ['metricas', 'métricas', 'Seus números'], ['tendencias', 'tendências', 'O que está mudando'], ['reuniao', 'reunião de marketing', 'Posts, anúncio e ações'], ['agenda', 'posts agendados', 'Instagram, Face, TikTok, LinkedIn'], ['cofre', 'abrir cofre', 'Memória'], ['encerrar', 'encerrar o dia', 'Reflexão']].map(([k, l, d]) => `<button class="jv-cmd" data-cmd="${k}"><span class="mono">&gt; ${esc(l)}</span><small>${esc(d)}</small></button>`).join('')}
        </div>
      </section>
      <section class="panel jv-core">
        <div class="jv-name"><b>${esc(name)}</b><span class="jv-online"><i></i>ONLINE</span></div>
        <div class="jv-orb" id="jv-orb"></div>
        <div class="jv-say" id="jv-say"><span class="muted">${st.top3 ? 'Pronto. Segure o botão (ou a barra de espaço) e fale.' : 'Bom te ver. Que tal começar pelo plano de hoje?'}</span></div>
        <button class="jv-ptt" id="jv-ptt" aria-label="Segure para falar"><span class="jv-ptt-ring"></span>${svg('mic')}<span class="jv-ptt-txt">Segure para falar</span></button>
        <form class="jv-input" id="jv-form"><input name="q" placeholder="Digite um comando… (ou segure a barra de espaço)" autocomplete="off" maxlength="600"><button class="btn icon primary" title="Enviar">${svg('send')}</button></form>
      </section>
      <section class="panel jv-vault">
        <h3 class="jv-h">COFRE <button class="btn sm ghost" id="jv-vault-open">abrir</button></h3>
        <div class="jv-vault-total"><b class="mono" id="jv-vtotal">${st.vault.total}</b><span class="small">notas no cofre</span></div>
        <div id="jv-vbars"></div>
        <div class="jv-recent" id="jv-recent"></div>
      </section>
    </div>
    <div class="jv-bottom">
      <section class="panel jv-agenda"><h3 class="jv-h">AGENDA DE HOJE</h3><div id="jv-agenda"></div></section>
      <section class="panel jv-top3"><h3 class="jv-h">TOP 3 <button class="btn sm ghost" data-cmd="plano">definir</button></h3><div id="jv-top3"></div></section>
      <section class="panel jv-audio"><h3 class="jv-h">ÁUDIO</h3>
        <div class="jv-io"><span>Entrada</span><b id="jv-in"></b><div class="jv-meter"><i id="jv-level"></i></div></div>
        <div class="jv-io"><span>Saída</span><b id="jv-out"></b><button class="btn sm ghost" id="jv-vtoggle">${voice.enabled ? 'voz ligada' : 'voz desligada'}</button></div>
        <div class="small muted" id="jv-voice-hint"></div>
      </section>
    </div>
    <footer class="jv-status" id="jv-status"></footer>
  </div>`;

  // núcleo animado
  let brain = null;
  try { brain = createBrain($('#jv-orb', c), { compact: true, label: '' }); brain.setStatus('', false); } catch { /* visual opcional */ }
  const vsub = (ev) => {
    if (!brain) return;
    if ('speaking' in ev) brain.setSpeaking?.(ev.speaking);
    if ('listening' in ev) brain.setListening?.(ev.listening);
    if (ev.level != null && ev.level > 0.35 && Date.now() - (vsub.at || 0) > 280) { vsub.at = Date.now(); brain.pulse?.('coordinator', 'all', 'message'); }
  };
  voice.subs.add(vsub);

  const say = $('#jv-say', c); const pttBtn = $('#jv-ptt', c);
  const showSay = (who, text) => { say.innerHTML = `<span class="jv-who">${who === 'me' ? 'VOCÊ' : esc(name)}</span>${esc(text)}`; };

  // envio para a conversa (mesma conversa do assistente flutuante: histórico e voz)
  const ask = async (text, { spoken = false } = {}) => {
    if (!text) return;
    showSay('me', text);
    brain?.setStatus('', true);
    try {
      let r;
      if (state.dockSend) r = await state.dockSend(text, { spoken, quiet: true });
      else { r = await api('POST', '/api/conversation', { message: text, channel: spoken ? 'voice' : 'text' }); voice.speak(r.reply); }
      if (r?.reply) showSay('bot', r.reply);
      refresh();
    } catch (e) { fail(e); } finally { brain?.setStatus('', false); }
  };

  // apertar para falar
  ptt.onText = (t) => ask(t, { spoken: true });
  ptt.onLevel = (lv) => { const el = $('#jv-level', c); if (el) el.style.width = `${Math.round(lv * 100)}%`; };
  ptt.onState = (stt, extra) => {
    pttBtn.classList.toggle('on', stt === 'ouvindo'); pttBtn.classList.toggle('busy', stt === 'transcrevendo');
    $('.jv-ptt-txt', pttBtn).textContent = stt === 'ouvindo' ? (extra?.partial ? `“${extra.partial.slice(-60)}”` : 'Ouvindo… solte para enviar') : stt === 'transcrevendo' ? 'Entendendo…' : 'Segure para falar';
    if (stt === 'vazio') toast('Não ouvi nada. Segure o botão enquanto fala.');
  };
  bindHoldButton(pttBtn, ptt);

  $('#jv-form', c).onsubmit = (e) => { e.preventDefault(); const t = e.target.q.value.trim(); if (!t) return; e.target.q.value = ''; ask(t); };
  c.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cmd]'); if (!b) return;
    const k = b.dataset.cmd;
    if (k === 'falar') { toast('Segure o botão do microfone (ou a barra de espaço) enquanto fala.'); pttBtn.focus(); return; }
    if (k === 'cofre') { openVault(deps); return; }
    if (k === 'lembrar') {
      modal(`<h2>Lembrar</h2><form id="lm" class="grid"><label class="field">O que eu devo guardar no cofre?<textarea name="t" rows="3" required maxlength="1500" placeholder="Ex.: o reajuste do ORBI entra em dezembro"></textarea></label><div class="row"><button class="btn primary">Guardar</button><button type="button" class="btn ghost" data-close>Cancelar</button></div></form>`, (m, close) => {
        $$('[data-close]', m).forEach((b) => { b.onclick = close; }); setTimeout(() => $('textarea', m)?.focus(), 50);
        $('#lm', m).onsubmit = async (ev) => { ev.preventDefault(); const t = ev.target.t.value.trim(); close(); ask(`lembre que ${t}`); };
      });
      return;
    }
    const phrase = { plano: 'plano de hoje', resumo: 'resumo da manhã', metricas: 'métricas', tendencias: 'tendências', encerrar: 'encerrar o dia', reuniao: 'reunião de marketing', agenda: 'o que está agendado?' }[k];
    if (phrase) ask(phrase);
  });
  $('#jv-vault-open', c).onclick = () => openVault(deps);
  $('#jv-vtoggle', c).onclick = (e) => { const on = voice.toggle(); e.currentTarget.textContent = on ? 'voz ligada' : 'voz desligada'; const vt = $('#vtoggle'); if (vt) vt.innerHTML = svg(on ? 'speaker' : 'mute'); };

  // ---------- pintura ----------
  const paintVitals = (v) => {
    const set = (k, val, txt) => { hist[k].push(val ?? 0); if (hist[k].length > 40) hist[k].shift(); const el = $(`[data-v="${k}"]`, c); if (!el) return; $('.jv-val', el).textContent = txt; $('.jv-spark', el).innerHTML = sparkline(hist[k], COLORS[k], { w: 160, h: 34 }); };
    set('cpu', v.cpu, v.cpu == null ? '—' : `${v.cpu}%`);
    set('mem', v.mem?.pct, v.mem ? `${v.mem.pct}%` : '—');
    set('disk', v.disk?.pct, v.disk ? `${v.disk.pct}%` : '—');
    const kb = (n) => (n >= 1024 ? `${(n / 1024).toFixed(1)} MB/s` : `${n} KB/s`);
    set('net', v.net ? v.net.down_kbs + v.net.up_kbs : null, v.net ? `↓ ${kb(v.net.down_kbs)} ↑ ${kb(v.net.up_kbs)}` : '—');
    const nk = $('[data-v="net"] .jv-val', c); if (nk) nk.classList.add('jv-small');
  };
  const paintState = (x) => {
    const v = x.vault;
    const max = Math.max(1, ...Object.values(v.by_folder));
    $('#jv-vtotal', c).textContent = v.total.toLocaleString('pt-BR');
    $('#jv-vbars', c).innerHTML = Object.entries(v.by_folder).map(([f, n]) => `<button class="jv-vbar" data-folder="${f}"><span>${FOLDER_ICON[f]} ${FOLDER_NAME[f]}</span><i style="--w:${Math.round((n / max) * 100)}%"></i><b class="mono">${n}</b></button>`).join('');
    $('#jv-recent', c).innerHTML = v.recent.length ? v.recent.slice(0, 5).map((n) => `<button class="jv-note" data-path="${esc(n.path)}"><span class="mono small">${esc(n.path)}</span>${esc(n.title)}</button>`).join('') : '<p class="small muted">O cofre começa vazio. Converse comigo e diga “lembre que…”.</p>';
    $('#jv-agenda', c).innerHTML = x.agenda.map((a) => `<div class="jv-ag ${a.done ? 'done' : a.upcoming ? 'next' : 'late'}"><b class="mono">${esc(a.time)}</b><span>${esc(a.label)}</span><button class="btn sm ghost" data-run="${a.slot}" title="Rodar agora">${a.done ? '✓' : 'rodar'}</button></div>`).join('')
      + `<div class="small muted" style="margin-top:6px">${x.routine.enabled ? `Rotina automática ligada${x.status.whatsapp_vinculado && x.routine.whatsapp ? ' · também pelo WhatsApp' : ''}.` : 'Rotina automática desligada.'} <a href="#" id="jv-routine-cfg">ajustar</a></div>`;
    $('#jv-top3', c).innerHTML = x.top3 ? `<ol class="jv-t3">${x.top3.map((t) => `<li>${esc(t.replace(/\[\[|\]\]/g, ''))}</li>`).join('')}</ol>` : '<p class="small muted">Ainda não definido. Diga “minhas prioridades são…” ou toque em definir.</p>';
    const sttTxt = x.status.stt_local && (s.voice?.stt || 'local') === 'local' ? 'Whisper na VPS (privado)' : 'Navegador';
    const ttsTxt = { local: 'Kokoro na VPS (privado)', browser: 'Voz do aparelho', openai: 'Neural OpenAI', elevenlabs: 'ElevenLabs' }[x.status.tts_engine] || x.status.tts_engine;
    $('#jv-in', c).textContent = sttTxt; $('#jv-out', c).textContent = ttsTxt;
    $('#jv-voice-hint', c).innerHTML = x.status.stt_local && x.status.tts_local ? 'Voz 100% local: o áudio não sai do servidor.' : 'Voz local ainda não instalada na VPS — rode o <b>VPS-MENU › I</b>. Enquanto isso, uso a voz do navegador.';
    const dot = (on, label, warn = false) => `<span class="jv-st ${on ? 'on' : warn ? 'warn' : 'off'}"><i></i>${label}</span>`;
    $('#jv-status', c).innerHTML = [
      dot(true, 'SISTEMA ATIVO'),
      dot(x.status.stt_local, 'VOZ LOCAL', !x.status.stt_local),
      dot(x.status.tts_online, 'TTS ONLINE'),
      dot(x.status.acesso_seguro, 'ACESSO SEGURO', !x.status.acesso_seguro),
      dot(x.status.master, x.status.master ? 'DADOS ATUALIZADOS' : 'DADOS DE DEMONSTRAÇÃO', !x.status.master),
      dot(x.status.whatsapp_vinculado, 'WHATSAPP', !x.status.whatsapp_vinculado),
      x.pending ? `<a class="jv-st warn" href="#/aprovacoes"><i></i>${x.pending} APROVAÇÃO(ÕES)</a>` : '',
    ].join('');
  };
  paintVitals(st.vitals); paintState(st);

  c.addEventListener('click', async (e) => {
    const run = e.target.closest('[data-run]');
    if (run) { run.disabled = true; try { const r = await api('POST', `/api/jarvis/routine/${run.dataset.run}/run`, {}); showSay('bot', r.reply); voice.speak(r.reply); refresh(); } catch (err) { fail(err); } finally { run.disabled = false; } return; }
    const note = e.target.closest('[data-path]'); if (note) { openVault(deps, { path: note.dataset.path }); return; }
    const fol = e.target.closest('[data-folder]'); if (fol) { openVault(deps, { folder: fol.dataset.folder }); return; }
    if (e.target.id === 'jv-routine-cfg') { e.preventDefault(); routineModal(deps, refresh); }
  });

  const tick = () => { const tz = state.me?.organization?.timezone || 'America/Sao_Paulo'; const d = new Date(); const t = $('#jv-time', c); if (!t) return; t.textContent = d.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' }); $('#jv-date', c).textContent = d.toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(); };
  tick();
  async function refresh() { try { paintState(await api('GET', '/api/jarvis/state')); } catch { /* silencioso */ } }
  const iv = [setInterval(tick, 1000), setInterval(async () => { if (document.hidden) return; try { paintVitals(await api('GET', '/api/jarvis/vitals')); } catch { /* */ } }, 4000), setInterval(() => { if (!document.hidden) refresh(); }, 60_000)];
  return () => { iv.forEach(clearInterval); voice.subs.delete(vsub); brain?.destroy(); ptt.onText = null; ptt.onState = null; ptt.onLevel = null; };
}

function routineModal({ api, modal, toast, fail }, after) {
  api('GET', '/api/jarvis/routine').then((r) => {
    modal(`<h2>Rotina do dia</h2><p class="small muted">Em cada horário eu faço a etapa sozinho e gravo no cofre. Com o WhatsApp vinculado, a pergunta chega lá e a sua resposta vai direto para o diário.</p>
      <form id="rf" class="grid">
        <label class="chip ${r.enabled ? 'on' : ''}"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}>Rotina automática ligada</label>
        ${Object.entries(r.labels).map(([k, l]) => `<label class="field">${esc(l)}<input type="time" name="${k}" value="${esc(r.times[k])}" required></label>`).join('')}
        <label class="chip ${r.whatsapp ? 'on' : ''}"><input type="checkbox" name="whatsapp" ${r.whatsapp ? 'checked' : ''}>Mandar também pelo WhatsApp</label>
        <label class="chip ${r.voice_reply ? 'on' : ''}"><input type="checkbox" name="voice_reply" ${r.voice_reply ? 'checked' : ''}>Áudio no WhatsApp: responder com áudio</label>
        <div class="row"><button class="btn primary">Salvar</button><button type="button" class="btn ghost" data-close>Cancelar</button></div></form>`, (m, close) => {
      $$('[data-close]', m).forEach((b) => { b.onclick = close; });
      $('#rf', m).onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        try { await api('PUT', '/api/jarvis/routine', { enabled: f.enabled.checked, whatsapp: f.whatsapp.checked, voice_reply: f.voice_reply.checked, times: Object.fromEntries(Object.keys(r.labels).map((k) => [k, f[k].value])) }); close(); toast('Rotina salva.'); after?.(); } catch (err) { fail(err); }
      };
    });
  }).catch(fail);
}

// ------------------------------------------------------------------------------------------------
// Cofre: pastas, notas (ver e editar em markdown), busca, grafo, exportar para o Obsidian e token de sincronização.
export function openVault(deps, { folder = null, path = null } = {}) {
  const { api, modal, toast, fail } = deps;
  modal(`<div class="vault">
    <header class="vault-head"><h2>Cofre</h2><input class="vault-q" id="vq" placeholder="Buscar no cofre…"><button class="btn sm ghost" id="vgraph">grafo</button><a class="btn sm ghost" href="/api/vault/export" download>exportar (.zip)</a><button class="btn sm ghost" id="vtoken">Obsidian no PC</button><button class="btn sm ghost" data-close>fechar</button></header>
    <nav class="vault-tabs">${['', 'diario', 'wiki', 'outputs', 'raw'].map((f) => `<button data-f="${f}" class="${(folder || '') === f ? 'on' : ''}">${f ? `${FOLDER_ICON[f]} ${FOLDER_NAME[f]}` : 'tudo'}</button>`).join('')}</nav>
    <div class="vault-body"><div class="vault-list" id="vlist"></div><div class="vault-view" id="vview"><p class="muted small">Escolha uma nota. Tudo aqui é markdown: abre igual no Obsidian.</p></div></div>
  </div>`, (m, close) => {
    m.firstElementChild?.classList.add('wide');
    $$('[data-close]', m).forEach((b) => { b.onclick = close; });
    let cur = folder;
    const list = async (f = cur) => {
      cur = f; $$('.vault-tabs button', m).forEach((b) => b.classList.toggle('on', (b.dataset.f || null) === (f || null)));
      try {
        const r = await api('GET', `/api/vault${f ? `?folder=${f}` : ''}`);
        $('#vlist', m).innerHTML = r.notes.length ? r.notes.map((n) => `<button class="vault-item" data-open="${esc(n.path)}"><b>${esc(n.title)}</b><span class="mono small">${esc(n.path)}</span><span class="small muted">${esc(n.excerpt)}</span></button>`).join('') : '<p class="small muted" style="padding:12px">Nada aqui ainda.</p>';
      } catch (e) { fail(e); }
    };
    const open = async (p) => {
      try {
        const n = await api('GET', `/api/vault/note?path=${encodeURIComponent(p)}`);
        $('#vview', m).innerHTML = `<div class="vault-note-head"><span class="mono small">${esc(n.path)}</span><span class="small muted">atualizado ${new Date(n.updated_at).toLocaleString('pt-BR')}</span></div>
          <div class="vault-md" id="vmd">${md(n.content)}</div>
          <textarea class="vault-edit hidden" id="ved" spellcheck="false">${esc(n.content)}</textarea>
          <div class="row"><button class="btn sm" id="vedit">editar</button><button class="btn sm primary hidden" id="vsave">salvar</button><button class="btn sm ghost danger" id="vdel">apagar</button></div>`;
        $('#vedit', m).onclick = () => { $('#vmd', m).classList.add('hidden'); $('#ved', m).classList.remove('hidden'); $('#vsave', m).classList.remove('hidden'); $('#vedit', m).classList.add('hidden'); $('#ved', m).focus(); };
        $('#vsave', m).onclick = async () => { try { await api('PUT', '/api/vault/note', { path: n.path, title: n.title, content: $('#ved', m).value }); toast('Nota salva.'); open(n.path); list(); } catch (e) { fail(e); } };
        $('#vdel', m).onclick = async () => { if (!confirm('Apagar esta nota do cofre?')) return; try { await api('POST', '/api/vault/note/delete', { path: n.path }); $('#vview', m).innerHTML = '<p class="muted small">Nota apagada.</p>'; list(); } catch (e) { fail(e); } };
        $('#vmd', m).onclick = (e) => { const a = e.target.closest('[data-link]'); if (a) search(a.dataset.link); };
      } catch (e) { fail(e); }
    };
    const search = async (qq) => {
      $('#vq', m).value = qq;
      if (!qq.trim()) return list();
      try {
        const r = await api('GET', `/api/vault/search?q=${encodeURIComponent(qq)}`);
        $('#vlist', m).innerHTML = r.results.length ? r.results.map((n) => `<button class="vault-item" data-open="${esc(n.path)}"><b>${esc(n.title)}</b><span class="mono small">${esc(n.path)}</span><span class="small muted">${esc(n.snippet)}</span></button>`).join('') : '<p class="small muted" style="padding:12px">Nada encontrado.</p>';
      } catch (e) { fail(e); }
    };
    m.addEventListener('click', (e) => {
      const t = e.target.closest('[data-f]'); if (t && t.closest('.vault-tabs')) { list(t.dataset.f || null); return; }
      const o = e.target.closest('[data-open]'); if (o) open(o.dataset.open);
    });
    let tq = 0; $('#vq', m).oninput = (e) => { clearTimeout(tq); tq = setTimeout(() => search(e.target.value), 250); };
    $('#vgraph', m).onclick = () => drawGraph(deps, m);
    $('#vtoken', m).onclick = async () => {
      if (!confirm('Gerar um token novo para sincronizar o cofre com o Obsidian no seu PC? (o anterior deixa de valer)')) return;
      try {
        const r = await api('POST', '/api/vault/token', {});
        $('#vview', m).innerHTML = `<h3>Obsidian no PC</h3><ol class="small"><li>No PC, rode <b>SINCRONIZAR-COFRE.bat</b> (pasta do Cérebro).</li><li>Na primeira vez ele pede este token — cole e pronto:</li></ol>
          <pre class="mono vault-token">${esc(r.token)}</pre><p class="small muted">O token só aparece agora. Ele dá acesso só ao seu cofre (ler e gravar notas). Se vazar, gere outro aqui.</p>`;
      } catch (e) { fail(e); }
    };
    list(folder);
    if (path) open(path);
  });
}

// markdown mínimo e seguro (títulos, listas, negrito, citações, tabelas simples e [[links]])
function md(src) {
  const lines = esc(src).split('\n'); let out = ''; let inList = false; let inTable = false;
  const inline = (t) => t.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[\[([^\]|]+?)(?:\|([^\]]+))?\]\]/g, (_, a, b) => `<a class="wl" data-link="${a}">${b || a}</a>`).replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const l of lines) {
    if (/^\|/.test(l)) { if (/^\|[-\s|]+\|$/.test(l)) continue; if (!inTable) { out += '<table class="tbl">'; inTable = true; } out += `<tr>${l.split('|').slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join('')}</tr>`; continue; }
    if (inTable) { out += '</table>'; inTable = false; }
    const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(l);
    if (li) { if (!inList) { out += '<ul>'; inList = true; } out += `<li>${inline(li[1].replace(/^\[ \]\s*/, '☐ ').replace(/^\[x\]\s*/i, '☑ '))}</li>`; continue; }
    if (inList) { out += '</ul>'; inList = false; }
    const h = /^(#{1,3})\s+(.*)$/.exec(l);
    if (h) { out += `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`; continue; }
    if (/^&gt;\s?/.test(l)) { out += `<blockquote>${inline(l.replace(/^&gt;\s?/, ''))}</blockquote>`; continue; }
    out += l.trim() ? `<p>${inline(l)}</p>` : '';
  }
  if (inList) out += '</ul>'; if (inTable) out += '</table>';
  return out;
}

// grafo do cofre (força simples em canvas)
async function drawGraph({ api, fail }, m) {
  let g; try { g = await api('GET', '/api/vault/graph'); } catch (e) { fail(e); return; }
  const view = $('#vview', m);
  view.innerHTML = `<div class="small muted" style="margin-bottom:6px">${g.nodes.length} notas e ${g.edges.length} ligações — as notas se conectam pelos [[links]].</div><canvas class="vault-graph" id="vg"></canvas>`;
  const cv = $('#vg', view); const ctx = cv.getContext('2d'); const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 600; const H = cv.clientHeight || 420; cv.width = W * dpr; cv.height = H * dpr; ctx.scale(dpr, dpr);
  const col = { raw: '#5b7295', wiki: '#2dd4bf', outputs: '#ff8a3d', diario: '#c4a8ff', link: '#4ade80' };
  const idx = new Map(); const N = g.nodes.map((n, i) => { idx.set(n.id, i); return { ...n, x: W / 2 + Math.cos(i) * (60 + i * 3), y: H / 2 + Math.sin(i) * (60 + i * 3), vx: 0, vy: 0, deg: 0 }; });
  const E = g.edges.map((e) => [idx.get(e.from), idx.get(e.to)]).filter(([a, b]) => a != null && b != null);
  for (const [a, b] of E) { N[a].deg++; N[b].deg++; }
  let it = 0;
  const step = () => {
    for (let i = 0; i < N.length; i++) for (let j = i + 1; j < N.length; j++) { const a = N[i]; const b = N[j]; const dx = a.x - b.x; const dy = a.y - b.y; const d = Math.sqrt(dx * dx + dy * dy) + 0.1; const f = Math.min(3, 3200 / (d * d)); a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; }
    for (const [i, j] of E) { const a = N[i]; const b = N[j]; const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.sqrt(dx * dx + dy * dy) + 0.1; const f = (d - 120) * 0.01; a.vx += (dx / d) * f; a.vy += (dy / d) * f; b.vx -= (dx / d) * f; b.vy -= (dy / d) * f; }
    for (const n of N) { n.vx += (W / 2 - n.x) * 0.006; n.vy += (H / 2 - n.y) * 0.006; n.vx = Math.max(-6, Math.min(6, n.vx * 0.85)); n.vy = Math.max(-6, Math.min(6, n.vy * 0.85)); n.x = Math.max(10, Math.min(W - 90, n.x + n.vx)); n.y = Math.max(12, Math.min(H - 10, n.y + n.vy)); }
    ctx.clearRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(45,212,191,.18)'; ctx.lineWidth = 1;
    for (const [i, j] of E) { ctx.beginPath(); ctx.moveTo(N[i].x, N[i].y); ctx.lineTo(N[j].x, N[j].y); ctx.stroke(); }
    for (const n of N) {
      const r = 3 + Math.min(9, n.deg * 1.2);
      ctx.fillStyle = col[n.folder] || '#8da2c8'; ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 8; ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      if (n.deg >= 2 || N.length < 25) { ctx.fillStyle = '#d6e1f7'; ctx.font = '11px Inter, sans-serif'; ctx.fillText(n.title.slice(0, 26), n.x + r + 3, n.y + 4); }
    }
    if (++it < 400 && cv.isConnected) requestAnimationFrame(step);
  };
  step();
}
