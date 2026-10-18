import { createBrain } from './brain.js?v=20261007a';
import { createAvatar } from './avatar.js?v=20261011a';
import { sparkline, ring, animateRings, radar, statusBar, flowChart, countUp, sysColor, projectionChart } from './hud.js?v=20261007a';
// LORLER · Central de Decisões — painel HUD (SPA sem dependências)
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(`lorler.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`lorler.${k}`, JSON.stringify(v)); } catch { /* sem armazenamento */ } },
};

const state = { me: null, csrf: null, view: null, cleanup: [], assistant: null, chat: [], chatPending: null };

// ---------------- Rótulos ----------------
const STATUS = {
  draft: ['Rascunho', 'neutral'], queued: ['Na fila', 'run'], validating: ['Validando', 'run'], collecting_data: ['Aguardando dados', 'run'],
  analyzing: ['Em análise', 'run'], reviewing: ['Em revisão', 'run'], synthesizing: ['Consolidando', 'run'], awaiting_approval: ['Aguardando aprovação', 'wait'],
  approved: ['Aprovado', 'good'], executing: ['Em execução', 'run'], completed: ['Concluído', 'good'], insufficient_data: ['Dados insuficientes', 'wait'],
  rejected: ['Rejeitado', 'bad'], failed: ['Falha recuperável', 'bad'], canceled: ['Cancelado', 'neutral'], expired: ['Expirado', 'neutral'],
  denied: ['Bloqueada pela política', 'bad'], advisory: ['Consultiva', 'neutral'], executed: ['Executada', 'good'], uncertain: ['Resultado incerto: exige conciliação', 'wait'],
  revision_requested: ['Revisão solicitada', 'wait'], succeeded: ['Sucesso', 'good'], running: ['Executando', 'run'], pending: ['Pendente', 'wait'],
  pending_setup: ['Integração pendente', 'wait'], testing: ['Testando', 'run'], connected: ['Conectada', 'good'], degraded: ['Degradada', 'wait'], disabled: ['Desabilitada', 'neutral'], error: ['Erro', 'bad'],
  open: ['Aberta', 'wait'], done: ['Feita', 'good'],
};
const ACTIVE = ['queued', 'validating', 'collecting_data', 'analyzing', 'reviewing', 'synthesizing', 'executing'];
const st = (s) => { const [l, c] = STATUS[s] || [s, 'neutral']; return `<span class="st ${c}">${esc(l)}</span>`; };
const AGENTS = {
  coordinator: { name: 'Coordenador LORLER', short: 'Coordenador', icon: '<circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"/>' },
  financial: { name: 'Agente Financeiro', short: 'Financeiro', icon: '<path d="M3 17l5-5 4 4 8-8"/><path d="M15 8h5v5"/>' },
  commercial: { name: 'Agente Comercial', short: 'Comercial', icon: '<path d="M4 10l8-6 8 6v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/><path d="M9 20v-6h6v6"/>' },
  operations: { name: 'Agente Operacional', short: 'Operacional', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>' },
  marketing: { name: 'Agente de Marketing', short: 'Marketing', icon: '<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1z"/><path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12"/>' },
  approver: { name: 'Aprovador humano', short: 'Aprovador' },
  all: { name: 'Todos', short: 'Todos' },
};
const MSG_TYPES = { task: 'Tarefa', opinion: 'Parecer', question: 'Pergunta', challenge: 'Contraponto', revision: 'Revisão', synthesis: 'Síntese' };
const TOOLS = { none: 'Somente consultivo', create_internal_task: 'Criar tarefa interna', change_price_or_discount: 'Alterar preço ou desconto', send_customer_message: 'Enviar mensagem a cliente', paid_campaign: 'Campanha paga', publish_instagram_post: 'Publicar no Instagram', master_update_settings: 'Alterar parâmetros na Área Master', master_update_plan: 'Alterar plano na Área Master', master_update_product_params: 'Alterar parâmetros do sistema (Master)', master_extend_trial: 'Prorrogar teste de empresa (Master)', payment_or_refund: 'Pagamento ou estorno', block_customer_or_delete_data: 'Bloquear cliente / apagar dados', production_change_or_access: 'Alterar produção / conceder acesso' };
const CHECKS = { identidade: 'Identidade', escopo: 'Escopo', ferramenta: 'Ferramenta', dados: 'Dados', limites: 'Limites', orcamento: 'Orçamento', aprovacao: 'Aprovação', atualidade: 'Atualidade', duplicidade: 'Duplicidade', executor: 'Executor', conteudo: 'Conteúdo', demonstracao: 'Demonstração' };
const METRIC_LABELS = { active_subscriptions_at_period_end: 'Assinaturas ativas', new_subscriptions: 'Novas assinaturas', cancellations: 'Cancelamentos', cash_received_in_period: 'Recebido no período', support_tickets: 'Chamados' };
const fmtDate = (s) => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: state.me?.organization?.timezone || 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtMoney = (v) => (v == null || v === '' ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const fmtNum = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR'));
const ICONS = {
  core: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  agents: '<circle cx="12" cy="7" r="3"/><circle cx="5" cy="17" r="2.5"/><circle cx="19" cy="17" r="2.5"/><path d="M10 9.5L6.5 15M14 9.5l3.5 5.5M7.5 17h9"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  plug: '<path d="M9 2v6M15 2v6M6 8h12v4a6 6 0 0 1-12 0z"/><path d="M12 18v4"/>',
  rules: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
  audit: '<path d="M12 8v4l3 2"/><circle cx="12" cy="12" r="9"/>',
  admin: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/>',
  speaker: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  mute: '<path d="M11 5L6 9H2v6h4l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/>',
  menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
  send: '<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  insta: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  face: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5a4.5 4.5 0 0 0 7 0"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};
const svg = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
const reactor = (size, cls = '') => `<div class="reactor ${cls}" style="--size:${size}"><div class="ring r1"></div><div class="ring r2"></div><div class="ring r3"></div><div class="ring r4"></div><div class="core"></div></div>`;

// ---------------- API ----------------
class ApiError extends Error { constructor(status, body) { super(body?.error?.message || `Erro ${status}`); this.status = status; this.code = body?.error?.code; this.requestId = body?.request_id; } }
async function api(method, path, body, { retryReauth = true } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && state.csrf) headers['X-CSRF-Token'] = state.csrf;
  const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/login')) { state.me = null; renderLogin(); throw new ApiError(401, data); }
  if (data?.error?.code === 'reauth_required' && retryReauth) {
    const ok = await askPassword('Confirme sua senha para concluir esta operação sensível.');
    if (!ok) throw new ApiError(403, data);
    return api(method, path, body, { retryReauth: false });
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

function toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = `t${isErr ? ' err' : ''}`;
  t.textContent = msg;
  $('#toast').appendChild(t);
  setTimeout(() => t.remove(), isErr ? 7000 : 3800);
}
const fail = (e) => { if (e.status !== 401) toast(`${e.message}${e.requestId ? ` (request_id ${e.requestId.slice(0, 8)})` : ''}`, true); };

function modal(html, onMount) {
  const m = $('#modal');
  m.innerHTML = `<div class="panel">${html}</div>`;
  m.classList.remove('hidden');
  const close = () => { m.classList.add('hidden'); m.innerHTML = ''; };
  m.onclick = (e) => { if (e.target === m) close(); };
  onMount?.(m, close);
  return close;
}

function askPassword(text) {
  return new Promise((resolve) => {
    modal(`<h2>Autenticação reforçada</h2><p class="muted">${esc(text)}</p><form id="rf" class="grid"><label class="field">Senha<input type="password" name="password" required autocomplete="current-password"></label><div class="err" id="rerr"></div><div class="row"><button class="btn primary">Confirmar</button><button type="button" class="btn ghost" id="rc">Cancelar</button></div></form>`, (m, close) => {
      $('input', m).focus();
      $('#rc', m).onclick = () => { close(); resolve(false); };
      $('#rf', m).onsubmit = async (e) => {
        e.preventDefault();
        try { await api('POST', '/api/auth/reauth', { password: e.target.password.value }, { retryReauth: false }); close(); resolve(true); } catch (err) { $('#rerr', m).textContent = err.message; }
      };
    });
  });
}

// ---------------- Voz (Web Speech API + voz neural opcional) ----------------
// A voz segue a configuração do assistente (tela "Assistente"): voz do navegador (grátis, varia por aparelho) ou voz neural
// gerada no servidor (/api/tts — a chave nunca vem para o navegador). O avatar recebe o volume para mexer a boca.
const voice = {
  enabled: store.get('voice', false),
  synth: window.speechSynthesis,
  subs: new Set(),
  audio: null, actx: null, raf: 0, seq: 0,
  cfg() { return state.assistant?.settings?.voice || { engine: 'browser', rate: 1, pitch: 1 }; },
  emit(ev) { this.subs.forEach((f) => { try { f(ev); } catch { /* */ } }); },
  setSpeaking(on) { this.onSpeaking?.(on); this.emit({ speaking: on }); },
  canSpeak() { return this.enabled && (!!this.synth || (this.cfg().engine === 'openai' && state.assistant?.tts_available)); },
  clean(text) { return String(text || '').replace(/\[SEM SUPORTE\]/g, '').replace(/[*_~`#]/g, '').slice(0, 700); },
  stop() {
    this.seq++;
    try { this.synth?.cancel(); } catch { /* */ }
    if (this.audio) { try { this.audio.pause(); } catch { /* */ } this.audio = null; }
    cancelAnimationFrame(this.raf);
  },
  pickVoice() {
    const all = this.synth?.getVoices() || [];
    const want = this.cfg().browser_voice;
    return (want && all.find((x) => x.name === want)) || all.find((x) => /pt-BR/i.test(x.lang) && /Francisca|Thalita|Luciana|Google|Natural|Online/i.test(x.name)) || all.find((x) => /pt-BR/i.test(x.lang)) || all.find((x) => /^pt/i.test(x.lang));
  },
  speakBrowser(text, my) {
    if (!this.synth) { this.setSpeaking(false); return; }
    const c = this.cfg();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'pt-BR'; u.rate = Number(c.rate) || 1; u.pitch = Number(c.pitch) || 1;
    const v = this.pickVoice(); if (v) u.voice = v;
    u.onstart = () => { if (my === this.seq) this.setSpeaking(true); };
    u.onboundary = () => this.emit({ word: true });
    u.onend = () => { if (my === this.seq) this.setSpeaking(false); };
    u.onerror = () => { if (my === this.seq) this.setSpeaking(false); };
    this.synth.speak(u);
  },
  async speakNeural(text, my) {
    const c = this.cfg();
    const res = await fetch('/api/tts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrf || '' }, body: JSON.stringify({ text, voice: c.openai_voice, rate: c.rate }) });
    if (!res.ok) throw new Error('tts');
    const blob = await res.blob();
    if (my !== this.seq) return;
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url); this.audio = audio;
    try {
      this.actx ||= new (window.AudioContext || window.webkitAudioContext)();
      if (this.actx.state === 'suspended') await this.actx.resume();
      const src = this.actx.createMediaElementSource(audio); const an = this.actx.createAnalyser(); an.fftSize = 512;
      src.connect(an); an.connect(this.actx.destination);
      const buf = new Uint8Array(an.fftSize);
      const loop = () => { an.getByteTimeDomainData(buf); let sum = 0; for (const x of buf) sum += ((x - 128) / 128) ** 2; this.emit({ level: Math.min(1, Math.sqrt(sum / buf.length) * 4) }); this.raf = requestAnimationFrame(loop); };
      loop();
    } catch { /* sem análise de áudio: o avatar anima sozinho */ }
    audio.onplay = () => { if (my === this.seq) this.setSpeaking(true); };
    audio.onended = audio.onerror = () => { cancelAnimationFrame(this.raf); URL.revokeObjectURL(url); if (my === this.seq) { this.audio = null; this.setSpeaking(false); } };
    await audio.play();
  },
  speak(text, { force = false } = {}) {
    if ((!this.enabled && !force) || !text) return;
    this.stop();
    const my = this.seq; const t = this.clean(text);
    if (this.cfg().engine === 'openai' && state.assistant?.tts_available) {
      this.speakNeural(t, my).catch(() => { if (my === this.seq) this.speakBrowser(t, my); });
    } else this.speakBrowser(t, my);
  },
  toggle() { this.enabled = !this.enabled; store.set('voice', this.enabled); if (!this.enabled) this.stop(); return this.enabled; },
  listen(onText, btn, onEnd) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('Reconhecimento de voz não suportado neste navegador (use Chrome ou Edge).', true); onEnd?.(); return; }
    const rec = new SR();
    rec.lang = 'pt-BR'; rec.interimResults = true; rec.maxAlternatives = 1;
    btn?.classList.add('listening');
    this.emit({ listening: true });
    rec.onresult = (e) => { const txt = [...e.results].map((r) => r[0].transcript).join(''); onText(txt, e.results[e.results.length - 1].isFinal); };
    rec.onerror = (e) => { if (e.error !== 'no-speech') toast(`Voz: ${e.error}`, true); };
    rec.onend = () => { btn?.classList.remove('listening'); this.emit({ listening: false }); onEnd?.(); };
    rec.start();
  },
};

// ---------------- Inicialização ----------------
async function init() {
  try {
    const setup = await api('GET', '/api/setup/status');
    if (setup.needs_setup) return renderSetup();
    const me = await api('GET', '/api/auth/me');
    state.me = me; state.csrf = me.csrf;
    renderShell();
  } catch (e) {
    if (e.status !== 401) { renderLogin(); fail(e); }
  }
}

function loginLayout(inner) {
  $('#app').innerHTML = `<div class="login-wrap">
    <div class="login-hero">${reactor('min(52vw, 320px)', 'busy')}<div><h1>LORLER</h1><p>Central de Decisões · Cérebro Multiagente</p></div></div>
    <div class="panel login-card scanline">${inner}</div></div>`;
}

function bootLines(el, lines) {
  let i = 0;
  const tick = () => { if (i >= lines.length || !el.isConnected) return; el.innerHTML += `${esc(lines[i++])}<br>`; setTimeout(tick, 220); };
  tick();
}

function renderLogin() {
  loginLayout(`<div class="boot-lines" id="bl"></div><h2>Acesso autorizado</h2>
    <form id="lf" class="grid"><label class="field">E-mail<input name="email" type="email" required autocomplete="username"></label>
    <label class="field">Senha<input name="password" type="password" required autocomplete="current-password"></label>
    <div class="err" id="lerr"></div><button class="btn primary">Entrar</button></form>`);
  bootLines($('#bl'), ['> núcleo LORLER ............ online', '> registro de agentes ...... 4 ativos', '> motor de políticas ....... v. vigente', '> aguardando identificação do operador_']);
  $('#lf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      const r = await api('POST', '/api/auth/login', { email: f.email.value, password: f.password.value });
      state.csrf = r.csrf;
      state.me = await api('GET', '/api/auth/me');
      state.csrf = state.me.csrf;
      const h = new Date().getHours();
      voice.speak(`${h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'}, ${state.me.user.name.split(' ')[0]}. Central de decisões LORLER online.`);
      if (!location.hash || location.hash === '#/') location.hash = '#/nucleo';
      renderShell();
    } catch (err) { $('#lerr').textContent = err.message; }
  };
}

function renderSetup() {
  loginLayout(`<h2>Instalação inicial</h2><p class="muted small">Crie o primeiro <b>owner</b>. O código de instalação aparece no console onde o servidor foi iniciado. Não existe usuário ou senha padrão.</p>
    <form id="sf" class="grid"><label class="field">Código de instalação<input name="setup_token" required autocomplete="off"></label>
    <label class="field">Nome<input name="name" required></label><label class="field">E-mail<input name="email" type="email" required></label>
    <label class="field">Senha (mín. 10, letras e números)<input name="password" type="password" required minlength="10" autocomplete="new-password"></label>
    <div class="err" id="serr"></div><button class="btn primary">Criar owner</button></form>`);
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target;
    try {
      await api('POST', '/api/setup/owner', { setup_token: f.setup_token.value.trim(), name: f.name.value, email: f.email.value, password: f.password.value });
      toast('Owner criado. Faça login.');
      renderLogin();
    } catch (err) { $('#serr').textContent = err.message; }
  };
}

// ---------------- Shell ----------------
const NAV = [
  ['nucleo', 'Visão geral', 'core'], ['nova', 'Nova análise', 'plus'], ['decisoes', 'Decisões', 'list'], ['aprovacoes', 'Aprovações', 'shield'],
  ['agentes', 'Agentes', 'agents'], ['conhecimento', 'Conhecimento', 'book'], ['integracoes', 'Integrações', 'plug'], ['regras', 'Regras e limites', 'rules'],
  ['auditoria', 'Histórico e auditoria', 'audit'], ['assistente', 'Assistente', 'face'], ['admin', 'Administração', 'admin'],
];

function renderShell() {
  const me = state.me;
  $('#app').innerHTML = `<div class="shell">
    <aside class="sidebar" id="sb">
      <div class="brand">${reactor('40px', 'mini')}<div><b>LORLER</b><small>Central de Decisões</small></div></div>
      <nav class="nav">${NAV.map(([k, l, i]) => `<a href="#/${k}" data-k="${k}">${svg(i, 'ico')}<span>${l}</span>${k === 'aprovacoes' ? '<span class="badge warn hidden" id="nav-pending"></span>' : ''}</a>`).join('')}</nav>
      <div class="foot"><div>${esc(me.user.name)}</div><div class="small">${esc(me.organization.name)} · <span class="badge">${esc(me.role)}</span></div>
        <button class="btn sm ghost" id="logout" style="margin-top:10px">${svg('logout')}Sair</button></div>
    </aside>
    <section class="main">
      <header class="topbar">
        <button class="btn icon menu-btn" id="menu" aria-label="Menu">${svg('menu')}</button>
        <span class="title" id="vtitle"></span>
        ${me.ai_provider === 'demo' ? '<span class="badge demo" title="Pareceres gerados de forma determinística, sem modelo de IA">IA: demonstração</span>' : `<span class="badge ok">IA: ${esc(me.ai_provider)}</span>`}
        ${me.environment !== 'production' ? `<span class="badge warn">${esc(me.environment)}</span>` : ''}
        ${me.organization.executions_paused ? '<span class="badge danger">Execuções pausadas</span>' : ''}
        <span class="spacer"></span>
        <span class="clock" id="clock"></span>
        <button class="btn icon" id="vtoggle" title="Respostas faladas">${svg(voice.enabled ? 'speaker' : 'mute')}</button>
      </header>
      <div class="content" id="content"></div>
    </section></div>
    <div class="dock" id="dock"></div>`;
  $('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout', {}); } catch { /* ignore */ } state.me = null; location.hash = ''; renderLogin(); };
  $('#menu').onclick = () => $('#sb').classList.toggle('open');
  $('#vtoggle').onclick = (e) => { const on = voice.toggle(); e.currentTarget.innerHTML = svg(on ? 'speaker' : 'mute'); if (on) voice.speak('Voz ativada.'); };
  const tick = () => { const c = $('#clock'); if (c) c.textContent = new Date().toLocaleString('pt-BR', { timeZone: me.organization.timezone, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).toUpperCase(); };
  tick(); setInterval(tick, 1000);
  window.onhashchange = route;
  route();
  refreshPending();
  loadAssistant().then(mountDock);
}

async function loadAssistant() {
  try { state.assistant = await api('GET', '/api/assistant'); } catch { state.assistant = { settings: { name: 'Cérebro', voice: { engine: 'browser', rate: 1, pitch: 1 }, avatar: {} }, can_edit: false, tts_available: false }; }
  return state.assistant;
}

async function refreshPending() {
  try {
    const list = await api('GET', '/api/approvals');
    const n = list.filter((x) => x.status === 'awaiting_approval').length;
    const b = $('#nav-pending'); if (b) { b.textContent = n; b.classList.toggle('hidden', !n); }
  } catch { /* silencioso */ }
}

function route() {
  state.cleanup.forEach((f) => f()); state.cleanup = [];
  $('#sb')?.classList.remove('open');
  if (window.innerWidth < 760) { $('#dock-panel')?.classList.add('hidden'); $('#dock')?.classList.remove('open'); }
  const [hashPath, hashQuery = ''] = (location.hash || '#/nucleo').split('?');
  state.query = new URLSearchParams(hashQuery);
  const [, key = 'nucleo', arg] = hashPath.split('/');
  $$('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.k === key || (key === 'decisao' && a.dataset.k === 'decisoes')));
  const views = { nucleo: viewCore, nova: viewNew, decisoes: viewDecisions, decisao: viewDecision, aprovacoes: viewApprovals, agentes: viewAgents, conhecimento: viewKnowledge, integracoes: viewIntegrations, regras: viewRules, auditoria: viewAudit, assistente: viewAssistant, admin: viewAdmin };
  const titles = { decisao: 'Decisão' };
  $('#vtitle').textContent = titles[key] || NAV.find((n) => n[0] === key)?.[1] || '';
  const c = $('#content');
  c.innerHTML = '<div class="empty"><b>Carregando</b>Consultando o núcleo…</div>';
  (views[key] || viewCore)(c, arg).catch((e) => { fail(e); c.innerHTML = `<div class="panel empty"><b>Falha ao carregar</b>${esc(e.message)}</div>`; });
}

// ---------------- Câmara de agentes (visualização) ----------------
const SPECIALISTS = ['commercial', 'marketing', 'financial', 'operations'];
function createChamber(el, { label = 'Aguardando comando' } = {}) {
  const pos = { coordinator: [50, 50], commercial: [50, 10], marketing: [50, 90], financial: [12, 50], operations: [88, 50] };
  const P = (a) => [pos[a][0], pos[a][1] * 0.625];
  const ring = ['commercial', 'operations', 'marketing', 'financial'];
  el.classList.add('chamber');
  el.innerHTML = `<svg class="links" viewBox="0 0 100 62.5" preserveAspectRatio="none">
      <defs><filter id="glow"><feGaussianBlur stdDeviation=".6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
      ${SPECIALISTS.map((a) => `<line data-l="${a}" x1="50" y1="31.25" x2="${P(a)[0]}" y2="${P(a)[1]}" stroke="rgba(25,227,255,.25)" stroke-width=".25" stroke-dasharray="1 1"/>`).join('')}
      ${ring.map((a, i) => { const b = ring[(i + 1) % ring.length]; return `<line x1="${P(a)[0]}" y1="${P(a)[1]}" x2="${P(b)[0]}" y2="${P(b)[1]}" stroke="rgba(25,227,255,.1)" stroke-width=".2"/>`; }).join('')}
      <g id="pulses" filter="url(#glow)"></g></svg>
    <div class="center">${reactor('min(30vw, 190px)')}</div>
    <div class="status-ring" id="ch-status">${esc(label)}</div>
    ${SPECIALISTS.map((a) => `<div class="node idle c-${a}" data-a="${a}" style="left:${pos[a][0]}%;top:${pos[a][1]}%"><div class="orb"><svg viewBox="0 0 24 24">${AGENTS[a].icon}</svg></div><b>${AGENTS[a].short}</b><small></small></div>`).join('')}`;
  const svgEl = $('svg.links', el);
  const g = $('#pulses', el);
  const point = (a) => (!pos[a] || a === 'coordinator' ? [50, 31.25] : P(a));
  const colors = { coordinator: '#19e3ff', financial: '#3dffa8', commercial: '#ffb547', operations: '#9d8cff', marketing: '#ff5fa2', approver: '#ffffff' };
  let raf = null; const pulses = [];
  const loop = (t) => {
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i]; const k = Math.min(1, (t - p.t0) / p.dur);
      const e = k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      if (p.ring) { p.el.setAttribute('r', 4 + e * 40); p.el.setAttribute('opacity', 1 - e); }
      else { p.el.setAttribute('cx', p.a[0] + (p.b[0] - p.a[0]) * e); p.el.setAttribute('cy', p.a[1] + (p.b[1] - p.a[1]) * e); p.tail.setAttribute('x2', p.a[0] + (p.b[0] - p.a[0]) * e); p.tail.setAttribute('y2', p.a[1] + (p.b[1] - p.a[1]) * e); p.tail.setAttribute('x1', p.a[0] + (p.b[0] - p.a[0]) * Math.max(0, e - .18)); p.tail.setAttribute('y1', p.a[1] + (p.b[1] - p.a[1]) * Math.max(0, e - .18)); }
      if (k >= 1) { p.el.remove(); p.tail?.remove(); pulses.splice(i, 1); }
    }
    raf = pulses.length ? requestAnimationFrame(loop) : null;
  };
  const api_ = {
    setStatus(text, busy) { $('#ch-status', el).textContent = text; $('.center .reactor', el).classList.toggle('busy', !!busy); },
    agent(a, stateName, note = '') {
      const n = $(`.node[data-a="${a}"]`, el);
      if (!n) { if (a === 'coordinator') $('.center .reactor', el).classList.toggle('busy', stateName === 'thinking'); return; }
      n.classList.remove('idle', 'thinking', 'failed');
      if (stateName) n.classList.add(stateName);
      $('small', n).textContent = note;
      const line = $(`line[data-l="${a}"]`, svgEl);
      if (line) line.setAttribute('stroke', stateName === 'thinking' ? colors[a] : 'rgba(25,227,255,.25)');
    },
    activate(list) { list.forEach((a) => { const n = $(`.node[data-a="${a}"]`, el); n?.classList.remove('idle'); }); },
    pulse(from, to, type) {
      const NS = 'http://www.w3.org/2000/svg';
      const col = colors[from] || '#19e3ff';
      if (to === 'all') {
        const c = document.createElementNS(NS, 'circle'); c.setAttribute('cx', 50); c.setAttribute('cy', 31.25); c.setAttribute('fill', 'none'); c.setAttribute('stroke', col); c.setAttribute('stroke-width', '.4');
        g.appendChild(c); pulses.push({ el: c, ring: true, t0: performance.now(), dur: 1400 });
      } else {
        const a = point(from); const b = point(to);
        const tail = document.createElementNS(NS, 'line'); tail.setAttribute('stroke', col); tail.setAttribute('stroke-width', type === 'challenge' ? '.7' : '.45'); tail.setAttribute('stroke-linecap', 'round');
        const c = document.createElementNS(NS, 'circle'); c.setAttribute('r', type === 'challenge' ? 1.3 : 1); c.setAttribute('fill', col);
        g.appendChild(tail); g.appendChild(c);
        pulses.push({ el: c, tail, a, b, t0: performance.now(), dur: 900 });
      }
      if (!raf) raf = requestAnimationFrame(loop);
    },
    destroy() { if (raf) cancelAnimationFrame(raf); },
  };
  return api_;
}

function msgHtml(m) {
  const from = m.sender_code || m.from; const to = m.recipient_code || m.to; const type = m.msgType || m.type;
  const text = m.content?.text ?? m.text;
  return `<div class="msg c-${esc(from)}"><div class="meta"><b>${esc(AGENTS[from]?.short || from)}</b> → ${esc(AGENTS[to]?.short || to)} · ${esc(MSG_TYPES[type] || type)}${m.round != null && m.round < 9 ? ` · rodada ${m.round}` : ''}${m.created_at ? ` · ${fmtDate(m.created_at)}` : ''}</div><p>${esc(text)}</p></div>`;
}

// ---------------- Visão geral (núcleo) ----------------
async function viewCore(c) {
  const [ov, products] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/products')]);
  const me = state.me;
  const canCreate = me.permissions.includes('create_decision');
  const hasConnected = ov.products.some((p) => p.integration_status === 'connected');
  const h = new Date().getHours();
  c.innerHTML = `
    <div class="hud-bar">
      <div class="hb-title"><span class="hb-pulse"></span>Centro de Análise LORLER</div>
      <div id="an-source" class="hb-src">Conectando às bases…</div>
      <div class="hb-meta mono"><span id="an-time">—</span><span class="sep">|</span>próxima leitura <b id="an-next">60</b>s</div>
      <button class="btn sm ghost" id="an-refresh" title="Atualizar agora">${svg('refresh')} Atualizar</button>
    </div>
    <div class="kpi-strip" id="an-kpis">${Array.from({ length: 8 }, () => '<div class="ktile skeleton"></div>').join('')}</div>
    <div class="grid g3">
      <div class="panel span2 brain-panel">
        <h2>${h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'}, ${esc(state.assistant?.settings?.call_me || me.user.name.split(' ')[0])} · ${esc(state.assistant?.settings?.name && state.assistant.settings.name !== 'Cérebro' ? state.assistant.settings.name : 'Cérebro LORLER')}</h2>
        <div id="chamber"></div>
        ${canCreate ? `<form class="command" id="cmd"><input name="q" placeholder="Pergunte ao LORLER… ex.: Quais ações devem ser priorizadas para aumentar as assinaturas?" autocomplete="off" required minlength="8">
          <button type="button" class="btn icon" id="mic" title="Falar">${svg('mic')}</button><button class="btn primary" title="Enviar">${svg('send')}</button></form>
          <div class="row small muted" style="margin-top:8px">
            <span>Dados:</span>
            <label class="chip ${!hasConnected && me.demo_mode ? 'on' : ''}"><input type="radio" name="mode" value="demo" ${!hasConnected && me.demo_mode ? 'checked' : ''} ${me.demo_mode ? '' : 'disabled'}>Demonstração</label>
            <label class="chip ${hasConnected || !me.demo_mode ? 'on' : ''}"><input type="radio" name="mode" value="real" ${hasConnected || !me.demo_mode ? 'checked' : ''}>Dados reais (Área Master)</label>
            <span>· todos os sistemas do seu escopo · mês anterior · <a href="#/nova">opções avançadas</a></span>
          </div>
          <div class="chips" style="margin-top:10px">${['Quais ações devem ser priorizadas para aumentar as assinaturas?', 'Qual sistema tem maior risco de inadimplência e o que fazer?', 'Crie um post para o Instagram divulgando o ORBI', 'Devemos ampliar o período de teste grátis do ORBI na Área Master?', 'O suporte aguenta o crescimento de clientes?'].map((t) => `<button type="button" class="chip suggest" data-q="${esc(t)}">${esc(t)}</button>`).join('')}</div>` : '<p class="muted">Seu papel permite consultar relatórios.</p>'}
      </div>
      <div class="grid">
        <div class="panel health-panel"><h2>Saúde da carteira</h2><div class="health-wrap"><div id="an-health"></div><div id="an-health-side" class="small"></div></div><div class="formula small muted" id="an-formula"></div></div>
        <div class="panel"><h2>Comparativo entre sistemas</h2><div id="an-radar" class="radar-wrap"></div><div id="an-radar-legend" class="legend"></div></div>
      </div>
    </div>
    <div class="panel flow-panel"><h2>Fluxo dos últimos 30 dias <span class="legend inline"><span><b style="background:#3dffa8"></b>Recebido</span><span><b style="background:#19e3ff"></b>Novos cadastros</span><span><b style="background:#ff4d6a"></b>Cancelamentos</span></span></h2><div id="an-flow" class="flow-wrap"></div></div>
    <div class="grid g4" id="an-systems"></div>
    <div class="grid g3">
      <div class="panel"><h2>Leituras automáticas</h2><div id="an-insights" class="insights"></div><div class="small muted" style="margin-top:8px">Cálculos sobre os dados exibidos — não são pareceres da IA. Para decidir, pergunte ao cérebro.</div></div>
      <div class="panel"><h2>Alertas</h2><div id="ov-alerts">${ov.alerts.length ? ov.alerts.map((a) => `<div class="alert ${a.level}">${esc(a.text)}</div>`).join('') : '<p class="muted">Sem alertas.</p>'}</div></div>
      <div class="grid">
        <div class="panel"><h2>Aprovações</h2><div class="kpi"><span class="v" id="ov-pending">${ov.pending_approvals}</span><span class="l">pendentes</span></div><a class="btn sm" href="#/aprovacoes" style="margin-top:10px">Abrir</a></div>
        <div class="panel"><h2>Consumo do mês</h2><div class="metric-list"><span>Chamadas ao modelo</span><span>${fmtNum(ov.usage.calls)}</span><span>Tokens</span><span>${fmtNum(ov.usage.tokens)}</span><span>Custo</span><span>${ov.usage.cost != null ? `${Number(ov.usage.cost).toFixed(4)} ${esc(ov.usage.currency || '')}` : 'preço não configurado'}</span></div></div>
      </div>
    </div>
    <div class="panel"><h2>Execuções recentes</h2><div id="ov-recent">${decisionsTable(ov.recent)}</div></div>`;
  const ch = createBrain($('#chamber', c), { label: 'Núcleo online · aguardando comando', onSource: openSourceReport, onVoice: () => voiceCommand(ch) });
  voice.onSpeaking = (on) => ch.setSpeaking?.(on);
  state.cleanup.push(() => { voice.onSpeaking = null; if (convo.ch === ch) { convo.on = false; convo.ch = null; } });
  state.cleanup.push(() => ch.destroy());
  let analytics = null;
  const extra = { MASTER: 'pending', INSTAGRAM: 'pending', WHATSAPP: 'pending' };
  const pushSources = () => {
    const srcs = (analytics?.products || ov.products.map((p) => ({ code: p.product, source: 'demo' }))).map((p) => ({ code: p.code || p.product, label: p.code || p.product, state: p.source === 'master' ? 'connected' : p.source === 'demo' ? 'demo' : 'pending', value: p.kpis ? (p.kpis.mrr ? moneyShort(p.kpis.mrr, true) : `${fmtNum(p.kpis.trial)} teste`) : '' }));
    srcs.push({ code: 'MASTER', label: 'Área Master', state: extra.MASTER }, { code: 'INSTAGRAM', label: 'Instagram', state: extra.INSTAGRAM }, { code: 'WHATSAPP', label: 'WhatsApp', state: extra.WHATSAPP });
    ch.setSources(srcs);
  };
  // Bases dos sistemas via Área Master (60 s) + painéis (20 s) + atividade ao vivo (SSE)
  let next = 60;
  const loadAnalytics = async (force = false) => {
    try {
      const a = await api('GET', `/api/analytics${force ? '?refresh=1' : ''}`);
      analytics = a; next = 60;
      renderAnalytics(c, a);
      a.products.forEach((p, i) => setTimeout(() => ch.feedFromSource(p.code), i * 260));
      if (a.source === 'master') setTimeout(() => ch.feedFromSource('MASTER'), 300);
      pushSources();
    } catch (err) { const s = $('#an-source', c); if (s) s.innerHTML = `<span class="badge danger">FALHA</span> ${esc(err.message)}`; }
  };
  const refreshSources = async () => {
    try {
      const [o2, ms, ig, wme] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/master/status'), api('GET', '/api/social/instagram'), api('GET', '/api/whatsapp/me')]);
      extra.MASTER = analytics?.source === 'master' ? 'connected' : ms.configured ? (analytics?.master?.error || (ms.last && !ms.last.ok) ? 'error' : 'connected') : 'pending';
      extra.INSTAGRAM = ig.account ? 'connected' : 'pending';
      extra.WHATSAPP = wme.configured ? (wme.link?.status === 'verified' ? 'connected' : 'demo') : 'pending';
      pushSources();
      const running = o2.recent.filter((r) => ACTIVE.includes(r.status)).length;
      ch.setStatus(running ? `${running} análise(s) em processamento` : `Núcleo online · ${o2.pending_approvals} aprovação(ões) pendente(s)`, running > 0);
      const pend = $('#ov-pending', c); if (pend) pend.textContent = o2.pending_approvals;
      const al = $('#ov-alerts', c); if (al) al.innerHTML = o2.alerts.length ? o2.alerts.map((x) => `<div class="alert ${x.level}">${esc(x.text)}</div>`).join('') : '<p class="muted">Sem alertas.</p>';
      const rec = $('#ov-recent', c); if (rec) { rec.innerHTML = decisionsTable(o2.recent); bindRows(rec); }
    } catch { /* offline momentâneo */ }
  };
  // não trava a tela: a primeira leitura do Master pode levar alguns segundos
  pushSources();
  const slow = setTimeout(() => { const el = $('#an-source', c); if (el && !analytics) el.textContent = 'Lendo as bases na Área Master… (a primeira leitura leva alguns segundos)'; }, 2500);
  loadAnalytics().finally(() => clearTimeout(slow));
  refreshSources();
  const iv = setInterval(refreshSources, 20000);
  const tick = setInterval(() => { next -= 1; const n = $('#an-next', c); if (n) n.textContent = Math.max(0, next); if (next <= 0) loadAnalytics(); }, 1000);
  $('#an-refresh', c).onclick = () => { loadAnalytics(true); refreshSources(); };
  const live = new EventSource('/api/events');
  live.onmessage = (ev) => {
    const e = JSON.parse(ev.data);
    if (e.type === 'message') ch.pulse(e.from, e.to, e.msgType);
    else if (e.type === 'agent') ch.agent(e.agent, e.state === 'thinking' ? 'thinking' : e.state === 'failed' ? 'failed' : '', e.state === 'thinking' ? `${MSG_TYPES[e.kind] || e.kind}…` : '');
    else if (e.type === 'evidence') (e.sources || []).slice(0, 12).forEach((x, i) => setTimeout(() => ch.feedFromSource(x.ref && x.product ? x.product : 'MASTER'), i * 120));
    else if (e.type === 'status') { ch.setStatus(STATUS[e.status]?.[0] || e.status, ACTIVE.includes(e.status)); if (e.final) setTimeout(refreshSources, 800); }
  };
  state.cleanup.push(() => { clearInterval(iv); clearInterval(tick); live.close(); });
  bindChips(c);
  bindRows(c);
  const form = $('#cmd', c);
  $$('.suggest', c).forEach((b) => { b.onclick = () => { form.q.value = b.dataset.q; form.q.focus(); }; });
  c.addEventListener('click', (e) => { const b = e.target.closest('[data-ask]'); if (b && form) { form.q.value = b.dataset.ask; form.q.focus(); form.scrollIntoView({ behavior: 'smooth', block: 'center' }); } });
  if (form) {
    $('#mic', c).onclick = (e) => voice.listen((t, final) => { form.q.value = t; if (final && t.length >= 8) form.requestSubmit(); }, e.currentTarget);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const end = new Date(); end.setDate(1); end.setHours(0, 0, 0, 0);
      const start = new Date(end); start.setMonth(start.getMonth() - 1);
      const mode = $('input[name=mode]:checked', c)?.value || 'real';
      try {
        const r = await api('POST', '/api/decisions', { question: form.q.value, product_ids: products.filter((p) => p.in_scope && p.code !== 'APOLVEN').map((p) => p.id), decision_type: 'misto', mode, period: { start: start.toISOString(), end_exclusive: end.toISOString() } });
        voice.speak('Entendido. Reunindo os especialistas.');
        location.hash = `#/decisao/${r.decision_id}`;
      } catch (err) { fail(err); }
    };
  }
}

const moneyShort = (v, axis) => {
  const n = Number(v) || 0;
  if (axis) return n >= 1000 ? `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}k` : Math.round(n).toLocaleString('pt-BR');
  return fmtMoney(n);
};
const SRC_BADGE = {
  master: '<span class="src-badge live"><i></i>ÁREA MASTER · AO VIVO</span>',
  demo: '<span class="src-badge demo"><i></i>DEMO · DADOS FICTÍCIOS</span>',
  mixed: '<span class="src-badge mixed"><i></i>FONTES MISTAS</span>',
  unavailable: '<span class="src-badge off"><i></i>SEM DADOS</span>',
};

function renderAnalytics(c, a) {
  const t = a.totals; const prods = a.products.filter((p) => p.kpis);
  const src = $('#an-source', c);
  if (src) src.innerHTML = `${SRC_BADGE[a.source] || ''}${a.master.error ? ` <span class="small" style="color:var(--red)">Master: ${esc(a.master.error.message)}</span>` : !a.master.configured ? ' <a class="small" href="#/integracoes">ligar Área Master</a>' : ''}`;
  const tm = $('#an-time', c); if (tm) tm.textContent = `leitura ${new Date(a.generated_at).toLocaleTimeString('pt-BR')}`;
  const pct = (x, y) => (y ? (x / y) * 100 : null);
  const tiles = [
    { l: 'MRR', v: t.mrr, f: 'money', s: a.series.cash, col: '#3dffa8', sub: 'receita recorrente mensal' },
    { l: 'Assinaturas ativas', v: t.active, s: null, col: '#19e3ff', sub: `${fmtNum(t.tenants)} empresas no total` },
    { l: 'Em teste', v: t.trial, col: '#7befff', sub: t.conversion_pct != null ? `conversão ${t.conversion_pct.toLocaleString('pt-BR')}%` : 'conversão —' },
    { l: 'Inadimplentes', v: t.past_due, col: '#ffb547', sub: `${(pct(t.past_due, (t.active || 0) + (t.past_due || 0)) ?? 0).toFixed(1)}% da base paga`, warn: t.past_due > 0 },
    { l: 'Recebido · 30 dias', v: t.cash, f: 'money', s: a.series.cash, col: '#3dffa8', sub: 'pagamentos confirmados' },
    { l: 'Em aberto', v: t.open_receivables, f: 'money', col: '#ffb547', sub: 'cobranças pendentes/vencidas' },
    { l: 'Novos cadastros · 30d', v: t.signups, s: a.series.signups, col: '#19e3ff', sub: `${fmtNum(t.new_subscriptions)} novas assinaturas` },
    { l: 'Cancelamentos · 30d', v: t.cancellations, s: a.series.cancellations, col: '#ff4d6a', sub: `${(pct(t.cancellations, t.active) ?? 0).toFixed(1)}% das ativas`, warn: t.cancellations > 0 },
  ];
  const kp = $('#an-kpis', c);
  if (kp) {
    const prev = $$('[data-count]', kp).map((x) => x.dataset.from);
    kp.innerHTML = tiles.map((k, i) => `<div class="ktile ${k.warn ? 'warn' : ''}" style="--k:${k.col};animation-delay:${i * 60}ms">
      <div class="kt-l">${esc(k.l)}</div><div class="kt-v" data-count="${k.v ?? ''}" data-fmt="${k.f || ''}" data-from="${prev[i] || 0}">${k.v == null ? '—' : '0'}</div>
      <div class="kt-s">${esc(k.sub)}</div>${k.s ? `<div class="kt-spark">${sparkline(k.s, k.col, { w: 160, h: 30 })}</div>` : ''}<i class="kt-scan"></i></div>`).join('');
    countUp(kp);
  }
  const hp = $('#an-health', c);
  if (hp) {
    hp.innerHTML = ring(t.health, { color: "auto", size: 150, sub: t.health == null ? '' : t.health >= 75 ? 'SAUDÁVEL' : t.health >= 50 ? 'ATENÇÃO' : 'CRÍTICO' });
    $('#an-health-side', c).innerHTML = prods.map((p) => `<div class="hs-row"><span style="color:${sysColor(p.code)}">${esc(p.code)}</span><div class="hs-bar"><i style="width:${p.health ?? 0}%;background:${sysColor(p.code)}"></i></div><b>${p.health ?? '—'}</b></div>`).join('');
    $('#an-formula', c).textContent = a.formula;
    animateRings(hp);
  }
  // Radar: cada eixo normalizado pelo maior valor entre os sistemas
  const axes = [['MRR', (k) => k.mrr], ['Ativas', (k) => k.active], ['Crescimento', (k) => Math.max(0, (k.new_subscriptions || 0) - (k.cancellations || 0))], ['Conversão', (k) => k.conversion_pct], ['Adimplência', (k) => 100 - (pct(k.past_due, (k.active || 0) + (k.past_due || 0)) ?? 0)], ['Retenção', (k) => 100 - (pct(k.cancellations, Math.max(1, k.active)) ?? 0)]];
  const maxes = axes.map(([, f]) => Math.max(...prods.map((p) => Number(f(p.kpis)) || 0), 1));
  const rd = $('#an-radar', c);
  if (rd) {
    rd.innerHTML = radar(axes.map((x) => x[0]), prods.map((p) => ({ code: p.code, color: sysColor(p.code), values: axes.map(([, f], i) => (Number(f(p.kpis)) || 0) / maxes[i]) })));
    $('#an-radar-legend', c).innerHTML = prods.map((p) => `<span data-code="${esc(p.code)}"><b style="background:${sysColor(p.code)}"></b>${esc(p.code)}</span>`).join('');
    $$('#an-radar-legend span', c).forEach((s) => { s.onmouseenter = () => rd.classList.add('focus') || $$(`.rd-series`, rd).forEach((g) => g.classList.toggle('on', g.dataset.code === s.dataset.code)); s.onmouseleave = () => rd.classList.remove('focus'); });
  }
  const fl = $('#an-flow', c);
  if (fl) flowChart(fl, { days: a.days, cash: a.series.cash, signups: a.series.signups, cancellations: a.series.cancellations, money: moneyShort });
  const sys = $('#an-systems', c);
  if (sys) sys.innerHTML = a.products.map(systemCard).join('');
  animateRings(sys);
  const ins = $('#an-insights', c);
  if (ins) ins.innerHTML = insights(a).map((x) => `<div class="insight ${x.level}"><span class="ico">${x.level === 'danger' ? '▲' : x.level === 'warn' ? '◆' : '●'}</span><div>${x.html}</div></div>`).join('') || '<p class="muted">Sem leituras para o período.</p>';
}

// ---------------- Relatório de uma base (clique nas bases em órbita) ----------------
const RPT_ICON = { signup: '＋', payment: '$', cancel: '×', overdue: '!', subscription: '★', done: '✓', pending: '…', fail: '!', info: '•' };
const RPT_CLASS = { signup: 'c', payment: 'g', subscription: 'g', done: 'g', cancel: 'r', overdue: 'a', fail: 'r', pending: 'a', info: 'c' };
const fmtVal = (v, f) => (v == null ? '—' : f === 'money' ? fmtMoney(v) : f === 'min' ? `${fmtNum(v)} min` : f === 'days' ? `${fmtNum(v)} dias` : fmtNum(v));
function relTime(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!Number.isFinite(d)) return '';
  if (d < 0) return new Date(iso).toLocaleDateString('pt-BR');
  if (d < 3600) return `há ${Math.max(1, Math.round(d / 60))} min`;
  if (d < 86400) return `há ${Math.round(d / 3600)} h`;
  if (d < 86400 * 7) return `há ${Math.round(d / 86400)} d`;
  return new Date(iso).toLocaleDateString('pt-BR');
}
async function openSourceReport(code) {
  const close = modal(`<div class="report"><div class="rp-loading"><span class="hb-pulse"></span> Gerando relatório de ${esc(code)}…</div></div>`, (m) => { m.firstElementChild.classList.add('report-panel'); });
  let r;
  try { r = await api('GET', `/api/sources/${encodeURIComponent(code)}/report`); }
  catch (err) { const el = $('#modal .report'); if (el) el.innerHTML = `<div class="alert danger">${esc(err.message)}</div><button class="btn ghost" id="rp-x">Fechar</button>`; $('#rp-x')?.addEventListener('click', close); return; }
  const el = $('#modal .report'); if (!el) return;
  const col = sysColor(r.code);
  el.style.setProperty('--sc', ['MASTER', 'INSTAGRAM', 'WHATSAPP'].includes(r.code) ? ({ MASTER: '#19e3ff', INSTAGRAM: '#ff5fa2', WHATSAPP: '#3dffa8' })[r.code] : col);
  el.innerHTML = `
    <div class="rp-head">
      <div><div class="rp-kicker">Relatório da base · últimas atividades e projeções</div><h2 class="rp-title">${esc(r.title)}</h2><div class="small muted">${esc(r.subtitle || '')}</div></div>
      <div class="rp-meta">${SRC_BADGE[r.source] || (r.source === 'connected' ? '<span class="src-badge live"><i></i>CONECTADO</span>' : r.source === 'pending' ? '<span class="src-badge off"><i></i>NÃO VINCULADO</span>' : '')}<span class="mono small muted">${new Date(r.generated_at).toLocaleString('pt-BR')}</span>
        <div class="row"><button class="btn sm ghost" id="rp-print">Imprimir / PDF</button><button class="btn sm ghost" id="rp-x">Fechar</button></div></div>
    </div>
    <div class="rp-kpis">${(r.kpis || []).map((k, i) => `<div class="rp-kpi" style="animation-delay:${i * 50}ms"><span>${esc(k.label)}</span><b>${fmtVal(k.value, k.fmt)}</b></div>`).join('')}</div>
    ${r.chart ? `<div class="rp-block"><h3>${esc(r.chart.label)} · histórico e projeção</h3><div class="rp-chart">${projectionChart({ days: r.days, actual: r.chart.actual, projected: r.chart.projected, fmt: r.chart.fmt }, moneyShort)}</div></div>` : ''}
    <div class="rp-cols">
      <div class="rp-block"><h3>Projeções · próximos 30 dias</h3>
        ${(r.projections || []).map((x) => `<div class="rp-proj"><div><span>${esc(x.label)}</span><small>${esc(x.note || '')}</small></div><b>${fmtVal(x.value, x.fmt)}</b></div>`).join('') || '<p class="muted">Sem projeções.</p>'}
        ${r.by_product?.length ? `<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Sistema</th><th>MRR</th><th>Ativas</th><th>Teste</th><th>Recebido 30d</th><th>Projeção 30d</th></tr></thead><tbody>${r.by_product.map((b) => `<tr class="click" data-src="${esc(b.code)}"><td style="color:${sysColor(b.code)}"><b>${esc(b.code)}</b></td><td>${fmtVal(b.mrr, 'money')}</td><td>${fmtNum(b.active)}</td><td>${fmtNum(b.trial)}</td><td>${fmtVal(b.cash, 'money')}</td><td>${fmtVal(b.next30, 'money')}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${(r.notes || []).length ? `<div class="rp-notes">${r.notes.map((n) => `<div class="insight warn"><span class="ico">◆</span><div>${esc(n)}</div></div>`).join('')}</div>` : ''}
      </div>
      <div class="rp-block"><h3>Últimas atividades</h3>
        <div class="rp-timeline">${(r.activities || []).map((a) => `<div class="rp-ev ${RPT_CLASS[a.type] || 'c'}"><i>${RPT_ICON[a.type] || '•'}</i><div><span>${a.href ? `<a href="${esc(a.href)}">${esc(a.text)}</a>` : esc(a.text)}</span><small>${esc(relTime(a.at))}</small></div></div>`).join('') || '<p class="muted">Nenhuma atividade registrada ainda.</p>'}</div>
      </div>
    </div>
    <div class="rp-foot"><span class="small muted">${esc(r.method)}</span>${r.ask && state.me.permissions.includes('create_decision') ? `<button class="btn sm primary" id="rp-ask">Analisar com o cérebro</button>` : ''}</div>`;
  $('#rp-x', el).onclick = close;
  $('#rp-print', el).onclick = () => window.print();
  $$('tr[data-src]', el).forEach((tr) => { tr.onclick = () => { close(); openSourceReport(tr.dataset.src); }; });
  $$('a[href^="#/"]', el).forEach((a) => a.addEventListener('click', () => close()));
  const ask = $('#rp-ask', el);
  if (ask) ask.onclick = () => { close(); const f = $('#cmd'); if (f) { f.q.value = r.ask; f.q.focus(); f.scrollIntoView({ behavior: 'smooth', block: 'center' }); } else { location.hash = '#/nucleo'; setTimeout(() => { const g = $('#cmd'); if (g) g.q.value = r.ask; }, 600); } };
}

function systemCard(p) {
  const col = sysColor(p.code);
  if (!p.kpis) return `<div class="panel sys-card" style="--sc:${col}"><div class="sc-head"><span class="sc-name">${esc(p.code)}</span>${SRC_BADGE.unavailable}</div><p class="muted small">Sem Área Master e sem modo de demonstração.</p></div>`;
  const k = p.kpis;
  const row = (l, v) => `<span>${l}</span><span>${v}</span>`;
  return `<div class="panel sys-card" style="--sc:${col}">
    <div class="sc-head"><div><span class="sc-name">${esc(p.code)}</span><div class="small muted sc-desc">${esc(p.description || p.name || '')}</div></div>${ring(p.health, { color: col, size: 74 })}</div>
    <div class="sc-src">${SRC_BADGE[p.source] || ''}</div>
    <div class="sc-mrr"><span class="l">MRR</span><span class="v">${k.mrr == null ? '—' : fmtMoney(k.mrr)}</span></div>
    <div class="metric-list">${row('Ativas', fmtNum(k.active))}${row('Em teste', fmtNum(k.trial))}${row('Inadimplentes', `<span class="${k.past_due ? 'warn-t' : ''}">${fmtNum(k.past_due)}</span>`)}${row('Recebido 30d', fmtMoney(k.cash))}${row('Em aberto', fmtMoney(k.open_receivables))}${row('Conversão de teste', k.conversion_pct == null ? '—' : `${k.conversion_pct.toLocaleString('pt-BR')}%`)}</div>
    <div class="sc-charts"><div><small>Recebido/dia</small>${sparkline(p.series.cash, '#3dffa8', { w: 140, h: 34 })}</div><div><small>Cadastros/dia</small>${sparkline(p.series.signups, col, { w: 140, h: 34 })}</div></div>
    ${statusBar(p.status)}
    ${p.plans?.length ? `<div class="sc-plans">${p.plans.filter((x) => x.active).slice(0, 3).map((x) => `<span>${esc(x.name)} <b>${x.price != null ? fmtMoney(x.price) : '—'}</b>${x.tenants != null ? ` · ${fmtNum(x.tenants)}` : ''}</span>`).join('')}</div>` : ''}
    ${p.notes?.length ? `<div class="small muted" style="margin-top:6px">${p.notes.map(esc).join(' · ')}</div>` : ''}
    <button type="button" class="btn sm ghost sc-ask" data-ask="${esc(`Analise o ${p.code}: o que fazer para aumentar a receita e reduzir cancelamentos e inadimplência?`)}">Analisar ${esc(p.code)} com o cérebro</button>
  </div>`;
}

function insights(a) {
  const out = []; const ps = a.products.filter((p) => p.kpis); const t = a.totals;
  if (!ps.length) return out;
  const fmtP = (v) => `${v.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
  if (t.mrr) { const top = [...ps].sort((x, y) => (y.kpis.mrr || 0) - (x.kpis.mrr || 0))[0]; out.push({ level: 'info', html: `<b>${esc(top.code)}</b> concentra ${fmtP(((top.kpis.mrr || 0) / t.mrr) * 100)} do MRR (${fmtMoney(top.kpis.mrr)} de ${fmtMoney(t.mrr)}).` }); }
  const del = ps.map((p) => ({ p, v: (p.kpis.past_due || 0) / Math.max(1, (p.kpis.active || 0) + (p.kpis.past_due || 0)) * 100 })).sort((x, y) => y.v - x.v)[0];
  if (del && del.v > 0) out.push({ level: del.v >= 10 ? 'danger' : 'warn', html: `Maior inadimplência: <b>${esc(del.p.code)}</b> com ${fmtP(del.v)} da base paga (${fmtMoney(del.p.kpis.open_receivables)} em aberto).` });
  const ch = ps.map((p) => ({ p, v: (p.kpis.cancellations || 0) / Math.max(1, p.kpis.active || 0) * 100 })).sort((x, y) => y.v - x.v)[0];
  if (ch && ch.v > 0) out.push({ level: ch.v >= 5 ? 'danger' : 'warn', html: `Maior cancelamento em 30 dias: <b>${esc(ch.p.code)}</b> (${fmtP(ch.v)} das ativas). Meta de referência: abaixo de 5%.` });
  const net = ps.map((p) => ({ p, v: (p.kpis.new_subscriptions || 0) - (p.kpis.cancellations || 0) })).sort((x, y) => y.v - x.v);
  if (net[0]) out.push({ level: 'info', html: `Melhor crescimento líquido: <b>${esc(net[0].p.code)}</b> (${net[0].v >= 0 ? '+' : ''}${net[0].v} assinaturas).${net.length > 1 && net[net.length - 1].v < 0 ? ` <b>${esc(net[net.length - 1].p.code)}</b> encolheu ${net[net.length - 1].v}.` : ''}` });
  if (t.trial) out.push({ level: 'info', html: `${fmtNum(t.trial)} empresas em teste agora${t.conversion_pct != null ? ` · conversão média da coorte ${fmtP(t.conversion_pct)}` : ''}.` });
  const low = ps.filter((p) => p.health != null && p.health < 60);
  if (low.length) out.push({ level: 'warn', html: `Saúde abaixo de 60: ${low.map((p) => `<b>${esc(p.code)}</b> (${p.health})`).join(', ')}.` });
  if (a.source === 'demo') out.unshift({ level: 'warn', html: 'Leituras sobre <b>dados de demonstração</b>. Ligue a Área Master para ver os números reais.' });
  return out;
}

function decisionsTable(rows) {
  if (!rows.length) return '<div class="empty"><b>Nenhuma decisão</b>Faça uma pergunta ao núcleo para iniciar a primeira análise.</div>';
  return `<div class="table-wrap"><table><thead><tr><th>Pergunta</th><th>Status</th><th>Criada</th></tr></thead><tbody>${rows.map((r) => `<tr class="click" data-href="#/decisao/${r.id}"><td>${r.is_demo ? '<span class="badge demo">DEMO</span> ' : ''}${esc(r.question)}</td><td>${st(r.status)}</td><td class="mono small">${fmtDate(r.created_at)}</td></tr>`).join('')}</tbody></table></div>`;
}
function bindRows(el) { $$('tr[data-href]', el).forEach((tr) => { tr.onclick = () => { location.hash = tr.dataset.href; }; }); }
// ---------------- Conversa por voz com o núcleo (mãos livres) ----------------
// Usa POST /api/conversation: respostas curtas faladas; análise só abre depois do "sim"; nunca aprova nem executa.
// Relatórios das bases abrem direto no painel ("relatório do ORBI").
const SYS_VOICE = [['ORBI', /orbi|orbe/], ['TORVEN', /torven|torvem/], ['RUSTEN', /rusten|rustem/], ['APOLVEN', /apolven|apolvem/], ['MASTER', /master|mestre/], ['INSTAGRAM', /instagram/], ['WHATSAPP', /whats ?app|zap/]];
const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const convo = { on: false, history: [], pending: null, ch: null };
function voiceCommand(ch) {
  if (convo.on && convo.ch === ch) { convo.on = false; ch.setListening(false); ch.setTranscript('Conversa encerrada.', 'hint'); voice.stop(); setTimeout(() => ch.setTranscript(''), 2500); return; }
  if (!voice.enabled) voice.toggle();
  const vt = $('#vtoggle'); if (vt) vt.innerHTML = svg('speaker');
  Object.assign(convo, { on: true, ch, pending: null });
  listenTurn();
}
function listenTurn() {
  const ch = convo.ch; if (!convo.on || !ch) return;
  voice.stop();
  ch.setListening(true); ch.setTranscript(convo.pending ? 'Diga “sim” para abrir a análise ou “não” para cancelar' : 'Ouvindo… pode falar', 'hint');
  let finalText = '';
  voice.listen((txt, final) => { ch.setTranscript(`“${txt}”`, final ? 'final' : ''); if (final) finalText = txt; }, null, () => {
    ch.setListening(false);
    if (!convo.on) return;
    if (!finalText) { convo.on = false; ch.setTranscript('Não ouvi nada. Toque no microfone para falar de novo.', 'hint'); setTimeout(() => ch.setTranscript(''), 4000); return; }
    voiceTurn(finalText).catch((err) => { convo.on = false; ch.setTranscript(err.message, 'reply'); voice.speak('Não consegui concluir.'); });
  });
}
function sayAndContinue(msg, keepListening = true) {
  const ch = convo.ch; ch.setTranscript(msg, 'reply');
  convo.history.push({ role: 'assistant', text: msg }); convo.history = convo.history.slice(-8);
  if (!keepListening) convo.on = false;
  const prev = voice.onSpeaking;
  if (!voice.canSpeak()) { if (convo.on) setTimeout(listenTurn, 1200); return; }
  voice.onSpeaking = (on) => { prev?.(on); if (!on) { voice.onSpeaking = prev; if (convo.on) setTimeout(listenTurn, 350); else setTimeout(() => ch.setTranscript(''), 6000); } };
  voice.speak(msg);
}
async function voiceTurn(text) {
  const t = norm(text);
  convo.history.push({ role: 'user', text }); convo.history = convo.history.slice(-8);
  if (/^(encerrar|encerra|tchau|obrigad|parar|pare|chega)/.test(t)) return sayAndContinue('Certo. Estou aqui quando precisar.', false);
  // confirmação de análise proposta
  if (convo.pending) {
    if (/^(sim|pode|abre|abrir|confirmo|confirma|isso|claro|manda|ok|vai)/.test(t)) {
      const q = convo.pending; convo.pending = null;
      const r = await api('POST', '/api/conversation', { confirm_analysis: q });
      sayAndContinue(r.reply, false);
      if (r.decision_id) setTimeout(() => { location.hash = `#/decisao/${r.decision_id}`; }, 1500);
      return;
    }
    if (/^(nao|cancela|deixa|esquece)/.test(t)) { convo.pending = null; return sayAndContinue('Tudo bem, não abri a análise. Quer saber mais alguma coisa?'); }
  }
  const sys = SYS_VOICE.find(([, re]) => re.test(t))?.[0];
  if (/relatorio|projec|ultimas atividades/.test(t) && sys) { openSourceReport(sys); return sayAndContinue(`Abrindo o relatório de ${sys === 'MASTER' ? 'Área Master' : sys}, com as últimas atividades e projeções.`, false); }
  const r = await api('POST', '/api/conversation', { message: text.slice(0, 600), history: convo.history.slice(0, -1) });
  if (r.intent === 'propose_analysis' && r.analysis_question) convo.pending = r.analysis_question;
  if (r.intent === 'navigate' && r.navigate_to) { location.hash = `#/${r.navigate_to}`; return sayAndContinue(r.reply, false); }
  if (r.intent === 'navigate_offer' && r.navigate_to) setTimeout(() => { location.hash = `#/${r.navigate_to}`; }, 2500);
  if (r.intent === 'end') return sayAndContinue(r.reply, false);
  sayAndContinue(r.reply, true);
}

function bindChips(el) {
  $$('.chip input', el).forEach((inp) => {
    inp.onchange = () => {
      if (inp.type === 'radio') $$(`.chip input[name="${inp.name}"]`, el).forEach((o) => o.parentElement.classList.toggle('on', o.checked));
      else inp.parentElement.classList.toggle('on', inp.checked);
    };
  });
}

// ---------------- Nova análise ----------------
async function viewNew(c) {
  if (!state.me.permissions.includes('create_decision')) { c.innerHTML = '<div class="panel empty"><b>Sem permissão</b>Seu papel não permite criar análises.</div>'; return; }
  const products = await api('GET', '/api/products');
  const end = new Date(); end.setDate(1);
  const start = new Date(end); start.setMonth(start.getMonth() - 1);
  const d = (x) => x.toISOString().slice(0, 10);
  c.innerHTML = `<div class="panel"><h2>Nova análise</h2>
    <form id="nf" class="grid g2">
      <label class="field span2">Pergunta ou objetivo
        <div class="command"><textarea name="question" required minlength="8" maxlength="2000" placeholder="Ex.: Podemos oferecer 10% de desconto no ORBI para aumentar a conversão?"></textarea><button type="button" class="btn icon" id="mic">${svg('mic')}</button></div></label>
      <div class="field span2">Produtos envolvidos<div class="chips">${products.map((p) => `<label class="chip ${p.in_scope && p.code !== 'APOLVEN' ? 'on' : ''}"><input type="checkbox" name="p" value="${p.id}" ${p.in_scope && p.code !== 'APOLVEN' ? 'checked' : ''} ${p.in_scope ? '' : 'disabled'}>${esc(p.code)}${p.in_scope ? '' : ' (sem escopo)'}</label>`).join('')}</div></div>
      <label class="field">Início do período<input type="date" name="start" value="${d(start)}" required></label>
      <label class="field">Fim (exclusivo)<input type="date" name="end" value="${d(end)}" required></label>
      <label class="field">Tipo de decisão<select name="type"><option value="misto">Misto</option><option value="comercial">Comercial</option><option value="financeiro">Financeiro</option><option value="operacional">Operacional</option></select></label>
      <div class="field">Fonte de dados<div class="chips">
        <label class="chip ${state.me.demo_mode ? '' : 'on'}"><input type="radio" name="mode" value="real" ${state.me.demo_mode ? '' : 'checked'}>Integrações reais</label>
        ${state.me.demo_mode ? '<label class="chip on"><input type="radio" name="mode" value="demo" checked>Demonstração — dados fictícios</label>' : ''}</div></div>
      <label class="field">Orçamento empresarial (R$, opcional)<input name="budget" inputmode="decimal" placeholder="500,00"></label>
      <label class="field">Prazo (opcional)<input name="deadline" placeholder="Ex.: 30 dias"></label>
      <label class="field span2">Restrições adicionais<textarea name="notes" placeholder="Ex.: não alterar o plano anual; priorizar ações sem custo"></textarea></label>
      <div class="span2 small muted">O orçamento informado é uma restrição da análise e não concede autorização de gasto. O backend valida produtos, escopos e limites antes de iniciar.</div>
      <div class="span2 err" id="nerr"></div>
      <div class="span2 row"><button class="btn primary">Iniciar análise</button><a class="btn ghost" href="#/nucleo">Cancelar</a></div>
    </form></div>`;
  bindChips(c);
  const f = $('#nf', c);
  $('#mic', c).onclick = (e) => voice.listen((t) => { f.question.value = t; }, e.currentTarget);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const tz = (s) => new Date(`${s}T00:00:00-03:00`).toISOString();
    try {
      const r = await api('POST', '/api/decisions', {
        question: f.question.value, product_ids: $$('input[name=p]:checked', f).map((x) => x.value), decision_type: f.type.value,
        mode: $('input[name=mode]:checked', f)?.value || 'real', period: { start: tz(f.start.value), end_exclusive: tz(f.end.value) },
        constraints: { business_budget: f.budget.value.trim() || undefined, deadline: f.deadline.value.trim() || undefined, notes: f.notes.value.trim() || undefined },
      });
      location.hash = `#/decisao/${r.decision_id}`;
    } catch (err) { $('#nerr', c).textContent = err.message; }
  };
}

// ---------------- Lista de decisões ----------------
async function viewDecisions(c) {
  const rows = await api('GET', '/api/decisions');
  c.innerHTML = `<div class="panel"><h2>Decisões</h2>${decisionsTable(rows)}</div>`;
  bindRows(c);
}

// ---------------- Detalhe da decisão (sala de agentes) ----------------
async function viewDecision(c, id) {
  let data = await api('GET', `/api/decisions/${id}`);
  try { state.igUser = (await api('GET', '/api/social/instagram')).account?.username || null; } catch { /* opcional */ }
  let tab = 'resumo';
  let es = null; let poll = null; let lastStatus = null; let spokenFor = null;
  c.innerHTML = `<div id="dhead"></div>
    <div class="grid g2"><div class="panel"><h2>Cérebro LORLER</h2><div id="chamber"></div><div class="row" id="ch-actions" style="margin-top:8px"></div></div>
      <div class="panel"><h2>Interação entre agentes</h2><div class="feed" id="feed"></div></div></div>
    <div class="panel"><div class="tabs" id="tabs"></div><div class="tab-body" id="tbody"></div></div>`;
  const ch = createBrain($('#chamber', c), { label: 'Sincronizando…', onSource: openSourceReport, onVoice: () => voiceCommand(ch) });
  voice.onSpeaking = (on) => ch.setSpeaking?.(on);
  state.cleanup.push(() => { voice.onSpeaking = null; if (convo.ch === ch) { convo.on = false; convo.ch = null; } });
  state.cleanup.push(() => { ch.destroy(); es?.close(); clearInterval(poll); });

  const renderHead = () => {
    const d = data.decision; const cur = data.current;
    const sc = d.scope || {};
    const active = ACTIVE.includes(cur?.run?.status || d.status);
    $('#dhead', c).innerHTML = `${d.is_demo ? '<div class="demo-banner">⚠ Demonstração — dados fictícios. Não utilizar para decisões reais.</div>' : ''}
      ${cur?.run?.provider === 'demo' ? '<div class="demo-banner" style="margin-top:8px">Pareceres gerados pelo provedor de demonstração (sem IA real)</div>' : ''}
      <div class="panel" style="margin-top:${d.is_demo ? '10px' : '0'}"><div class="row" style="justify-content:space-between;align-items:flex-start">
        <div style="flex:1;min-width:260px"><h2>Pergunta</h2><p class="answer" style="font-size:20px">${esc(d.question)}</p>
          <div class="row small muted"><span>${st(d.status)}</span><span>Tipo: ${esc(sc.decision_type)}</span><span>Período: ${fmtDate(sc.period?.start).slice(0, 10)} → ${fmtDate(sc.period?.end_exclusive).slice(0, 10)}</span>
          ${cur ? `<span class="mono">run ${esc(cur.run.id.slice(0, 8))}</span><span>Chamadas: ${cur.run.model_calls}</span><span>Política v${esc(cur.run.policy_version)}</span>` : ''}</div>
          ${cur?.run?.error ? `<div class="alert warn" style="margin-top:10px">${esc(cur.run.error)}</div>` : ''}</div>
        <div class="row">${active ? '<button class="btn danger sm" id="cancel">Cancelar</button>' : ''}${!active && state.me.permissions.includes('create_decision') ? '<button class="btn sm" id="rerun">Nova execução</button>' : ''}</div>
      </div></div>`;
    $('#cancel', c)?.addEventListener('click', async () => { try { await api('POST', `/api/decisions/${id}/cancel`, {}); toast('Cancelamento solicitado.'); reload(); } catch (e) { fail(e); } });
    $('#rerun', c)?.addEventListener('click', async () => { try { await api('POST', `/api/decisions/${id}/rerun`, {}); toast('Nova execução enfileirada.'); reload(true); } catch (e) { fail(e); } });
  };

  const renderFeed = () => {
    const msgs = data.current?.messages || [];
    const feed = $('#feed', c);
    feed.innerHTML = msgs.length ? msgs.map(msgHtml).join('') : '<div class="empty"><b>Sem mensagens</b>A interação aparecerá aqui em tempo real.</div>';
    requestAnimationFrame(() => { feed.scrollTop = feed.scrollHeight; });
  };

  const renderChamberState = () => {
    const cur = data.current; if (!cur) return;
    const status = cur.run.status;
    const used = [...new Set(cur.tasks.map((t) => t.agent_code))];
    ch.activate(used.filter((a) => a !== 'coordinator'));
    for (const a of SPECIALISTS) {
      const ts = cur.tasks.filter((t) => t.agent_code === a);
      const last = ts[ts.length - 1];
      if (!last) continue;
      ch.agent(a, last.status === 'running' ? 'thinking' : last.status === 'failed' ? 'failed' : '', last.status === 'running' ? 'analisando…' : `${ts.filter((t) => t.status === 'done').length} parecer(es)`);
    }
    const shown = status === 'awaiting_approval' ? data.decision.status : status;
    ch.setStatus(STATUS[shown]?.[0] || shown, ACTIVE.includes(shown));
    const acts = $('#ch-actions', c);
    acts.innerHTML = !ACTIVE.includes(status) && cur.messages.length ? '<button class="btn sm ghost" id="replay">▶ Reproduzir interação</button>' : '';
    $('#replay', c)?.addEventListener('click', () => replay(cur.messages));
  };

  const replay = async (msgs) => {
    const feed = $('#feed', c); feed.innerHTML = '';
    for (const m of msgs) {
      if (!c.isConnected) return;
      ch.pulse(m.sender_code, m.recipient_code, m.type);
      if (!['coordinator', 'approver'].includes(m.sender_code)) ch.agent(m.sender_code, 'thinking', MSG_TYPES[m.type]);
      feed.insertAdjacentHTML('beforeend', msgHtml(m)); feed.scrollTop = 1e6;
      await new Promise((r) => setTimeout(r, 700));
      if (!['coordinator', 'approver'].includes(m.sender_code)) ch.agent(m.sender_code, '', MSG_TYPES[m.type]);
    }
  };

  const tabsDef = [['resumo', 'Resumo'], ['pareceres', 'Pareceres'], ['evidencias', 'Evidências'], ['proposta', 'Proposta de ação'], ['aprovacao', 'Aprovação'], ['resultado', 'Resultado']];
  const renderTabs = () => {
    $('#tabs', c).innerHTML = tabsDef.map(([k, l]) => `<button class="${tab === k ? 'on' : ''}" data-t="${k}">${l}</button>`).join('');
    $$('#tabs button', c).forEach((b) => { b.onclick = () => { tab = b.dataset.t; renderTabs(); }; });
    const body = $('#tbody', c);
    const cur = data.current;
    if (!cur) { body.innerHTML = '<div class="empty"><b>Sem execução</b></div>'; return; }
    body.innerHTML = { resumo: tabSummary, pareceres: tabOpinions, evidencias: tabEvidence, proposta: tabProposal, aprovacao: tabApproval, resultado: tabResult }[tab](cur, data.decision);
    bindTab(body, cur);
  };

  const bindTab = (body, cur) => {
    $$('[data-approve]', body).forEach((b) => { b.onclick = () => decideProposal(b.dataset.approve, b.dataset.action, cur); });
    $$('[data-reconcile]', body).forEach((b) => { b.onclick = async () => { try { const r = await api('POST', `/api/actions/${b.dataset.reconcile}/reconcile`, {}); toast(`Conciliação: ${r.found ? 'efeito confirmado no destino' : 'efeito não encontrado — marcado como falha'}`); reload(); } catch (e) { fail(e); } }; });
    $$('[data-revoke]', body).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/actions/${b.dataset.revoke}/revoke`, {}); toast('Aprovação revogada.'); reload(); } catch (e) { fail(e); } }; });
    $$('[data-exec]', body).forEach((b) => { b.onclick = async () => { b.disabled = true; try { const r = await api('POST', `/api/actions/${b.dataset.exec}/execute`, {}); toast(r.status === 'succeeded' ? 'Executado com sucesso.' : `Execução: ${r.status}${r.reasons ? ` — ${r.reasons.join('; ')}` : ''}`, r.status !== 'succeeded'); reload(); } catch (e) { fail(e); b.disabled = false; } }; });
    $$('[data-wa]', body).forEach((b) => { b.onclick = async () => { try { const r = await api('POST', `/api/actions/${b.dataset.wa}/notify-whatsapp`, {}); toast(r.skipped ? 'WhatsApp não configurado ou proposta não pendente.' : r.sent.length ? `Enviado para ${r.sent.filter((x) => x.ok).length} aprovador(es).${r.sent.some((x) => !x.ok) ? ` Falha: ${r.sent.find((x) => !x.ok).error}` : ''}` : 'Nenhum aprovador com WhatsApp vinculado.', !!r.sent?.some((x) => !x.ok)); } catch (e) { fail(e); } }; });
    $$('[data-igsave]', body).forEach((b) => { b.onclick = async () => {
      const id = b.dataset.igsave; const p = cur.proposals.find((x) => x.id === id);
      try { await api('POST', `/api/actions/${id}/revise-content`, { proposal_version: p.version, caption_body: $(`#igc-${id}`, body).value, hashtags: $(`#igh-${id}`, body).value, image_url: $(`#igi-${id}`, body).value.trim() }); toast('Nova versão criada. Revise a prévia e aprove.'); reload(); } catch (e) { fail(e); }
    }; });
    $$('[data-speak]', body).forEach((b) => { b.onclick = () => { if (!voice.enabled) voice.toggle(); voice.speak(b.dataset.speak); }; });
  };

  const decideProposal = async (pid, action, cur) => {
    const p = cur.proposals.find((x) => x.id === pid);
    const comment = $(`#cm-${pid}`, c)?.value || '';
    const path = { approve: 'approve', reject: 'reject', revise: 'request-revision' }[action];
    try {
      const r = await api('POST', `/api/actions/${pid}/${path}`, { proposal_version: p.version, payload_hash: p.payload_hash, comment });
      if (action === 'approve') {
        const ex = r.execution;
        toast(ex?.status === 'succeeded' ? 'Aprovado e executado: tarefa interna criada.' : ex?.status === 'blocked' ? `Aprovado. Execução bloqueada: ${(ex.reasons || [ex.reason]).join('; ')}` : `Aprovado. Execução: ${ex?.status}`);
        voice.speak('Proposta aprovada.');
      } else toast(action === 'reject' ? 'Proposta rejeitada.' : 'Revisão solicitada — nova execução enfileirada.');
      refreshPending();
      reload(action === 'revise');
    } catch (e) { fail(e); }
  };

  async function reload(newRun = false) {
    data = await api('GET', `/api/decisions/${id}`);
    renderHead(); renderFeed(); renderChamberState(); renderTabs();
    if (newRun) connect();
    const status = data.current?.run?.status;
    if (status !== lastStatus && lastStatus && !ACTIVE.includes(status) && data.current?.synthesis && spokenFor !== data.current.run.id) {
      spokenFor = data.current.run.id;
      voice.speak(`Análise concluída. Recomendação: ${data.current.synthesis.proposal}`);
    }
    lastStatus = status;
  }

  function connect() {
    es?.close(); clearInterval(poll);
    const cur = data.current;
    if (!cur || !ACTIVE.includes(cur.run.status)) return;
    es = new EventSource(`/api/runs/${cur.run.id}/events`);
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === 'message') {
        ch.pulse(e.from, e.to, e.msgType);
        const feed = $('#feed', c);
        if ($('.empty', feed)) feed.innerHTML = '';
        feed.insertAdjacentHTML('beforeend', msgHtml(e)); feed.scrollTop = 1e6;
      } else if (e.type === 'agent') {
        ch.agent(e.agent, e.state === 'thinking' ? 'thinking' : e.state === 'failed' ? 'failed' : '', e.state === 'thinking' ? `${MSG_TYPES[e.kind] || e.kind}…` : e.state === 'failed' ? 'falhou' : 'concluído');
        if (e.agent === 'coordinator') ch.setStatus(e.state === 'thinking' ? (e.kind === 'plan' ? 'Planejando' : 'Consolidando') : $('#ch-status', c).textContent, e.state === 'thinking');
      } else if (e.type === 'status') {
        ch.setStatus(STATUS[e.status]?.[0] || e.status, ACTIVE.includes(e.status));
        data.decision.status = e.status; if (data.current) data.current.run.status = e.status; renderHead();
        if (e.final) { es.close(); reload(); }
      } else if (e.type === 'evidence') {
        ch.setStatus(`${e.count} evidências registradas`, true);
      }
    };
    poll = setInterval(async () => {
      try {
        const fresh = await api('GET', `/api/decisions/${id}`);
        if (fresh.current?.run?.status !== data.current?.run?.status || !ACTIVE.includes(fresh.current?.run?.status)) { data = fresh; reload(); if (!ACTIVE.includes(fresh.current?.run?.status)) clearInterval(poll); }
      } catch { /* ignore */ }
    }, 4000);
  }

  lastStatus = data.current?.run?.status;
  renderHead(); renderFeed(); renderChamberState(); renderTabs(); connect();
}

const evRefs = (refs, cur) => (refs || []).map((r) => { const e = cur.evidence.find((x) => x.ref_code === r); return `<span class="ev-ref" title="${esc(e ? `${e.source_type} · ${e.source_ref} · ${e.quality}` : 'inexistente')}">${esc(r)}</span>`; }).join('');
const claimHtml = (f, cur) => `<li>${f.claim.startsWith('[SEM SUPORTE]') ? `<span class="unsupported">${esc(f.claim)}</span>` : esc(f.claim)}${evRefs(f.evidence_refs, cur)}</li>`;
const list = (arr) => (arr?.length ? `<ul class="clean">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="muted">—</span>');

function tabSummary(cur, d) {
  const s = cur.synthesis;
  if (!s) return ACTIVE.includes(cur.run.status) ? '<div class="empty"><b>Em andamento</b>O resumo será exibido quando o coordenador consolidar os pareceres.</div>' : `<div class="empty"><b>${esc(STATUS[cur.run.status]?.[0] || cur.run.status)}</b>${esc(cur.run.error || 'Sem síntese para esta execução.')}</div>`;
  const prop = cur.proposals[cur.proposals.length - 1];
  return `${s.status !== 'ready' ? `<div class="alert warn">Resultado ${s.status === 'partial' ? 'parcial' : 'com dados insuficientes'} — verifique os dados ausentes.</div>` : ''}
    <h3>O que fazer</h3><p class="answer">${esc(s.proposal)}</p>
    <div class="row" style="margin-bottom:14px"><button class="btn sm ghost" data-speak="${esc(s.proposal)}">${svg('speaker')} Ouvir</button>${prop ? st(prop.status) : ''}${prop ? `<span class="small muted">Aprovação: ${esc(s.approver_hint || '—')}</span>` : ''}</div>
    <dl class="kv"><dt>Problema</dt><dd>${esc(s.problem)}</dd><dt>Diagnóstico</dt><dd>${esc(s.diagnosis)}</dd>
    <dt>Dados relevantes</dt><dd>${s.relevant_data?.length ? `<ul class="clean">${s.relevant_data.map((f) => claimHtml(f, cur)).join('')}</ul>` : '—'}</dd>
    <dt>Alternativas</dt><dd>${list(s.alternatives)}</dd><dt>Premissas</dt><dd>${list(s.assumptions)}</dd><dt>Divergências</dt><dd>${list(s.divergences)}</dd>
    <dt>Riscos</dt><dd>${list(s.risks)}</dd><dt>Dados ausentes</dt><dd>${list(s.missing_data)}</dd><dt>Próximos passos</dt><dd>${list(s.next_steps)}</dd>
    <dt>Consumo</dt><dd class="mono small">${fmtNum(cur.usage.calls)} chamadas · ${fmtNum(cur.usage.input_tokens)} entrada · ${fmtNum(cur.usage.output_tokens)} saída${cur.usage.cost != null ? ` · ${Number(cur.usage.cost).toFixed(4)} ${esc(cur.usage.currency)}` : ''}</dd></dl>`;
}

function tabOpinions(cur) {
  const tasks = cur.tasks.filter((t) => t.kind !== 'plan');
  if (!tasks.length) return '<div class="empty"><b>Sem pareceres</b></div>';
  const kinds = { opinion: 'Parecer', challenge: 'Contraponto', revision: 'Revisão', synthesis: 'Síntese' };
  return tasks.map((t) => {
    const o = t.output || {};
    return `<div class="panel c-${t.agent_code}" style="margin-bottom:12px;border-left:3px solid var(--c)"><div class="row" style="justify-content:space-between"><h3 style="color:var(--c)">${esc(AGENTS[t.agent_code]?.name)} · ${esc(kinds[t.kind] || t.kind)} · rodada ${t.round === 9 ? 'final' : t.round}</h3><span>${st(t.status)} ${o.status ? `<span class="badge">${esc(o.status)}</span>` : ''}</span></div>
      ${t.kind === 'synthesis' ? `<p>${esc(o.proposal || '')}</p>` : `<p><b>${esc(o.summary || '')}</b></p>
      ${o.findings?.length ? `<h3>Achados</h3><ul class="clean">${o.findings.map((f) => claimHtml(f, cur)).join('')}</ul>` : ''}
      ${o.recommendation ? `<h3 style="margin-top:10px">Recomendação</h3><p>${esc(o.recommendation)}</p>` : ''}
      <div class="grid g3 small"><div><h3>Riscos</h3>${list(o.risks)}</div><div><h3>Premissas</h3>${list(o.assumptions)}</div><div><h3>Dados ausentes</h3>${list(o.missing_data)}</div></div>`}
      ${t.validation_notes?.length ? `<div class="alert warn small" style="margin-top:8px">Validação do backend: ${esc(t.validation_notes.join(' · '))}</div>` : ''}
      <div class="small muted mono" style="margin-top:6px">${fmtDate(t.started_at)} → ${fmtDate(t.finished_at)}</div></div>`;
  }).join('');
}

function tabEvidence(cur) {
  if (!cur.evidence.length) return '<div class="empty"><b>Sem evidências</b></div>';
  const qual = { complete: 'ok', partial: 'warn', stale: 'warn', unavailable: 'danger' };
  return `<div class="table-wrap"><table><thead><tr><th>Ref.</th><th>Fonte</th><th>Produto</th><th>Qualidade</th><th>Conteúdo</th><th>Coleta</th></tr></thead><tbody>
    ${cur.evidence.map((e) => {
      const p = e.payload || {};
      let summary = '';
      if (p.kind === 'metrics') summary = p.error ? `<span class="kpi na">${esc(p.error)}</span>` : `${Object.keys(p.metrics || {}).length} indicadores${(p.limitations || []).length ? ` · ${esc(p.limitations.join('; '))}` : ''}`;
      else if (p.kind === 'calculation') summary = p.available ? `<b>${esc(p.formula_code)}</b><br><span class="mono small">${(p.formula || []).map(esc).join('<br>')}</span>` : `<span class="kpi na">${esc(p.reason)}</span>`;
      else if (p.kind === 'knowledge') summary = `<b>${esc(p.title)}</b> v${esc(p.version)}${p.expired ? ' <span class="badge warn">vencido</span>' : ''}<br><span class="small muted">${esc((p.excerpt || '').slice(0, 220))}</span>`;
      return `<tr><td class="mono">${esc(e.ref_code)}</td><td>${e.is_demo ? '<span class="badge demo">DEMO</span> ' : ''}${esc(e.source_type)}<div class="small muted mono">${esc(e.source_ref)}</div></td><td>${esc(e.product || '—')}</td><td><span class="badge ${qual[e.quality]}">${esc(e.quality)}</span></td><td>${summary}<details><summary>dados</summary><pre class="json">${esc(JSON.stringify(p, null, 2))}</pre></details></td><td class="mono small">${fmtDate(e.fetched_at)}<div class="muted" title="checksum">${esc(e.checksum.slice(0, 10))}…</div></td></tr>`;
    }).join('')}</tbody></table></div>`;
}

function checksHtml(ev) {
  return `<div class="checks">${ev.checks.map((k) => `<div class="check"><span class="s ${k.ok ? 'ok' : 'no'}">${k.ok ? '✔' : '✖'}</span><span class="n">${esc(CHECKS[k.check] || k.check)}</span><span>${esc(k.detail)}</span></div>`).join('')}</div>`;
}

function igPreview(pr, username) {
  const cap = esc(pr.caption || '').replace(/(#[\p{L}\p{N}_]+)/gu, '<span class="tag">$1</span>').replace(/\n/g, '<br>');
  return `<div class="ig-card"><div class="ig-head">${svg('insta')}<b>${esc(username ? '@' + username : 'conta vinculada')}</b><span class="muted small">Instagram · feed</span></div>
    <div class="ig-media">${pr.image_url ? `<img src="${esc(pr.image_url)}" alt="Imagem do post" referrerpolicy="no-referrer">` : `<div class="ig-brief"><b>Imagem a produzir</b>${esc(pr.image_brief || 'Sem briefing')}</div>`}</div>
    <div class="ig-caption">${cap || '<span class="muted">Sem legenda</span>'}</div>
    <div class="small muted" style="padding:0 12px 12px">${pr.suggested_time ? `Horário sugerido: ${esc(pr.suggested_time)} · ` : ''}${(pr.caption || '').length}/2200 caracteres · ${(pr.hashtags || []).length}/30 hashtags${pr.edited_by_human ? ' · editado por humano' : ''}</div></div>`;
}

const MASTER_LABELS = { trial_default: 'Teste grátis padrão', grace_days: 'Carência (dias)', renewal_notice_days: 'Aviso de vencimento (dias)', signup_enabled: 'Cadastros abertos', support_contact: 'Contato de suporte', support_whatsapp: 'WhatsApp do suporte', support_email: 'E-mail do suporte', support_hours: 'Horário do suporte', support_message: 'Mensagem de suporte', monthly_price: 'Preço mensal', annual_price: 'Preço anual', name: 'Nome', description: 'Descrição', max_users: 'Máx. usuários', active: 'Ativo', days: 'Prorrogar (dias)' };
function masterDiffHtml(pr) {
  const after = pr.values || pr.changes || (pr.days ? { days: pr.days } : {});
  const rows = Object.entries(after).map(([k, v]) => `<tr><td>${esc(MASTER_LABELS[k] || k)}</td><td class="mono">${esc(JSON.stringify(pr.before?.[k] ?? '—'))}</td><td class="mono" style="color:var(--green)">${esc(JSON.stringify(v))}</td></tr>`).join('');
  return `<table><thead><tr><th>Campo</th><th>Antes</th><th>Depois</th></tr></thead><tbody>${rows || '<tr><td colspan="3" class="muted">Sem alterações</td></tr>'}</tbody></table>`;
}

function proposalDetails(p) {
  const pr = p.parameters || {};
  if (p.tool_code?.startsWith('master_')) {
    return `<dl class="kv"><dt>Ação</dt><dd><b>${esc(TOOLS[p.tool_code])}</b> — ${esc(pr.title)}</dd><dt>Sistema</dt><dd>${esc((pr.product || '').toUpperCase() || '—')}${pr.plan_name ? ` · plano ${esc(pr.plan_name)}` : ''}${pr.tenant_name ? ` · empresa ${esc(pr.tenant_name)}` : ''}</dd>
      <dt>Mudança</dt><dd>${masterDiffHtml(pr)}<div class="small muted" style="margin-top:6px">Os valores “antes” foram lidos da Área Master pelo servidor. Se mudarem até a execução, a ação é bloqueada.</div></dd>
      <dt>Justificativa</dt><dd>${esc(pr.description || '—')}</dd><dt>Validade da aprovação</dt><dd>${p.expires_at ? fmtDate(p.expires_at) : '—'}</dd><dt>Versão / hash</dt><dd class="mono small">v${p.version} · ${esc(p.payload_hash.slice(0, 24))}…</dd></dl>`;
  }
  if (p.tool_code === 'publish_instagram_post') {
    return `<div class="grid g2"><div>${igPreview(pr, state.igUser)}</div><dl class="kv"><dt>Ação</dt><dd><b>${esc(TOOLS[p.tool_code])}</b> — ${esc(pr.title)}</dd><dt>Público</dt><dd>${esc(p.target)}</dd>
      <dt>Chamada para ação</dt><dd>${esc(pr.call_to_action || '—')}</dd><dt>Justificativa</dt><dd>${esc(pr.description || '—')}</dd><dt>Validade da aprovação</dt><dd>${p.expires_at ? fmtDate(p.expires_at) : '—'}</dd>
      <dt>Versão / hash</dt><dd class="mono small">v${p.version} · ${esc(p.payload_hash.slice(0, 24))}…</dd></dl></div>`;
  }
  const known = ['title', 'description', 'max_amount', 'currency', 'due_in_days', 'checklist'];
  const extra = Object.entries(pr).filter(([k]) => !known.includes(k));
  return `<dl class="kv"><dt>Ação</dt><dd><b>${esc(TOOLS[p.tool_code] || p.tool_code)}</b> — ${esc(pr.title)}</dd>
    <dt>Público / destino</dt><dd>${esc(p.target)}</dd><dt>Descrição completa</dt><dd>${esc(pr.description || '—')}</dd>
    ${Array.isArray(pr.checklist) && pr.checklist.length ? `<dt>Checklist</dt><dd>${list(pr.checklist)}</dd>` : ''}
    ${extra.length ? `<dt>Parâmetros</dt><dd class="mono small">${extra.map(([k, v]) => `${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v)}`).join('<br>')}</dd>` : ''}
    <dt>Valor máximo</dt><dd>${fmtMoney(pr.max_amount)} (${esc(pr.currency)})</dd><dt>Prazo da ação</dt><dd>${esc(pr.due_in_days)} dias</dd>
    <dt>Validade da aprovação</dt><dd>${p.expires_at ? fmtDate(p.expires_at) : '—'}</dd><dt>Versão / hash</dt><dd class="mono small">v${p.version} · ${esc(p.payload_hash.slice(0, 24))}…</dd></dl>`;
}

function tabProposal(cur) {
  if (!cur.proposals.length) return '<div class="empty"><b>Sem proposta</b>Nenhuma intenção de ação foi registrada nesta execução.</div>';
  return cur.proposals.map((p) => `<div class="panel" style="margin-bottom:12px"><div class="row" style="justify-content:space-between"><h2>Proposta v${p.version}</h2>${st(p.status)}</div>${proposalDetails(p)}
    ${p.evaluations.map((ev) => `<h3 style="margin-top:14px">Motor de políticas · ${ev.stage === 'proposal' ? 'avaliação da proposta' : 'revalidação na execução'} → <span class="badge ${ev.result === 'allow' ? 'ok' : ev.result === 'deny' ? 'danger' : 'warn'}">${esc(ev.result)}</span></h3>${checksHtml(ev)}`).join('')}</div>`).join('');
}

function tabApproval(cur, d) {
  const s = cur.synthesis || {};
  const pend = cur.proposals.filter((p) => p.status === 'awaiting_approval');
  const hist = cur.proposals.flatMap((p) => p.approvals.map((a) => ({ ...a, v: p.version })));
  let html = '';
  for (const p of pend) {
    const ev = p.evaluations[0];
    html += `<div class="panel" style="margin-bottom:12px">${d.is_demo ? '<div class="demo-banner" style="margin-bottom:10px">Proposta baseada em dados fictícios</div>' : ''}<h2>Aprovação exigida · ${esc((ev?.required_approvers || []).join(', '))}</h2>
      ${proposalDetails(p)}
      <dl class="kv" style="margin-top:10px"><dt>Benefício esperado</dt><dd>${esc(s.proposal || '')}<div class="small muted" style="margin-top:6px">Premissas:</div><div class="small">${list(s.assumptions)}</div></dd>
      <dt>Riscos e limitações</dt><dd>${list(s.risks)}</dd><dt>Pareceres e evidências</dt><dd>${cur.tasks.filter((t) => t.status === 'done').length} pareceres · ${cur.evidence.length} evidências (abas acima)</dd></dl>
      ${p.tool_code === 'publish_instagram_post' && state.me.permissions.includes('approve') ? `<details class="ig-edit" ${p.parameters.image_url ? '' : 'open'}><summary>Editar conteúdo do post (gera nova versão para aprovação)</summary>
        <div class="grid" style="margin-top:10px"><label class="field">Legenda<textarea id="igc-${p.id}" maxlength="2000">${esc(p.parameters.caption_body || '')}</textarea></label>
        <label class="field">Hashtags (sem #, separadas por espaço)<input id="igh-${p.id}" value="${esc((p.parameters.hashtags || []).join(' '))}"></label>
        <label class="field">URL pública HTTPS da imagem (JPEG, ideal 1080×1350)<input id="igi-${p.id}" value="${esc(p.parameters.image_url || '')}" placeholder="https://…/post.jpg"></label>
        <div class="row"><button class="btn primary sm" data-igsave="${p.id}">Salvar nova versão</button><span class="small muted">A aprovação vale apenas para o conteúdo exato exibido.</span></div></div></details>` : ''}
      ${p.can_decide ? `<label class="field" style="margin-top:12px">Justificativa / comentário<textarea id="cm-${p.id}" placeholder="Opcional para aprovar; recomendado para rejeitar ou revisar"></textarea></label>
        <div class="row" style="margin-top:10px"><button class="btn ok" data-approve="${p.id}" data-action="approve">Aprovar</button><button class="btn ghost sm" data-wa="${p.id}" title="Enviar o pedido para o WhatsApp dos aprovadores">Enviar ao WhatsApp</button><button class="btn danger" data-approve="${p.id}" data-action="reject">Rejeitar</button><button class="btn warn" data-approve="${p.id}" data-action="revise">Solicitar revisão</button></div>
        <p class="small muted">A aprovação fica vinculada à versão v${p.version} e ao hash exibido. Qualquer alteração exige nova aprovação. Silêncio não é aprovação.</p>`
        : `<div class="alert">Seu papel (${esc(state.me.role)}) não pode decidir esta proposta.</div>`}</div>`;
  }
  const approved = cur.proposals.filter((p) => p.status === 'approved');
  for (const p of approved) {
    const ev = p.evaluations.filter((e) => e.stage === 'execution').at(-1);
    const why = ev ? ev.checks.filter((k) => k.hard && !k.ok).map((k) => k.detail).join('; ') : '';
    html += `<div class="alert ${why ? 'warn' : ''}">Proposta v${p.version} aprovada e ainda não executada.${why ? ` Motivo: ${esc(why)}.` : ''} <button class="btn sm ok" data-exec="${p.id}">Executar agora</button> <button class="btn sm danger" data-revoke="${p.id}">Revogar aprovação</button></div>`;
  }
  html += `<h3 style="margin-top:12px">Histórico de decisões humanas</h3>${hist.length ? `<table><thead><tr><th>Versão</th><th>Resultado</th><th>Responsável</th><th>Comentário</th><th>Data</th></tr></thead><tbody>${hist.map((a) => `<tr><td>v${a.v}</td><td>${esc(a.result)}</td><td>${esc(a.approver)}</td><td>${esc(a.comment || '')}</td><td class="mono small">${fmtDate(a.decided_at)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Nenhuma decisão humana registrada.</p>'}`;
  return html || '<div class="empty"><b>Nada a aprovar</b></div>';
}

function tabResult(cur) {
  const execs = cur.proposals.flatMap((p) => p.executions.map((x) => ({ ...x, p })));
  let html = '';
  for (const p of cur.proposals) {
    if (p.status === 'advisory') html += '<div class="alert">Decisão consultiva: o relatório é o resultado; nenhuma ação foi proposta.</div>';
    if (p.status === 'denied') html += `<div class="alert danger">Proposta v${p.version} bloqueada pelo motor de políticas. Ajuste os parâmetros ou a política pelo fluxo administrativo.</div>`;
    if (p.status === 'approved' && p.evaluations.some((e) => e.stage === 'execution' && e.result !== 'allow')) html += `<div class="alert warn">Proposta v${p.version} aprovada, porém sem executor habilitado no MVP — aplicar pelo fluxo próprio do produto e registrar o resultado.</div>`;
  }
  if (execs.length) {
    html += `<table><thead><tr><th>Proposta</th><th>Status</th><th>Referência externa</th><th>Chave de idempotência</th><th>Início/fim</th><th></th></tr></thead><tbody>${execs.map((x) => `<tr><td>v${x.p.version} · ${esc(TOOLS[x.p.tool_code])}</td><td>${st(x.status)}</td><td class="mono small">${x.result?.permalink ? `<a href="${esc(x.result.permalink)}" target="_blank" rel="noopener">ver no Instagram ↗</a><br>` : ''}${esc(x.external_ref || '—')}</td><td class="mono small">${esc(x.idempotency_key.slice(0, 34))}…</td><td class="mono small">${fmtDate(x.started_at)}<br>${fmtDate(x.finished_at)}</td><td>${x.status === 'uncertain' ? `<button class="btn sm warn" data-reconcile="${x.p.id}">Conciliar</button>` : ''}</td></tr>`).join('')}</tbody></table>
    ${execs.some((x) => x.status === 'succeeded' && x.p.tool_code === 'create_internal_task') ? '<p class="small muted">Tarefa interna disponível em Histórico e auditoria → Tarefas internas.</p>' : ''}`;
  }
  return html || '<div class="empty"><b>Sem resultado de execução</b>Nenhuma ação foi executada nesta decisão.</div>';
}

// ---------------- Aprovações ----------------
async function viewApprovals(c) {
  const rows = await api('GET', '/api/approvals');
  c.innerHTML = `<div class="panel"><h2>Aprovações</h2>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Proposta</th><th>Produto</th><th>Ferramenta</th><th>Status</th><th>Validade</th></tr></thead><tbody>${rows.map((r) => `<tr class="click" data-href="#/decisao/${r.decision_id}"><td>${r.is_demo ? '<span class="badge demo">DEMO</span> ' : ''}<b>${esc(r.summary)}</b><div class="small muted">${esc(r.question)}</div></td><td>${esc(r.product || '—')}</td><td>${esc(TOOLS[r.tool_code] || r.tool_code)}</td><td>${st(r.status)}</td><td class="mono small">${fmtDate(r.expires_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><b>Fila vazia</b>Nenhuma proposta aguardando decisão.</div>'}</div>`;
  bindRows(c);
}

// ---------------- Agentes ----------------
async function viewAgents(c) {
  const agents = await api('GET', '/api/agents');
  c.innerHTML = `<div class="grid g2">${agents.map((a) => {
    const v = a.versions[0];
    return `<div class="panel c-${a.code}"><div class="row" style="justify-content:space-between"><h2 style="color:var(--c)">${esc(a.name)}</h2><span>${a.enabled ? '<span class="badge ok">ativo</span>' : '<span class="badge danger">desabilitado</span>'} <span class="badge">v${v.version}</span></span></div>
      <p class="muted">${esc(a.description)}</p>
      <dl class="kv small"><dt>Identificador</dt><dd class="mono">${esc(a.code)}</dd><dt>Ferramentas</dt><dd>${v.tools.map((t) => `<span class="badge">${esc(t.code)}</span>`).join(' ')}</dd>
      <dt>Recebe pareceres de</dt><dd>${v.accepts_from.map((x) => esc(AGENTS[x]?.short || x)).join(', ')}</dd><dt>Limites</dt><dd class="mono">${esc(JSON.stringify(v.limits))}</dd><dt>Esquema de saída</dt><dd class="mono">${esc(v.output_schema_version)}</dd></dl>
      <details style="margin-top:10px"><summary>Instruções (v${v.version}) e histórico (${a.versions.length})</summary>
        <textarea class="code" id="ins-${a.id}" ${a.can_edit ? '' : 'readonly'}>${esc(v.instructions)}</textarea>
        ${a.can_edit ? `<div class="row" style="margin-top:8px"><button class="btn sm primary" data-save="${a.id}">Salvar como nova versão</button>${a.code !== 'coordinator' ? `<button class="btn sm ${a.enabled ? 'danger' : 'ok'}" data-toggle="${a.id}" data-en="${a.enabled ? 0 : 1}">${a.enabled ? 'Desabilitar' : 'Habilitar'}</button>` : ''}</div><p class="small muted">Alterações criam uma nova versão; execuções anteriores mantêm a versão usada. O texto do prompt não amplia ferramentas nem escopos.</p>` : ''}
      </details></div>`;
  }).join('')}</div>`;
  $$('[data-save]', c).forEach((b) => { b.onclick = async () => { try { const r = await api('POST', `/api/agents/${b.dataset.save}/versions`, { instructions: $(`#ins-${b.dataset.save}`, c).value }); toast(`Versão ${r.version} criada.`); route(); } catch (e) { fail(e); } }; });
  $$('[data-toggle]', c).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/agents/${b.dataset.toggle}/toggle`, { enabled: b.dataset.en === '1' }); route(); } catch (e) { fail(e); } }; });
}

// ---------------- Conhecimento ----------------
async function viewKnowledge(c, _a, term = '') {
  const [docs, products] = await Promise.all([api('GET', `/api/knowledge${term ? `?q=${encodeURIComponent(term)}` : ''}`), api('GET', '/api/products')]);
  const canEdit = state.me.permissions.includes('manage_knowledge');
  c.innerHTML = `<div class="panel"><h2>Base de conhecimento</h2><form id="ks" class="command"><input name="q" placeholder="Buscar em documentos autorizados…" value="${esc(term)}"><button class="btn">Buscar</button></form></div>
    <div class="grid g2">${docs.map((d) => `<div class="panel"><div class="row" style="justify-content:space-between"><h2>${esc(d.title)}</h2><span>${d.is_demo ? '<span class="badge demo">DEMO</span>' : ''} <span class="badge">v${d.version}</span> <span class="badge">${esc(d.classification)}</span> ${d.expired ? '<span class="badge warn">vencido</span>' : ''}${d.status === 'archived' ? '<span class="badge">arquivado</span>' : ''}</span></div>
      <p style="white-space:pre-wrap">${esc(d.content)}</p><div class="small muted mono">Produto: ${esc(d.product || 'todos')} · vigente desde ${fmtDate(d.effective_from)}${d.expires_at ? ` · validade ${fmtDate(d.expires_at)}` : ''} · checksum ${esc(d.checksum.slice(0, 12))}…${d.approved_by ? ` · aprovado por ${esc(d.approved_by)}` : ''}</div>
      ${canEdit && d.status !== 'archived' ? `<button class="btn sm ghost" data-arch="${d.id}" style="margin-top:8px">Arquivar</button>` : ''}</div>`).join('') || '<div class="panel empty"><b>Nenhum documento</b></div>'}</div>
    ${canEdit ? `<div class="panel"><h2>Novo documento ou versão</h2><form id="kf" class="grid g2">
      <label class="field">Título<input name="title" required></label>
      <label class="field">Atualizar documento existente<select name="document_id"><option value="">— novo documento —</option>${docs.map((d) => `<option value="${d.id}">${esc(d.title)}</option>`).join('')}</select></label>
      <label class="field span2">Conteúdo<textarea name="content" required></textarea></label>
      <label class="field">Classificação<select name="classification"><option value="internal">Interno</option><option value="public">Público</option><option value="restricted">Restrito</option></select></label>
      <label class="field">Produto<select name="product_id"><option value="">Todos</option>${products.filter((p) => p.in_scope).map((p) => `<option value="${p.id}">${esc(p.code)}</option>`).join('')}</select></label>
      <label class="field">Validade (opcional)<input type="date" name="expires_at"></label>
      <div class="field">Regras estruturadas de desconto (opcional)<div class="row"><input name="max_discount_pct" placeholder="Teto %" inputmode="decimal"><input name="approval_above_pct" placeholder="Aprovação acima de %" inputmode="decimal"><input name="max_duration_months" placeholder="Meses máx." inputmode="numeric"></div></div>
      <div class="span2 row"><button class="btn primary">Registrar versão</button><span class="small muted">Sugestões da IA não viram regra automaticamente: somente documentos registrados aqui por usuário autorizado.</span></div></form></div>` : ''}`;
  $('#ks', c).onsubmit = (e) => { e.preventDefault(); viewKnowledge(c, null, e.target.q.value.trim()); };
  $$('[data-arch]', c).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/knowledge/${b.dataset.arch}/archive`, {}); route(); } catch (e) { fail(e); } }; });
  const f = $('#kf', c);
  if (f) f.onsubmit = async (e) => {
    e.preventDefault();
    const rules = { max_discount_pct: f.max_discount_pct.value, approval_above_pct: f.approval_above_pct.value, max_duration_months: f.max_duration_months.value };
    Object.keys(rules).forEach((k) => { if (rules[k] === '') delete rules[k]; });
    try { await api('POST', '/api/knowledge', { title: f.title.value, content: f.content.value, classification: f.classification.value, product_id: f.product_id.value || undefined, document_id: f.document_id.value || undefined, expires_at: f.expires_at.value || undefined, rules: Object.keys(rules).length ? rules : undefined }); toast('Versão registrada.'); route(); } catch (err) { fail(err); }
  };
}

// ---------------- Integrações ----------------
async function viewIntegrations(c) {
  const [rows, ig, ms, wme] = await Promise.all([api('GET', '/api/integrations'), api('GET', '/api/social/instagram'), api('GET', '/api/master/status'), api('GET', '/api/whatsapp/me')]);
  if (state.query?.get('ig') === 'ok') toast('Conta do Instagram vinculada.');
  if (state.query?.get('ig') === 'erro') toast(state.query.get('msg') || 'Falha ao vincular o Instagram.', true);
  const acc = ig.account; state.igUser = acc?.username || null;
  c.innerHTML = `<div class="grid g2"><div class="panel master-panel"><div class="row" style="justify-content:space-between"><h2>Área Master</h2>${ms.configured ? (ms.last ? st(ms.last.ok ? 'connected' : 'error') : '<span class="st wait">Não testada</span>') : '<span class="st wait">Não configurada</span>'}</div>
      <p class="muted small">Assinaturas, cobranças, planos e parâmetros de todos os sistemas. O cérebro <b>lê</b> esses dados nas análises e pode <b>propor mudanças</b> (parâmetros, planos, prorrogação de teste) que só são aplicadas depois da sua aprovação.</p>
      <dl class="kv small"><dt>Endereço</dt><dd class="mono">${esc(ms.url || 'LORLER_MASTER_URL não definido')}</dd><dt>Administrador</dt><dd class="mono">${esc(ms.username || '—')} ${ms.password_configured ? '<span class="badge ok">senha definida</span>' : '<span class="badge warn">senha ausente</span>'} ${ms.totp_configured ? '<span class="badge ok">MFA</span>' : ''}</dd>
      <dt>Última verificação</dt><dd>${ms.last ? `${fmtDate(ms.last.checked_at)} · ${ms.last.ok ? `sistemas: ${esc((ms.last.products || []).join(', ') || '—')}` : `<span class="unsupported">${esc(ms.last.message)}</span>`}` : '—'}</dd></dl>
      ${ms.can_manage ? `<div class="row" style="margin-top:10px"><button class="btn primary sm" id="ms-test" ${ms.configured ? '' : 'disabled'}>Testar conexão</button><select id="ms-prod" style="width:auto">${['orbi', 'torven', 'rusten', 'apolven'].map((x) => `<option value="${x}">${x.toUpperCase()}</option>`).join('')}</select><button class="btn sm" id="ms-prev" ${ms.configured ? '' : 'disabled'}>Ver dados (30 dias)</button></div><div id="ms-out"></div>` : ''}
      ${ms.configured ? '' : '<p class="small muted">Configure no .env: LORLER_MASTER_URL, LORLER_MASTER_USERNAME e LORLER_SECRET_MASTER_PASSWORD (administrador dedicado). Veja docs/AREA-MASTER.md.</p>'}</div>
    <div class="panel wa-panel"><div class="row" style="justify-content:space-between"><h2>WhatsApp</h2>${wme.configured ? '<span class="st good">Configurado</span>' : '<span class="st wait">Não configurado</span>'}</div>
      <p class="muted small">Pedidos de aprovação chegam no seu WhatsApp com botões <b>Aprovar / Rejeitar / Ver detalhes</b>; aprovar pede o seu PIN. Vincule seu número em <a href="#/admin">Administração</a>.</p>
      <dl class="kv small"><dt>Número da LORLER</dt><dd class="mono">${esc(wme.business_number ? '+' + wme.business_number : '—')}</dd><dt>URL do webhook</dt><dd class="mono">${esc(wme.webhook_url || 'defina LORLER_PUBLIC_URL (endereço público)')}</dd><dt>Modelo de mensagem</dt><dd>${wme.template_configured ? '<span class="badge ok">configurado</span>' : '<span class="badge warn">sem modelo — só entrega dentro de 24 h da sua última mensagem</span>'}</dd></dl>
      ${wme.configured ? '' : '<p class="small muted">Passo a passo em docs/WHATSAPP.md.</p>'}</div></div>
  <div class="panel ig-panel"><div class="row" style="justify-content:space-between"><h2>${svg('insta', 'ico-inline')} Instagram</h2>${acc ? st(acc.status) : '<span class="st wait">Não vinculada</span>'}</div>
    ${acc ? `<dl class="kv small"><dt>Conta</dt><dd><b>@${esc(acc.username)}</b> · ${esc(acc.account_type || '')}</dd><dt>Vinculada em</dt><dd>${fmtDate(acc.connected_at)} · ${acc.link_method === 'oauth' ? 'login do Instagram' : 'token de acesso'}</dd>
      <dt>Validade do token</dt><dd>${acc.token_expires_at ? fmtDate(acc.token_expires_at) : 'não informada'}</dd><dt>Última verificação</dt><dd>${fmtDate(acc.last_checked_at)}${acc.last_check_result && !acc.last_check_result.ok ? ` <span class="unsupported">${esc(acc.last_check_result.message)}</span>` : ''}</dd></dl>`
      : `<p class="muted">Vincule a conta <b>profissional</b> (Empresa ou Criador de conteúdo) do Instagram para que o Agente de Marketing possa publicar os posts que você aprovar. Nada é publicado sem a sua aprovação do conteúdo exato.</p>`}
    ${ig.can_manage ? `<div class="row" style="margin-top:12px">
      <button class="btn primary" id="ig-oauth" ${ig.app_configured ? '' : 'disabled title="Configure o app da Meta no .env"'}>${svg('insta')} ${acc ? 'Vincular outra conta' : 'Vincular minha conta do Instagram'}</button>
      <button class="btn" id="ig-token">Colar token de acesso</button>
      ${acc ? '<button class="btn" id="ig-verify">Verificar</button><button class="btn danger" id="ig-off">Desvincular</button>' : ''}</div>
      ${ig.app_configured ? `<p class="small muted">URL de retorno cadastrada: <span class="mono">${esc(ig.redirect_uri)}</span></p>` : '<p class="small muted">Login pelo Instagram exige um app da Meta (INSTAGRAM_APP_ID, INSTAGRAM_APP_SECRET e INSTAGRAM_REDIRECT_URI em HTTPS no .env). Sem ele, use “Colar token de acesso”. Passo a passo em <span class="mono">docs/INSTAGRAM.md</span>.</p>'}` : ''}
    ${ig.posts.length ? `<h3 style="margin-top:14px">Publicações propostas</h3><div class="table-wrap"><table><thead><tr><th>Post</th><th>Status</th><th>Publicação</th></tr></thead><tbody>${ig.posts.map((x) => `<tr class="click" data-href="#/decisao/${x.decision_id}"><td><b>${esc(x.title || '')}</b> <span class="badge">v${x.version}</span><div class="small muted">${esc((x.caption || '').slice(0, 120))}…</div></td><td>${st(x.exec_status || x.status)}</td><td class="small">${x.result?.permalink ? `<a href="${esc(x.result.permalink)}" target="_blank" rel="noopener">abrir ↗</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}
  </div>
  <div class="panel"><h2>Conectores de leitura</h2><p class="muted small">Cada produto expõe <span class="mono">GET {URL}/lorler/v1/metrics</span> com credencial de leitura (Bearer). A credencial fica somente no <span class="mono">.env</span> do servidor; aqui aparece apenas a referência. O teste faz uma consulta real — sem teste bem-sucedido a integração não é ativada. Contrato em <span class="mono">docs/CONECTORES.md</span>.</p></div>
    <div class="grid g2">${rows.map((i) => `<div class="panel"><div class="row" style="justify-content:space-between"><h2>${esc(i.product)}</h2>${st(i.status)}</div>
      <dl class="kv small"><dt>Adaptador</dt><dd class="mono">${esc(i.adapter)} v${esc(i.adapter_version)}</dd><dt>Credencial</dt><dd class="mono">${esc(i.secret_ref)} ${i.secret_configured ? '<span class="badge ok">definida</span>' : '<span class="badge warn">ausente no .env</span>'}</dd>
      <dt>Última verificação</dt><dd>${fmtDate(i.last_checked_at)}${i.last_check_result ? `<div class="small ${i.last_check_result.ok ? '' : 'unsupported'}">${esc(i.last_check_result.ok ? `${i.last_check_result.metrics} indicadores retornados` : `${i.last_check_result.kind}: ${i.last_check_result.message}`)}</div>` : ''}</dd></dl>
      ${i.can_edit ? `<label class="field" style="margin-top:10px">URL da API do produto<input id="u-${i.id}" value="${esc(i.base_url || '')}" placeholder="https://api.produto.exemplo"></label>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-saveu="${i.id}">Salvar URL</button><button class="btn sm primary" data-test="${i.id}">Testar conexão</button>${i.status !== 'disabled' ? `<button class="btn sm danger" data-dis="${i.id}">Desligar</button>` : ''}</div>` : ''}</div>`).join('')}</div>`;
  bindRows(c);
  $('#ms-test', c)?.addEventListener('click', async (e) => { e.target.disabled = true; try { const r = await api('POST', '/api/master/test', {}); toast(r.ok ? 'Área Master conectada.' : `Falha: ${r.message}`, !r.ok); route(); } catch (err) { fail(err); route(); } });
  $('#ms-prev', c)?.addEventListener('click', async () => {
    const out = $('#ms-out', c); out.innerHTML = '<p class="muted small">Consultando…</p>';
    try {
      const r = await api('GET', `/api/master/preview?product=${$('#ms-prod', c).value}`);
      out.innerHTML = `<div class="metric-list" style="margin-top:10px">${r.contract.metrics.map((m) => `<span>${esc(m.code)}</span><span>${m.value == null ? '<span class="kpi na">Dados insuficientes</span>' : esc(m.value)}${m.quality !== 'complete' ? ` <span class="badge warn">${esc(m.quality)}</span>` : ''}</span>`).join('')}</div>
        <h3 style="margin-top:10px">Planos</h3>${r.config.plans.map((p) => `<div class="small">${esc(p.name)} · ${fmtMoney(p.monthly_price)}/mês · ${p.active ? 'ativo' : 'inativo'} · ${p.tenants ?? 0} empresas</div>`).join('') || '<p class="muted small">Sem planos.</p>'}
        <h3 style="margin-top:10px">Parâmetros</h3><div class="small mono">${esc(JSON.stringify(r.config.settings))}</div>`;
    } catch (err) { out.innerHTML = `<div class="alert danger small">${esc(err.message)}</div>`; }
  });
  $('#ig-oauth', c)?.addEventListener('click', async () => { try { const r = await api('POST', '/api/social/instagram/oauth/start', {}); location.href = r.authorize_url; } catch (e) { fail(e); } });
  $('#ig-verify', c)?.addEventListener('click', async () => { try { const r = await api('POST', '/api/social/instagram/verify', {}); toast(`Conta @${r.username} verificada.`); route(); } catch (e) { fail(e); route(); } });
  $('#ig-off', c)?.addEventListener('click', async () => { try { await api('POST', '/api/social/instagram/disconnect', {}); toast('Conta desvinculada.'); route(); } catch (e) { fail(e); } });
  $('#ig-token', c)?.addEventListener('click', () => modal(`<h2>Vincular por token de acesso</h2><p class="small muted">Gere um token de acesso do Instagram (conta profissional, permissões <span class="mono">instagram_business_basic</span> e <span class="mono">instagram_business_content_publish</span>) no painel de desenvolvedores da Meta. O token é verificado, guardado criptografado e nunca volta para o navegador.</p>
    <form id="tf" class="grid"><label class="field">Token de acesso<input name="t" required autocomplete="off" spellcheck="false"></label><div class="err" id="terr"></div><div class="row"><button class="btn primary">Vincular</button><button type="button" class="btn ghost" id="tc">Cancelar</button></div></form>`, (m, close) => {
    $('#tc', m).onclick = close;
    $('#tf', m).onsubmit = async (e) => { e.preventDefault(); try { const r = await api('POST', '/api/social/instagram/token', { access_token: e.target.t.value.trim() }); close(); toast(`Conta @${r.account.username} vinculada.`); route(); } catch (err) { $('#terr', m).textContent = err.message; } };
  }));
  $$('[data-saveu]', c).forEach((b) => { b.onclick = async () => { try { await api('PUT', `/api/integrations/${b.dataset.saveu}`, { base_url: $(`#u-${b.dataset.saveu}`, c).value }); toast('URL salva. Teste a conexão para ativar.'); route(); } catch (e) { fail(e); } }; });
  $$('[data-test]', c).forEach((b) => { b.onclick = async () => { b.disabled = true; b.textContent = 'Testando…'; try { const r = await api('POST', `/api/integrations/${b.dataset.test}/test`, {}); toast(r.ok ? 'Conexão verificada com consulta real.' : `Falha: ${r.message}`, !r.ok); route(); } catch (e) { fail(e); route(); } }; });
  $$('[data-dis]', c).forEach((b) => { b.onclick = async () => { try { await api('PUT', `/api/integrations/${b.dataset.dis}`, { status: 'disabled' }); route(); } catch (e) { fail(e); } }; });
}

// ---------------- Regras e limites ----------------
async function viewRules(c) {
  const p = await api('GET', '/api/policies');
  const r = p.active.rules;
  const L = r.limits;
  const modes = { allow: 'Permitida', require_approval: 'Exige aprovação', deny: 'Negada' };
  c.innerHTML = `<div class="grid g2"><div class="panel"><h2>Política vigente · v${p.active.version}</h2>
      <div class="metric-list"><span>Especialistas por execução</span><span>${L.max_specialists}</span><span>Rodadas de revisão</span><span>${L.max_review_rounds}</span><span>Chamadas ao modelo por execução</span><span>${L.max_model_calls}</span><span>Agentes em paralelo</span><span>${L.max_parallel_agents}</span><span>Novas tentativas</span><span>${L.max_retries}</span><span>Prazo da análise</span><span>${L.analysis_timeout_ms / 60000} min</span><span>Validade da aprovação</span><span>${L.approval_ttl_hours} h</span><span>Tokens por execução</span><span>${fmtNum(L.max_tokens_per_run)}</span><span>Orçamento técnico mensal (tokens)</span><span>${fmtNum(L.monthly_token_budget)}</span><span>Orçamento empresarial mensal</span><span>${fmtMoney(r.business_budget?.monthly_limit)}</span><span>Desconto máximo</span><span>${r.discount?.max_discount_pct}%</span><span>Aprovação do owner acima de</span><span>${r.discount?.approval_above_pct}%</span><span>Validade de dados de integração</span><span>${r.data_validity_hours?.integration} h</span></div></div>
    <div class="panel"><h2>Ferramentas e ações</h2><div class="table-wrap"><table><thead><tr><th>Ação</th><th>Tratamento</th><th>Aprovadores</th><th>Executor</th></tr></thead><tbody>${Object.entries(r.tools).map(([k, v]) => `<tr><td>${esc(TOOLS[k] || k)}</td><td>${v.enabled === false && v.mode !== 'deny' ? '<span class="badge">desabilitada</span>' : `<span class="badge ${v.mode === 'deny' ? 'danger' : v.mode === 'allow' ? 'ok' : 'warn'}">${esc(modes[v.mode] || v.mode)}</span>`}</td><td>${esc((v.approver_roles || []).join(', ') || '—')}</td><td>${v.executor ? '<span class="badge ok">sim</span>' : '<span class="badge">não</span>'}</td></tr>`).join('')}</tbody></table></div>
      <p class="small muted">Modificar políticas é operação administrativa autenticada — nunca uma ferramenta de agente. Pagamentos, bloqueio de clientes, exclusão de dados e alterações em produção permanecem negados.</p></div></div>
    ${p.can_edit ? `<div class="panel"><h2>Nova versão da política</h2><textarea class="code" id="pol">${esc(JSON.stringify(r, null, 2))}</textarea><div class="row" style="margin-top:10px"><button class="btn primary" id="psave">Publicar nova versão</button><span class="small muted">Exige confirmação de senha. Propostas pendentes criadas na versão anterior deixam de ser executáveis.</span></div></div>` : ''}
    <div class="panel"><h2>Histórico</h2><table><thead><tr><th>Versão</th><th>Vigência</th><th>Autor</th></tr></thead><tbody>${p.history.map((h) => `<tr><td>v${h.version}</td><td class="mono small">${fmtDate(h.effective_from)}</td><td>${esc(h.author || 'instalação')}</td></tr>`).join('')}</tbody></table></div>`;
  $('#psave', c)?.addEventListener('click', async () => {
    let rules; try { rules = JSON.parse($('#pol', c).value); } catch { toast('JSON inválido.', true); return; }
    try { const res = await api('POST', '/api/policies/versions', { rules }); toast(`Política v${res.version} publicada.`); route(); } catch (e) { fail(e); }
  });
}

// ---------------- Auditoria ----------------
async function viewAudit(c) {
  const canAudit = state.me.permissions.includes('view_audit');
  const [events, usage, tasks] = await Promise.all([canAudit ? api('GET', '/api/audit') : Promise.resolve(null), api('GET', '/api/usage'), api('GET', '/api/tasks')]);
  c.innerHTML = `<div class="grid g2"><div class="panel"><h2>Consumo por agente (mês)</h2><table><thead><tr><th>Agente</th><th>Chamadas</th><th>Tokens</th><th>Custo</th></tr></thead><tbody>${usage.by_agent.map((u) => `<tr><td>${esc(AGENTS[u.agent_code]?.name || u.agent_code || '—')}</td><td>${fmtNum(u.calls)}</td><td>${fmtNum((u.input_tokens || 0) + (u.output_tokens || 0))}</td><td>${u.cost != null ? Number(u.cost).toFixed(4) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Sem consumo.</td></tr>'}</tbody></table></div>
    <div class="panel"><h2>Tarefas internas</h2>${tasks.length ? `<table><thead><tr><th>Tarefa</th><th>Prazo</th><th>Status</th></tr></thead><tbody>${tasks.map((t) => `<tr><td><b>${esc(t.title)}</b><div class="small muted" style="white-space:pre-wrap">${esc(t.description)}</div></td><td class="mono small">${esc(t.due_date || '—')}</td><td>${st(t.status)}${t.status === 'open' && state.me.permissions.includes('create_decision') ? ` <button class="btn sm ok" data-done="${t.id}">Concluir</button>` : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="empty"><b>Sem tarefas</b>Tarefas criadas pelo executor aparecem aqui.</div>'}</div></div>
    <div class="panel"><h2>Consumo por execução</h2><table><thead><tr><th>Execução</th><th>Chamadas</th><th>Tokens</th><th>Custo</th></tr></thead><tbody>${usage.by_run.map((u) => `<tr><td><span class="mono small">${esc(u.run_id.slice(0, 8))}</span> ${esc(u.question)}</td><td>${fmtNum(u.calls)}</td><td>${fmtNum(u.tokens)}</td><td>${u.cost != null ? Number(u.cost).toFixed(4) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">—</td></tr>'}</tbody></table></div>
    ${events ? `<div class="panel"><h2>Trilha de auditoria</h2><div class="table-wrap"><table><thead><tr><th>Data</th><th>Ator</th><th>Evento</th><th>Objeto</th><th>request_id</th><th>Detalhes</th></tr></thead><tbody>${events.map((e) => `<tr><td class="mono small">${fmtDate(e.created_at)}</td><td>${esc(e.actor_name || e.actor_type)}<div class="small muted">${esc(e.actor_type)}</div></td><td class="mono small">${esc(e.event_type)}</td><td class="small">${esc(e.object_type || '')}<div class="mono muted">${esc((e.object_id || '').slice(0, 8))}</div></td><td class="mono small">${esc((e.request_id || '').slice(0, 8))}</td><td class="mono small">${esc(JSON.stringify(e.metadata)).slice(0, 160)}</td></tr>`).join('')}</tbody></table></div><p class="small muted">Eventos somente inclusão (o banco bloqueia alteração e exclusão).</p></div>` : '<div class="panel"><p class="muted">A trilha de auditoria completa é visível para o papel owner.</p></div>'}`;
  $$('[data-done]', c).forEach((b) => { b.onclick = async () => { try { await api('POST', `/api/tasks/${b.dataset.done}/status`, { status: 'done' }); route(); } catch (e) { fail(e); } }; });
}

// ---------------- Administração ----------------
async function viewAdmin(c) {
  const me = state.me;
  const isOwner = me.permissions.includes('manage_members');
  const [members, products] = await Promise.all([isOwner ? api('GET', '/api/admin/members') : Promise.resolve([]), api('GET', '/api/products')]);
  c.innerHTML = `<div class="grid g2">
    <div class="panel"><h2>Organização</h2><dl class="kv small"><dt>Nome</dt><dd>${esc(me.organization.name)}</dd><dt>Fuso</dt><dd>${esc(me.organization.timezone)}</dd><dt>Ambiente</dt><dd>${esc(me.environment)}</dd><dt>Provedor de IA</dt><dd>${esc(me.ai_provider)}</dd><dt>Seu papel</dt><dd>${esc(me.role)}</dd></dl>
      ${me.permissions.includes('pause') ? `<div class="row" style="margin-top:14px"><button class="btn ${me.organization.executions_paused ? 'ok' : 'danger'}" id="pause">${me.organization.executions_paused ? 'Retomar execuções' : 'Pausar novas execuções e ações'}</button></div><p class="small muted">Interruptor de emergência: impede novas análises e ações; execuções em andamento são canceladas no próximo ponto de controle.</p>` : ''}</div>
    <div class="panel"><h2>Minha senha</h2><form id="pw" class="grid"><label class="field">Senha atual<input type="password" name="current_password" required autocomplete="current-password"></label><label class="field">Nova senha<input type="password" name="new_password" required minlength="10" autocomplete="new-password"></label><button class="btn">Alterar senha</button></form></div></div>
    <div class="panel wa-panel" id="wa-card"></div>
    ${isOwner ? `<div class="panel"><h2>Membros</h2><div class="table-wrap"><table><thead><tr><th>Usuário</th><th>Papel</th><th>Produtos</th><th>Status</th><th></th></tr></thead><tbody>${members.map((m) => `<tr><td><b>${esc(m.display_name)}</b><div class="small muted">${esc(m.email)}</div></td>
      <td><select data-role="${m.id}" ${m.email === me.user.email ? 'disabled' : ''}>${['owner', 'manager', 'analyst', 'viewer'].map((r) => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
      <td><div class="chips">${products.map((p) => `<label class="chip ${m.products.includes(p.code) ? 'on' : ''}"><input type="checkbox" data-mp="${m.id}" value="${p.code}" ${m.products.includes(p.code) ? 'checked' : ''} ${m.email === me.user.email ? 'disabled' : ''}>${esc(p.code)}</label>`).join('')}</div></td>
      <td>${esc(m.status)}</td><td>${m.email === me.user.email ? '<span class="small muted">você</span>' : `<button class="btn sm" data-msave="${m.id}">Salvar</button> <button class="btn sm ${m.status === 'active' ? 'danger' : 'ok'}" data-mst="${m.id}" data-v="${m.status === 'active' ? 'disabled' : 'active'}">${m.status === 'active' ? 'Desativar' : 'Reativar'}</button>`}</td></tr>`).join('')}</tbody></table></div></div>
    <div class="panel"><h2>Convidar membro</h2><form id="mf" class="grid g2"><label class="field">Nome<input name="name" required></label><label class="field">E-mail<input name="email" type="email" required></label>
      <label class="field">Papel<select name="role"><option value="analyst">analyst — consulta e elabora perguntas</option><option value="manager">manager — revisa e aprova ações delegadas</option><option value="viewer">viewer — consulta relatórios</option><option value="owner">owner — administra</option></select></label>
      <div class="field">Produtos autorizados<div class="chips">${products.map((p) => `<label class="chip"><input type="checkbox" name="prod" value="${p.code}">${esc(p.code)}</label>`).join('')}</div></div>
      <div class="span2"><button class="btn primary">Adicionar</button></div></form><div id="mres"></div></div>` : ''}`;
  bindChips(c);
  renderWaCard($('#wa-card', c));
  $('#pause', c)?.addEventListener('click', async () => { try { const r = await api('POST', '/api/admin/pause', { paused: !me.organization.executions_paused }); state.me = await api('GET', '/api/auth/me'); toast(r.paused ? 'Execuções pausadas.' : 'Execuções retomadas.'); renderShell(); } catch (e) { fail(e); } });
  $('#pw', c).onsubmit = async (e) => { e.preventDefault(); try { await api('POST', '/api/auth/change-password', { current_password: e.target.current_password.value, new_password: e.target.new_password.value }); toast('Senha alterada. Outras sessões foram encerradas.'); e.target.reset(); } catch (err) { fail(err); } };
  $$('[data-msave]', c).forEach((b) => { b.onclick = async () => { const id = b.dataset.msave; try { await api('PUT', `/api/admin/members/${id}`, { role: $(`[data-role="${id}"]`, c).value, products: $$(`[data-mp="${id}"]:checked`, c).map((x) => x.value) }); toast('Membro atualizado.'); route(); } catch (e) { fail(e); } }; });
  $$('[data-mst]', c).forEach((b) => { b.onclick = async () => { try { await api('PUT', `/api/admin/members/${b.dataset.mst}`, { status: b.dataset.v }); route(); } catch (e) { fail(e); } }; });
  const mf = $('#mf', c);
  if (mf) mf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api('POST', '/api/admin/members', { name: mf.name.value, email: mf.email.value, role: mf.role.value, products: $$('input[name=prod]:checked', mf).map((x) => x.value) });
      $('#mres', c).innerHTML = `<div class="alert ${r.temporary_password ? 'warn' : ''}" style="margin-top:12px">${r.temporary_password ? `Senha temporária: <b class="mono">${esc(r.temporary_password)}</b><br>` : ''}${esc(r.note)}</div>`;
      setTimeout(route, r.temporary_password ? 20000 : 1500);
    } catch (err) { fail(err); }
  };
}

async function renderWaCard(el) {
  let w;
  try { w = await api('GET', '/api/whatsapp/me'); } catch (e) { el.innerHTML = `<h2>WhatsApp para aprovações</h2><p class="muted">${esc(e.message)}</p>`; return; }
  const l = w.link;
  el.innerHTML = `<div class="row" style="justify-content:space-between"><h2>WhatsApp para aprovações</h2>${l?.status === 'verified' ? '<span class="st good">Vinculado</span>' : '<span class="st wait">Não vinculado</span>'}</div>
    ${!w.configured ? '<p class="muted">O WhatsApp ainda não foi configurado no servidor (owner: veja docs/WHATSAPP.md).</p>' : `
    ${l?.status === 'verified' ? `<dl class="kv small"><dt>Número</dt><dd class="mono">${esc(l.number)}</dd><dt>PIN</dt><dd>${l.has_pin ? '<span class="badge ok">cadastrado</span>' : '<span class="badge warn">não cadastrado — necessário para aprovar</span>'}</dd><dt>Notificações</dt><dd>${l.notify ? 'ativas' : 'pausadas'}</dd></dl>` : '<p class="muted small">Clique em “Vincular meu WhatsApp”, envie a mensagem indicada do seu celular para o número da LORLER e pronto.</p>'}
    <div id="wa-code"></div>
    <div class="row" style="margin-top:10px">
      <button class="btn primary sm" id="wa-link">${l?.status === 'verified' ? 'Trocar número' : 'Vincular meu WhatsApp'}</button>
      ${l?.status === 'verified' ? `<button class="btn sm" id="wa-test">Enviar teste</button><button class="btn sm" id="wa-notify">${l.notify ? 'Pausar avisos' : 'Ativar avisos'}</button><button class="btn sm danger" id="wa-off">Desvincular</button>` : ''}
    </div>
    ${l?.status === 'verified' && w.can_approve ? `<form id="wa-pin" class="row" style="margin-top:12px"><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4,8}" maxlength="8" placeholder="PIN de 4 a 8 dígitos" style="max-width:220px" required autocomplete="new-password"><button class="btn sm ok">${l.has_pin ? 'Trocar PIN' : 'Cadastrar PIN'}</button></form><p class="small muted">O PIN confirma aprovações feitas pelo WhatsApp. Três erros bloqueiam por 15 minutos.</p>` : ''}
    ${w.recent.length ? `<h3 style="margin-top:12px">Pedidos recentes</h3>${w.recent.map((r) => `<div class="small"><span class="mono">${esc(r.code)}</span> · ${esc(r.summary)} · ${esc(r.status)}${r.send_error ? ` <span class="unsupported">${esc(r.send_error)}</span>` : ''}</div>`).join('')}` : ''}`}`;
  $('#wa-link', el)?.addEventListener('click', async () => {
    try { const r = await api('POST', '/api/whatsapp/link', {}); $('#wa-code', el).innerHTML = `<div class="alert warn" style="margin-top:10px">Envie do seu WhatsApp a mensagem <b class="mono">${esc(r.message)}</b> para ${r.business_number ? `<a href="https://wa.me/${esc(r.business_number)}?text=${encodeURIComponent(r.message)}" target="_blank" rel="noopener">+${esc(r.business_number)}</a>` : 'o número da LORLER'} (válido por ${r.expires_in_minutes} min). Depois atualize esta tela.</div>`; } catch (e) { fail(e); }
  });
  $('#wa-test', el)?.addEventListener('click', async () => { try { await api('POST', '/api/whatsapp/test', {}); toast('Mensagem de teste enviada.'); } catch (e) { fail(e); } });
  $('#wa-notify', el)?.addEventListener('click', async () => { try { await api('POST', '/api/whatsapp/notify', { enabled: !l.notify }); renderWaCard(el); } catch (e) { fail(e); } });
  $('#wa-off', el)?.addEventListener('click', async () => { try { await api('POST', '/api/whatsapp/unlink', {}); renderWaCard(el); } catch (e) { fail(e); } });
  $('#wa-pin', el)?.addEventListener('submit', async (e) => { e.preventDefault(); try { await api('POST', '/api/whatsapp/pin', { pin: e.target.pin.value }); toast('PIN cadastrado.'); renderWaCard(el); } catch (err) { fail(err); } });
}

// ---------------- Assistente: avatar flutuante + conversa por texto/voz ----------------
let dockAvatar = null;
function mountDock() {
  const dock = $('#dock'); if (!dock || !state.me) return;
  const s = state.assistant.settings;
  dock.innerHTML = `<div class="dock-panel hidden" id="dock-panel" role="dialog" aria-label="Conversa com ${esc(s.name)}">
      <header><div class="dock-who"><b>${esc(s.name)}</b><small id="dock-state">online</small></div>
        <button class="btn icon sm ghost" id="dock-voice" title="Respostas faladas">${svg(voice.enabled ? 'speaker' : 'mute')}</button>
        <button class="btn icon sm ghost" id="dock-close" title="Fechar">${svg('close')}</button></header>
      <div class="dock-msgs" id="dock-msgs"></div>
      <form class="dock-form" id="dock-form"><input name="m" placeholder="Fale com ${esc(s.name)}…" autocomplete="off" maxlength="600">
        <button type="button" class="btn icon" id="dock-mic" title="Falar">${svg('mic')}</button><button class="btn icon primary" title="Enviar">${svg('send')}</button></form>
    </div>
    <button class="dock-btn" id="dock-btn" title="Conversar com ${esc(s.name)}"><span class="dock-av"></span><span class="dock-dot"></span></button>`;
  dockAvatar?.destroy();
  dockAvatar = createAvatar($('.dock-av', dock), s, { size: 72, label: false });
  if (voice.dockSub) voice.subs.delete(voice.dockSub);
  voice.dockSub = (ev) => {
    if (!dockAvatar) return;
    if ('speaking' in ev) dockAvatar.setSpeaking(ev.speaking);
    if ('listening' in ev) dockAvatar.setListening(ev.listening);
    if (ev.level != null) dockAvatar.setLevel(ev.level);
    if (ev.word) dockAvatar.pulse();
    const stt = $('#dock-state'); if (stt) stt.textContent = ev.speaking ? 'falando…' : ev.listening ? 'ouvindo…' : 'online';
  };
  voice.subs.add(voice.dockSub);
  const panel = $('#dock-panel', dock); const msgs = $('#dock-msgs', dock); const form = $('#dock-form', dock);
  const render = () => {
    if (!state.chat.length) {
      const h = new Date().getHours();
      msgs.innerHTML = `<div class="dmsg bot">${h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'}, ${esc(s.call_me || state.me.user.name.split(' ')[0])}! Sou ${esc(s.name)}. Pode me perguntar dos números, das aprovações ou pedir uma análise.</div>`;
      return;
    }
    msgs.innerHTML = state.chat.map((m) => `<div class="dmsg ${m.role === 'user' ? 'me' : 'bot'}">${esc(m.text)}${m.action ? `<div class="row" style="margin-top:6px">${m.action}</div>` : ''}</div>`).join('');
    msgs.scrollTop = msgs.scrollHeight;
  };
  const open = (on = true) => { panel.classList.toggle('hidden', !on); dock.classList.toggle('open', on); if (on) { render(); setTimeout(() => form.m.focus(), 50); } };
  $('#dock-btn', dock).onclick = () => open(panel.classList.contains('hidden'));
  $('#dock-close', dock).onclick = () => open(false);
  $('#dock-voice', dock).onclick = (e) => { const on = voice.toggle(); e.currentTarget.innerHTML = svg(on ? 'speaker' : 'mute'); const vt = $('#vtoggle'); if (vt) vt.innerHTML = svg(on ? 'speaker' : 'mute'); };
  const typing = (on) => { dockAvatar?.setThinking(on); $('#dock-msgs .typing')?.remove(); if (on) { msgs.insertAdjacentHTML('beforeend', '<div class="dmsg bot typing"><i></i><i></i><i></i></div>'); msgs.scrollTop = msgs.scrollHeight; } };
  const send = async (text, { confirm = null } = {}) => {
    if (!confirm) state.chat.push({ role: 'user', text });
    render(); typing(true);
    try {
      const history = state.chat.slice(-9, -1).map((m) => ({ role: m.role, text: m.text }));
      const r = await api('POST', '/api/conversation', confirm ? { confirm_analysis: confirm, channel: 'text' } : { message: text, history, channel: 'text' });
      typing(false);
      const msg = { role: 'assistant', text: r.reply };
      if (r.intent === 'propose_analysis' && r.analysis_question) { state.chatPending = r.analysis_question; msg.action = '<button class="btn sm ok" data-dock="yes">Sim, abrir análise</button><button class="btn sm ghost" data-dock="no">Agora não</button>'; }
      if ((r.intent === 'navigate' || r.intent === 'navigate_offer') && r.navigate_to) msg.action = `<a class="btn sm" href="#/${esc(r.navigate_to)}">Abrir</a>`;
      if (r.decision_id) msg.action = `<a class="btn sm" href="#/decisao/${esc(r.decision_id)}">Acompanhar análise</a>`;
      state.chat.push(msg); state.chat = state.chat.slice(-30);
      render();
      voice.speak(r.reply);
      if (r.intent === 'navigate' && r.navigate_to) location.hash = `#/${r.navigate_to}`;
    } catch (e) { typing(false); state.chat.push({ role: 'assistant', text: `Não consegui responder agora: ${e.message}` }); render(); }
  };
  msgs.onclick = (e) => {
    const b = e.target.closest('[data-dock]'); if (!b) return;
    const q = state.chatPending; state.chatPending = null;
    $$('[data-dock]', msgs).forEach((x) => x.closest('.row')?.remove());
    state.chat.forEach((m) => { if (m.action?.includes('data-dock')) delete m.action; });
    if (b.dataset.dock === 'yes' && q) { state.chat.push({ role: 'user', text: 'Sim, pode abrir.' }); send(null, { confirm: q }); } else { state.chat.push({ role: 'user', text: 'Agora não.' }, { role: 'assistant', text: 'Tranquilo. Se mudar de ideia é só falar.' }); render(); }
  };
  form.onsubmit = (e) => {
    e.preventDefault(); const t = form.m.value.trim(); if (!t) return; form.m.value = '';
    if (state.chatPending && /^(sim|pode|abre|abrir|confirmo|ok|isso|claro|bora|manda)/i.test(t) && t.length < 30) { const q = state.chatPending; state.chatPending = null; state.chat.push({ role: 'user', text: t }); state.chat.forEach((m) => { if (m.action?.includes('data-dock')) delete m.action; }); return send(null, { confirm: q }); }
    state.chatPending = null; send(t);
  };
  $('#dock-mic', dock).onclick = (e) => {
    if (!voice.enabled) { voice.toggle(); $('#dock-voice', dock).innerHTML = svg('speaker'); }
    voice.stop();
    voice.listen((t, final) => { form.m.value = t; if (final && t.trim()) form.requestSubmit(); }, e.currentTarget);
  };
}

// ---------------- Tela: Assistente (nome, personalidade, avatar e voz) ----------------
const TONE_LABEL = { executivo: 'Executivo — cordial e direto', amigavel: 'Amigável — caloroso e próximo', descontraido: 'Descontraído — leve e bem-humorado', formal: 'Formal — corporativo' };
const STYLE_LABEL = { nucleo: 'Núcleo de energia', rosto: 'Rosto digital', holograma: 'Holograma', onda: 'Ondas de voz' };
const VOICE_LABEL = { alloy: 'Alloy (neutra)', ash: 'Ash (masculina)', ballad: 'Ballad (suave)', coral: 'Coral (feminina, calorosa)', echo: 'Echo (masculina)', fable: 'Fable (expressiva)', nova: 'Nova (feminina, jovem)', onyx: 'Onyx (masculina, grave)', sage: 'Sage (calma)', shimmer: 'Shimmer (feminina, clara)', verse: 'Verse (versátil)' };

function resizeImage(file, max = 256) {
  return new Promise((resolve, reject) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(url);
      resolve(cv.toDataURL('image/webp', 0.85).startsWith('data:image/webp') ? cv.toDataURL('image/webp', 0.85) : cv.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagem inválida.')); };
    img.src = url;
  });
}

async function viewAssistant(c) {
  const a = await loadAssistant();
  const s = structuredClone(a.settings);
  const ro = !a.can_edit;
  const dis = ro ? 'disabled' : '';
  c.innerHTML = `<div class="grid g3 assistant-page">
    <div class="panel av-preview">
      <h2>Prévia</h2>
      <div id="av-stage" class="av-stage"></div>
      <p class="small muted" id="av-sample-txt" style="text-align:center"></p>
      <div class="row" style="justify-content:center"><button class="btn primary" id="av-test">${svg('speaker')} Ouvir exemplo</button></div>
      <p class="small muted" style="margin-top:12px">A personalidade muda o jeito de falar — nunca as regras: aprovações continuam exigindo senha (painel) ou PIN (WhatsApp).</p>
    </div>
    <form class="panel span2" id="av-form">
      <h2>Identidade e personalidade</h2>
      ${ro ? '<div class="alert warn">Somente o responsável (owner) pode alterar. Você está vendo as configurações atuais.</div>' : ''}
      <div class="grid g2">
        <label class="field">Nome do assistente<input name="name" maxlength="30" value="${esc(s.name)}" ${dis} placeholder="Ex.: Sofia, Atlas, Jarvis"></label>
        <label class="field">Como ele chama você<input name="call_me" maxlength="40" value="${esc(s.call_me)}" ${dis} placeholder="${esc(state.me.user.name.split(' ')[0])}"></label>
      </div>
      <label class="field" style="margin-top:12px">Jeito de falar<select name="tone" ${dis}>${a.options.tones.map((t) => `<option value="${t}" ${s.tone === t ? 'selected' : ''}>${esc(TONE_LABEL[t] || t)}</option>`).join('')}</select></label>
      <label class="field" style="margin-top:12px">Detalhes de estilo (opcional)<textarea name="persona_notes" maxlength="400" ${dis} placeholder="Ex.: fala de forma bem objetiva, usa exemplos do dia a dia de salão de beleza, gosta de resumir com um número-chave.">${esc(s.persona_notes)}</textarea></label>

      <h2 style="margin-top:20px">Avatar</h2>
      <div class="av-styles">${a.options.avatar_styles.map((k) => `<label class="av-style ${s.avatar.style === k ? 'on' : ''}"><input type="radio" name="style" value="${k}" ${s.avatar.style === k ? 'checked' : ''} ${dis}><span class="av-mini" data-mini="${k}"></span><b>${esc(STYLE_LABEL[k] || k)}</b></label>`).join('')}</div>
      <div class="row" style="margin-top:12px">
        <label class="field">Cor principal<input type="color" name="color" value="${esc(s.avatar.color)}" ${dis}></label>
        <label class="field">Cor de destaque<input type="color" name="color2" value="${esc(s.avatar.color2)}" ${dis}></label>
        <label class="field">Foto (opcional)<input type="file" name="photo" accept="image/png,image/jpeg,image/webp" ${dis}></label>
        ${s.avatar.image ? `<button type="button" class="btn sm ghost" id="av-nophoto" ${dis}>Remover foto</button>` : ''}
      </div>

      <h2 style="margin-top:20px">Voz</h2>
      <div class="row">
        <label class="chip ${s.voice.engine === 'browser' ? 'on' : ''}"><input type="radio" name="engine" value="browser" ${s.voice.engine === 'browser' ? 'checked' : ''} ${dis}>Voz do aparelho (grátis)</label>
        <label class="chip ${s.voice.engine === 'openai' ? 'on' : ''}" title="${a.tts_available ? '' : 'Precisa da chave da OpenAI configurada no servidor'}"><input type="radio" name="engine" value="openai" ${s.voice.engine === 'openai' ? 'checked' : ''} ${dis || (a.tts_available ? '' : 'disabled')}>Voz neural realista${a.tts_available ? '' : ' (indisponível)'}</label>
      </div>
      <div class="grid g2" style="margin-top:12px">
        <label class="field" id="f-bvoice">Voz do aparelho<select name="browser_voice" ${dis}><option value="">Automática (melhor voz em português)</option></select><span class="small muted" style="text-transform:none;letter-spacing:0">As vozes disponíveis mudam de aparelho para aparelho; se a escolhida não existir, usa a melhor em português.</span></label>
        <label class="field" id="f-ovoice">Voz neural<select name="openai_voice" ${dis}>${a.options.openai_voices.map((v) => `<option value="${v}" ${s.voice.openai_voice === v ? 'selected' : ''}>${esc(VOICE_LABEL[v] || v)}</option>`).join('')}</select></label>
        <label class="field">Velocidade <span class="mono" id="v-rate">${s.voice.rate.toFixed(2)}×</span><input type="range" name="rate" min="0.6" max="1.6" step="0.05" value="${s.voice.rate}" ${dis}></label>
        <label class="field" id="f-pitch">Tom (voz do aparelho) <span class="mono" id="v-pitch">${s.voice.pitch.toFixed(2)}</span><input type="range" name="pitch" min="0.5" max="1.5" step="0.05" value="${s.voice.pitch}" ${dis}></label>
      </div>

      <h2 style="margin-top:20px">WhatsApp</h2>
      <label class="chip ${s.whatsapp_chat ? 'on' : ''}"><input type="checkbox" name="whatsapp_chat" ${s.whatsapp_chat ? 'checked' : ''} ${dis}>Conversar pelo WhatsApp como uma pessoa da equipe</label>
      <p class="small muted">Com isso ligado, qualquer mensagem no número vinculado vira conversa natural (com memória das últimas 24 h). Os comandos continuam valendo: PENDENTES, VER, APROVAR (com PIN), REJEITAR, REVISAR e AJUDA. Ele avisa por lá quando uma análise pedida na conversa termina.</p>
      ${ro ? '' : '<div class="row" style="margin-top:16px"><button class="btn primary">Salvar</button><span class="small muted" id="av-saved"></span></div>'}
    </form>
  </div>`;
  const stage = $('#av-stage', c);
  const av = createAvatar(stage, s, { size: 220 });
  const minis = $$('[data-mini]', c).map((el) => createAvatar(el, { ...s, avatar: { ...s.avatar, style: el.dataset.mini, image: '' } }, { size: 64, label: false }));
  const sub = (ev) => { if ('speaking' in ev) av.setSpeaking(ev.speaking); if (ev.level != null) av.setLevel(ev.level); if (ev.word) av.pulse(); if ('listening' in ev) av.setListening(ev.listening); };
  voice.subs.add(sub);
  state.cleanup.push(() => { voice.subs.delete(sub); av.destroy(); minis.forEach((m) => m.destroy()); });
  const f = $('#av-form', c);
  const fillVoices = () => {
    const sel = f.browser_voice; const all = (voice.synth?.getVoices() || []).filter((v) => /^pt/i.test(v.lang));
    const others = (voice.synth?.getVoices() || []).filter((v) => !/^pt/i.test(v.lang));
    sel.innerHTML = '<option value="">Automática (melhor voz em português)</option>' + [...all, ...others].map((v) => `<option value="${esc(v.name)}" ${s.voice.browser_voice === v.name ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
  };
  fillVoices();
  if (voice.synth) { voice.synth.onvoiceschanged = fillVoices; state.cleanup.push(() => { voice.synth.onvoiceschanged = null; }); }
  const sample = () => `Oi, ${s.call_me || state.me.user.name.split(' ')[0]}! Eu sou ${s.name || 'o Cérebro'}. Já olhei os quatro sistemas hoje e está tudo sob controle. Quer que eu te conte o que mudou?`;
  const read = () => {
    s.name = f.name.value.trim() || 'Cérebro'; s.call_me = f.call_me.value.trim(); s.tone = f.tone.value; s.persona_notes = f.persona_notes.value;
    s.avatar.style = f.querySelector('input[name=style]:checked')?.value || s.avatar.style; s.avatar.color = f.color.value; s.avatar.color2 = f.color2.value;
    s.voice.engine = f.querySelector('input[name=engine]:checked')?.value || 'browser'; s.voice.browser_voice = f.browser_voice.value; s.voice.openai_voice = f.openai_voice.value;
    s.voice.rate = Number(f.rate.value); s.voice.pitch = Number(f.pitch.value); s.whatsapp_chat = f.whatsapp_chat.checked;
    $('#v-rate', c).textContent = `${s.voice.rate.toFixed(2)}×`; $('#v-pitch', c).textContent = s.voice.pitch.toFixed(2);
    $('#f-bvoice', c).style.display = s.voice.engine === 'browser' ? '' : 'none'; $('#f-pitch', c).style.display = s.voice.engine === 'browser' ? '' : 'none';
    $('#f-ovoice', c).style.display = s.voice.engine === 'openai' ? '' : 'none';
    $$('.av-style', c).forEach((l) => l.classList.toggle('on', l.querySelector('input').checked));
    $$('.chip', c).forEach((l) => { const i = l.querySelector('input'); if (i) l.classList.toggle('on', i.checked); });
    av.update(s); minis.forEach((m, i) => m.update({ ...s, avatar: { ...s.avatar, style: a.options.avatar_styles[i], image: '' } }));
    $('#av-sample-txt', c).textContent = `“${sample()}”`;
  };
  read();
  f.oninput = read; f.onchange = read;
  f.photo.onchange = async () => { const file = f.photo.files[0]; if (!file) return; try { s.avatar.image = await resizeImage(file); av.update(s); } catch (e) { fail(e); } };
  $('#av-nophoto', c)?.addEventListener('click', () => { s.avatar.image = ''; av.update(s); });
  $('#av-test', c).onclick = () => {
    const prev = state.assistant.settings; state.assistant.settings = s; // testa com o que está na tela, mesmo sem salvar
    voice.speak(sample(), { force: true });
    setTimeout(() => { if (state.assistant.settings === s && prev !== s) state.assistant.settings = prev; }, 200);
  };
  f.onsubmit = async (e) => {
    e.preventDefault(); read();
    try {
      const r = await api('PUT', '/api/assistant', { name: s.name, call_me: s.call_me, tone: s.tone, persona_notes: s.persona_notes, avatar: s.avatar, voice: s.voice, whatsapp_chat: s.whatsapp_chat });
      state.assistant.settings = r.settings; toast(`${r.settings.name} atualizado.`); mountDock();
      const sv = $('#av-saved', c); if (sv) sv.textContent = 'Salvo agora.';
    } catch (err) { fail(err); }
  };
}

if ('speechSynthesis' in window) window.speechSynthesis.onvoiceschanged = () => {};
init();
