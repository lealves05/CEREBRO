// Voz local do JARVIS: ouvidos (Whisper) e boca (Kokoro) rodando na própria VPS, com API no formato da OpenAI.
//   LORLER_STT_URL        ex.: http://127.0.0.1:8000  (speaches / faster-whisper)   → /v1/audio/transcriptions
//   LORLER_STT_MODEL      ex.: Systran/faster-whisper-small
//   LORLER_TTS_LOCAL_URL  ex.: http://127.0.0.1:8880  (Kokoro-FastAPI)              → /v1/audio/speech
// O áudio e o texto não saem do servidor. Sem as variáveis, o Cérebro usa a voz do navegador (como antes).
// Instalação na VPS: deploy/voz-local/instalar-voz-local.sh (VPS-MENU › I).
import { clampText } from '../lib/util.js';

const base = (v) => String(v || '').trim().replace(/\/+$/, '');
export const sttUrl = () => base(process.env.LORLER_STT_URL);
export const ttsUrl = () => base(process.env.LORLER_TTS_LOCAL_URL);
export const sttModel = () => process.env.LORLER_STT_MODEL || 'Systran/faster-whisper-small';
export const sttConfigured = () => !!sttUrl();
export const ttsConfigured = () => !!ttsUrl();
export const hooks = { fetch: (...a) => fetch(...a) };

export class VoiceError extends Error {}

const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/aac': 'aac', 'audio/amr': 'amr' };

/** Áudio → texto (português). buffer: Buffer; mime: tipo do áudio. */
export async function transcribe(buffer, mime = 'audio/webm', { timeoutMs = 45000 } = {}) {
  if (!sttConfigured()) throw new VoiceError('Reconhecimento de voz local não instalado (LORLER_STT_URL).');
  if (!buffer?.length) throw new VoiceError('Áudio vazio.');
  const type = String(mime || 'audio/webm').split(';')[0].trim().toLowerCase();
  const fd = new FormData();
  fd.append('file', new Blob([buffer], { type }), `fala.${EXT[type] || 'webm'}`);
  fd.append('model', sttModel());
  fd.append('language', 'pt');
  fd.append('response_format', 'json');
  fd.append('temperature', '0');
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await hooks.fetch(`${sttUrl()}/v1/audio/transcriptions`, { method: 'POST', body: fd, signal: ac.signal });
    if (!r.ok) throw new VoiceError(`Whisper respondeu ${r.status}.`);
    const d = await r.json().catch(() => ({}));
    return clampText(String(d.text || '').replace(/\s+/g, ' ').trim(), 2000);
  } catch (e) {
    if (e instanceof VoiceError) throw e;
    throw new VoiceError(e.name === 'AbortError' ? 'O reconhecimento de voz demorou demais.' : 'Não consegui falar com o reconhecimento de voz local.');
  } finally { clearTimeout(timer); }
}

/** Texto → áudio na voz local (Kokoro). format: mp3 (painel) | opus (nota de voz do WhatsApp). */
export async function synthesize(text, { voice = 'pf_dora', speed = 1, format = 'mp3', timeoutMs = 30000 } = {}) {
  if (!ttsConfigured()) throw new VoiceError('Voz local não instalada (LORLER_TTS_LOCAL_URL).');
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await hooks.fetch(`${ttsUrl()}/v1/audio/speech`, {
      method: 'POST', signal: ac.signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'kokoro', voice, input: clampText(String(text), 4000), speed: Math.min(1.5, Math.max(0.7, Number(speed) || 1)), response_format: format, lang_code: 'p' }),
    });
    if (!r.ok) throw new VoiceError(`Kokoro respondeu ${r.status}.`);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    if (e instanceof VoiceError) throw e;
    throw new VoiceError(e.name === 'AbortError' ? 'A voz local demorou demais.' : 'Não consegui falar com a voz local.');
  } finally { clearTimeout(timer); }
}

/** Situação para o HUD (só presença das variáveis; o teste de verdade é /api/jarvis/voz/teste). */
export function status() {
  return { stt_local: sttConfigured(), tts_local: ttsConfigured(), stt_model: sttConfigured() ? sttModel() : null };
}

export async function probe() {
  const out = { stt: null, tts: null };
  const ping = async (url) => { const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 4000); try { const r = await hooks.fetch(url, { signal: ac.signal }); return r.ok; } catch { return false; } finally { clearTimeout(t); } };
  if (sttConfigured()) out.stt = await ping(`${sttUrl()}/health`);
  if (ttsConfigured()) out.tts = await ping(`${ttsUrl()}/health`);
  return out;
}
