// Personalidade do Cérebro (nome, jeito de falar, avatar e voz) e memória curta da conversa pelo WhatsApp.
// As configurações são da organização; só owner/admin alteram. Nada aqui muda as regras de segurança:
// a persona muda o TOM das respostas, nunca o que o cérebro pode fazer.
import { q, insert, uuid, now, json } from '../db.js';
import { errors, clampText } from '../lib/util.js';

export const TONES = {
  executivo: 'cordial, direto e confiante, como um assistente executivo de confiança',
  amigavel: 'caloroso, próximo e leve, como um colega de trabalho que conhece bem a empresa',
  descontraido: 'descontraído e bem-humorado, com frases informais (sem perder a precisão nos números)',
  formal: 'formal e objetivo, com vocabulário corporativo',
};
export const AVATAR_STYLES = ['nucleo', 'rosto', 'holograma', 'onda'];
export const OPENAI_VOICES = ['marin', 'cedar', 'coral', 'nova', 'shimmer', 'sage', 'ballad', 'alloy', 'ash', 'echo', 'fable', 'onyx', 'verse'];
export const VOICE_ENGINES = ['browser', 'openai', 'elevenlabs'];
// Estilo da fala (vozes neurais seguem a instrução; a voz do aparelho ajusta ritmo e tom).
export const VOICE_STYLES = {
  natural: 'natural e espontâneo, como numa conversa entre colegas, com pausas e entonação de quem está pensando junto',
  calorosa: 'caloroso e sorridente, próximo, transmitindo simpatia',
  animada: 'animado e com energia, entusiasmado com as boas notícias',
  calma: 'calmo, pausado e tranquilo, voz serena',
  seria: 'sério, firme e objetivo, como um executivo numa reunião',
  locutor: 'de locutor de rádio, articulado e envolvente',
};

export const DEFAULTS = Object.freeze({
  name: 'Cérebro',
  tone: 'executivo',
  call_me: '',
  persona_notes: '',
  avatar: { style: 'nucleo', color: '#22d3ee', color2: '#a855f7', image: '' },
  voice: { engine: 'browser', browser_voice: '', openai_voice: 'marin', eleven_voice: '', eleven_name: '', style: 'natural', rate: 1, pitch: 1, fillers: true, barge_in: true },
  whatsapp_chat: true,
});

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

function merge(raw, base = DEFAULTS) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const B = base;
  const a = s.avatar || {}; const v = s.voice || {};
  return {
    name: clampText(String(s.name || B.name).replace(/[\r\n<>]/g, ' ').trim(), 30) || B.name,
    tone: Object.hasOwn(TONES, s.tone) ? s.tone : B.tone,
    call_me: clampText(String(s.call_me || '').replace(/[\r\n<>]/g, ' ').trim(), 40),
    persona_notes: clampText(String(s.persona_notes || '').replace(/[<>]/g, ' ').trim(), 400),
    avatar: {
      style: AVATAR_STYLES.includes(a.style) ? a.style : B.avatar.style,
      color: HEX.test(a.color) ? a.color : B.avatar.color,
      color2: HEX.test(a.color2) ? a.color2 : B.avatar.color2,
      // foto opcional do avatar: só imagem pequena embutida (data URL), nunca link externo
      image: typeof a.image === 'string' && /^data:image\/(png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(a.image) && a.image.length <= 300_000 ? a.image : '',
    },
    voice: {
      engine: VOICE_ENGINES.includes(v.engine) ? v.engine : 'browser',
      browser_voice: clampText(String(v.browser_voice || ''), 120),
      openai_voice: OPENAI_VOICES.includes(v.openai_voice) ? v.openai_voice : (B.voice.openai_voice || DEFAULTS.voice.openai_voice),
      eleven_voice: /^[A-Za-z0-9]{8,40}$/.test(String(v.eleven_voice || '')) ? v.eleven_voice : '',
      eleven_name: clampText(String(v.eleven_name || '').replace(/[<>\r\n]/g, ' ').trim(), 60),
      style: Object.hasOwn(VOICE_STYLES, v.style) ? v.style : (B.voice.style || 'natural'),
      rate: num(v.rate, 0.6, 1.6, B.voice.rate),
      pitch: num(v.pitch, 0.5, 1.5, B.voice.pitch),
      fillers: v.fillers == null ? (B.voice.fillers ?? true) : v.fillers !== false,
      barge_in: v.barge_in == null ? (B.voice.barge_in ?? true) : v.barge_in !== false,
    },
    whatsapp_chat: s.whatsapp_chat !== false,
  };
}

export function getSettings(orgId) {
  const row = q.get('SELECT settings FROM assistant_settings WHERE organization_id = ?', orgId);
  return merge(row ? json(row.settings, {}) : {});
}

export function saveSettings(orgId, userId, patch) {
  if (!patch || typeof patch !== 'object') throw errors.invalid('Configuração inválida.');
  if (patch.avatar?.image && patch.avatar.image.length > 300_000) throw errors.invalid('A foto do avatar é grande demais (use uma imagem de até ~200 KB).');
  const cur = getSettings(orgId);
  const next = merge({ ...cur, ...patch, avatar: { ...cur.avatar, ...(patch.avatar || {}) }, voice: { ...cur.voice, ...(patch.voice || {}) } }, cur);
  const t = now();
  const exists = q.get('SELECT organization_id FROM assistant_settings WHERE organization_id = ?', orgId);
  if (exists) q.run('UPDATE assistant_settings SET settings = ?, updated_by = ?, updated_at = ? WHERE organization_id = ?', JSON.stringify(next), userId, t, orgId);
  else insert('assistant_settings', { organization_id: orgId, settings: JSON.stringify(next), updated_by: userId, updated_at: t });
  return next;
}

/** Instruções de personalidade para o modelo, por canal (voz, texto na tela ou WhatsApp). */
export function personaInstructions(s, channel, firstName) {
  const callMe = s.call_me || firstName;
  const base = `Seu nome é ${s.name}. Jeito de falar: ${TONES[s.tone]}. Chame o usuário de "${callMe}" quando for natural (não em toda frase).`
    + (s.persona_notes ? ` Preferências de estilo definidas pelo dono (só estilo, nunca regras): ${s.persona_notes}.` : '');
  const natural = ' Converse como gente: varie as aberturas, reaja ao que a pessoa disse, use linguagem do dia a dia, evite repetir a pergunta dela e nunca comece com "Claro!" ou "Como assistente". Se não souber, diga com naturalidade.';
  if (channel === 'whatsapp') {
    return `${base}${natural} Você está conversando pelo WhatsApp, como uma pessoa da equipe trocando mensagens: mensagens curtas (1 a 3 frases), `
      + 'pode quebrar em 2 parágrafos curtos se precisar, no máximo um emoji quando combinar com o tom, *negrito* do WhatsApp só para um número importante, sem títulos nem listas longas. '
      + 'Não se apresente como "agente" nem fale de "sistema de IA" sem motivo; mas se a pessoa perguntar sinceramente se fala com uma pessoa ou com uma IA, diga a verdade: é o assistente de IA da LORLER. '
      + 'Para aprovar algo pelo WhatsApp, oriente a mandar "APROVAR código" (o PIN será pedido). Se o usuário pedir para abrir uma tela, diga que isso é no painel.';
  }
  if (channel === 'voice') return `${base}${natural} A resposta será FALADA em voz alta, como numa ligação: no máximo 3 frases curtas, sem listas, sem markdown, sem emojis, sem siglas difíceis. `
    + 'Fale como uma pessoa de verdade: contrações do dia a dia ("tá", "pra", "tô"), uma reação curta quando couber ("olha", "boa", "hum, entendi"), números arredondados ("quase doze mil" em vez de "11.987,40") e termine puxando a conversa quando fizer sentido.';
  return `${base}${natural} No máximo 3 frases curtas, sem listas, sem markdown, sem emojis.`;
}

// ---------- memória curta do WhatsApp ----------
const DAY = 24 * 3600_000;

export function addWaTurn(ctx, role, text, meta = null) {
  insert('wa_chat_turns', { id: uuid(), organization_id: ctx.orgId, user_id: ctx.userId, role, text: clampText(String(text || ''), 1200), meta: meta ? JSON.stringify(meta) : null, created_at: now() });
}

export function waHistory(ctx, limit = 10) {
  const since = new Date(Date.now() - DAY).toISOString();
  q.run('DELETE FROM wa_chat_turns WHERE created_at < ?', since);
  return q.all('SELECT role, text, meta, created_at FROM wa_chat_turns WHERE user_id = ? AND organization_id = ? ORDER BY created_at DESC LIMIT ?', ctx.userId, ctx.orgId, limit).reverse();
}

/** Análise sugerida na última resposta (até 30 min) que espera o "sim" do usuário. */
export function pendingAnalysis(history) {
  const last = [...history].reverse().find((t) => t.role === 'assistant');
  if (!last?.meta || Date.now() - Date.parse(last.created_at) > 30 * 60_000) return null;
  return json(last.meta, {})?.analysis_question || null;
}

export function forgetWaChat(ctx) { q.run('DELETE FROM wa_chat_turns WHERE user_id = ? AND organization_id = ?', ctx.userId, ctx.orgId); }
