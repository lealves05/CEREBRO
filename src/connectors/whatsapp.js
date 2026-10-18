// WhatsApp Business Cloud API (Meta) — envio de mensagens e verificação do webhook.
// Documentação: https://developers.facebook.com/documentation/business-messaging/whatsapp
import crypto from 'node:crypto';
import { secret } from '../config.js';
import { safeEqual, clampText } from '../lib/util.js';

export const waHooks = { fetch: (...a) => fetch(...a) };

export const waConfig = () => ({
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
  token: secret('LORLER_SECRET_WHATSAPP_TOKEN'),
  appSecret: secret('LORLER_SECRET_WHATSAPP_APP_SECRET'),
  verifyToken: secret('LORLER_SECRET_WHATSAPP_VERIFY_TOKEN'),
  apiVersion: process.env.WHATSAPP_API_VERSION || 'v25.0',
  businessNumber: (process.env.WHATSAPP_BUSINESS_NUMBER || '').replace(/\D/g, ''),
  template: process.env.WHATSAPP_TEMPLATE_APPROVAL || '',
  templateLang: process.env.WHATSAPP_TEMPLATE_LANG || 'pt_BR',
});
export const isConfigured = () => { const c = waConfig(); return !!(c.phoneNumberId && c.token && c.appSecret && c.verifyToken); };

export class WhatsAppError extends Error { constructor(message, code) { super(message); this.code = code; } }

async function send(payload, { raw = false } = {}) {
  const c = waConfig();
  if (!isConfigured()) throw new WhatsAppError('WhatsApp não configurado no servidor.');
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 15000);
  try {
    const res = await waHooks.fetch(`https://graph.facebook.com/${c.apiVersion}/${c.phoneNumberId}/messages`, {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(raw ? { messaging_product: 'whatsapp', ...payload } : { messaging_product: 'whatsapp', recipient_type: 'individual', ...payload }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const code = data.error?.code;
      const hint = code === 131047 || code === 131026 ? ' (fora da janela de 24 h: configure um modelo aprovado em WHATSAPP_TEMPLATE_APPROVAL ou envie qualquer mensagem ao número da LORLER)' : '';
      throw new WhatsAppError(`WhatsApp: ${clampText(data.error?.message || `HTTP ${res.status}`, 200)}${hint}`, code);
    }
    return data.messages?.[0]?.id || null;
  } catch (e) {
    if (e instanceof WhatsAppError) throw e;
    throw new WhatsAppError(e.name === 'AbortError' ? 'Tempo limite ao enviar pelo WhatsApp.' : 'Falha de rede com o WhatsApp.');
  } finally { clearTimeout(timer); }
}

/** Marca a mensagem recebida como lida (tiques azuis) e mostra "digitando..." até a resposta (máx. ~25 s). */
export const markRead = (messageId, typing = true) => send({ status: 'read', message_id: messageId, ...(typing ? { typing_indicator: { type: 'text' } } : {}) }, { raw: true });

export const sendText = (to, body) => send({ to, type: 'text', text: { preview_url: false, body: clampText(body, 4000) } });

export const sendButtons = (to, body, buttons, footer) => send({
  to, type: 'interactive',
  interactive: {
    type: 'button',
    body: { text: clampText(body, 1024) },
    ...(footer ? { footer: { text: clampText(footer, 60) } } : {}),
    action: { buttons: buttons.slice(0, 3).map((b) => ({ type: 'reply', reply: { id: clampText(b.id, 256), title: clampText(b.title, 20) } })) },
  },
});

export const sendTemplate = (to, name, lang, params) => send({
  to, type: 'template',
  template: { name, language: { code: lang }, components: [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: clampText(String(t), 300) })) }] },
});

// X-Hub-Signature-256: "sha256=" + HMAC-SHA256(app secret, corpo bruto)
export function verifySignature(raw, header) {
  const c = waConfig();
  if (!c.appSecret || !header || !String(header).startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', c.appSecret).update(raw).digest('hex');
  return safeEqual(String(header).slice(7), expected);
}

// Extrai mensagens recebidas do payload do webhook (somente do número configurado)
export function extractMessages(body) {
  const c = waConfig(); const out = [];
  for (const entry of body?.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      if (c.phoneNumberId && v.metadata?.phone_number_id && v.metadata.phone_number_id !== c.phoneNumberId) continue;
      for (const m of v.messages || []) {
        let text = null; let buttonId = null;
        if (m.type === 'text') text = m.text?.body || '';
        else if (m.type === 'interactive') { buttonId = m.interactive?.button_reply?.id || m.interactive?.list_reply?.id || null; text = m.interactive?.button_reply?.title || ''; }
        else if (m.type === 'button') { buttonId = m.button?.payload || null; text = m.button?.text || ''; }
        out.push({ id: m.id, from: String(m.from || '').replace(/\D/g, ''), timestamp: m.timestamp, text: clampText(text || '', 1000), buttonId });
      }
    }
  }
  return out;
}

export const maskNumber = (n) => (n ? `+${String(n).slice(0, 4)}•••••${String(n).slice(-2)}` : '—');
