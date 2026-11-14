// Aprovações pelo WhatsApp.
// Segurança: número verificado (o próprio usuário envia o código de vínculo pelo WhatsApp), código curto de uso único
// vinculado à proposta, versão e hash; aprovação exige PIN (fator equivalente à reautenticação do painel);
// a decisão passa pelas mesmas funções do painel (papel, versão, hash, prazo, política e executor).
import crypto from 'node:crypto';
import { q, insert, uuid, now, addMs, tx, json } from '../db.js';
import { errors, sha256, clampText } from '../lib/util.js';
import { audit } from './audit.js';
import { can } from '../auth/authz.js';
import * as wa from '../connectors/whatsapp.js';
import { approve, reject, requestRevision } from './actions.js';
import { getSettings, addWaTurn, waHistory, pendingAnalysis, forgetWaChat } from './assistant.js';
import { buildBriefing, briefingText, radarForCtx, sendBriefingTo } from './briefing.js';
import * as voiceLocal from './voice-local.js';
import * as mkt from './marketing.js';
import * as meeting from './meeting.js';
import * as support from './support-agent.js';

/** Ritmo "humano" das respostas da conversa (substituível nos testes). */
export const waChatHooks = { delay: (ms) => new Promise((r) => setTimeout(r, ms)) };

// resposta em áudio: ligada por padrão (Rotina › "responder áudio com áudio")
function wantsVoiceReply(ctx) { const r = q.get('SELECT voice_reply FROM jarvis_routine WHERE user_id = ?', ctx.userId); return !r || !!r.voice_reply; }
/** Texto para ser falado: sem emojis, sem *negrito*, sem links. */
function spokenText(t) {
  return String(t || '').replace(/https?:\/\/\S+/g, '').replace(/[*_~`]/g, '').replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 1500);
}

const CODE_ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const genCode = (n = 6) => Array.from(crypto.randomBytes(n), (b) => CODE_ALPHA[b % CODE_ALPHA.length]).join('');
const TOOL_LABEL = {
  create_internal_task: 'Criar tarefa interna', change_price_or_discount: 'Alterar preço ou desconto', publish_instagram_post: 'Publicar no Instagram',
  master_update_settings: 'Alterar parâmetros na Área Master', master_update_plan: 'Alterar plano na Área Master',
  master_update_product_params: 'Alterar parâmetros do sistema (Área Master)', master_extend_trial: 'Prorrogar teste de empresa (Área Master)',
};
const fmtMoney = (v) => (v == null ? '—' : Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const fmtDate = (s) => (s ? new Date(s).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '—');

// ---------- PIN ----------
function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
function checkPin(pin, stored) {
  try {
    const [, s, k] = String(stored).split('$');
    const key = Buffer.from(k, 'base64');
    return crypto.timingSafeEqual(key, crypto.scryptSync(String(pin), Buffer.from(s, 'base64'), key.length, { N: 16384, r: 8, p: 1 }));
  } catch { return false; }
}

// ---------- Painel ----------
export function myLink(ctx) {
  const l = q.get('SELECT * FROM whatsapp_links WHERE organization_id = ? AND user_id = ?', ctx.orgId, ctx.userId);
  const c = wa.waConfig();
  return {
    configured: wa.isConfigured(), business_number: c.businessNumber || null, template_configured: !!c.template,
    link: l ? { status: l.status, number: wa.maskNumber(l.wa_id), has_pin: !!l.pin_hash, notify: !!l.notify, verified_at: l.verified_at, pin_locked_until: l.pin_locked_until, briefing: !!l.briefing, briefing_time: l.briefing_time || '07:30', briefing_last: l.briefing_last || null } : null,
    briefing_template_configured: !!c.briefingTemplate,
  };
}

export function startLink(ctx) {
  if (!wa.isConfigured()) throw errors.invalid('WhatsApp ainda não configurado no servidor (veja docs/WHATSAPP.md).');
  const code = String(crypto.randomInt(100000, 999999));
  const ex = q.get('SELECT id FROM whatsapp_links WHERE organization_id = ? AND user_id = ?', ctx.orgId, ctx.userId);
  if (ex) q.run("UPDATE whatsapp_links SET link_code_hash = ?, link_code_expires_at = ?, status = CASE WHEN status = 'verified' THEN status ELSE 'pending' END WHERE id = ?", sha256(code), addMs(15 * 60_000), ex.id);
  else insert('whatsapp_links', { id: uuid(), organization_id: ctx.orgId, user_id: ctx.userId, wa_id: null, status: 'pending', link_code_hash: sha256(code), link_code_expires_at: addMs(15 * 60_000), pin_hash: null, pin_failed: 0, pin_locked_until: null, notify: 1, verified_at: null, created_at: now() });
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.link_started' });
  return { code, message: `LORLER ${code}`, business_number: wa.waConfig().businessNumber || null, expires_in_minutes: 15 };
}

export function setPin(ctx, pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) throw errors.invalid('O PIN deve ter de 4 a 8 dígitos.');
  if (/^(\d)\1+$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) throw errors.invalid('Escolha um PIN menos previsível.');
  const r = q.run('UPDATE whatsapp_links SET pin_hash = ?, pin_failed = 0, pin_locked_until = NULL WHERE organization_id = ? AND user_id = ?', hashPin(pin), ctx.orgId, ctx.userId);
  if (!r.changes) throw errors.invalid('Vincule seu número antes de cadastrar o PIN.');
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.pin_set' });
  return { ok: true };
}

export function setNotify(ctx, on) {
  q.run('UPDATE whatsapp_links SET notify = ? WHERE organization_id = ? AND user_id = ?', on ? 1 : 0, ctx.orgId, ctx.userId);
  return { ok: true };
}

export function setBriefing(ctx, { enabled, time }) {
  const t = time == null ? null : String(time);
  if (t != null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) throw errors.invalid('Horário inválido. Use HH:MM (ex.: 07:30).');
  const l = q.get("SELECT id FROM whatsapp_links WHERE organization_id = ? AND user_id = ? AND status = 'verified'", ctx.orgId, ctx.userId);
  if (!l) throw errors.invalid('Vincule seu número antes de ligar o briefing.');
  q.run('UPDATE whatsapp_links SET briefing = COALESCE(?, briefing), briefing_time = COALESCE(?, briefing_time) WHERE id = ?', enabled == null ? null : (enabled ? 1 : 0), t, l.id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.briefing_updated', metadata: { enabled: enabled ?? null, time: t } });
  return myLink(ctx);
}

export async function sendBriefingNow(ctx) {
  const l = q.get("SELECT * FROM whatsapp_links WHERE organization_id = ? AND user_id = ? AND status = 'verified'", ctx.orgId, ctx.userId);
  if (!l) throw errors.invalid('Número não vinculado.');
  try { await sendBriefingTo(l); } catch (e) { throw errors.invalid(e.message); }
  return { ok: true };
}

export function unlink(ctx) {
  q.run("UPDATE whatsapp_links SET status = 'disabled', wa_id = NULL, pin_hash = NULL WHERE organization_id = ? AND user_id = ?", ctx.orgId, ctx.userId);
  q.run("UPDATE whatsapp_requests SET status = 'expired' WHERE user_id = ? AND status IN ('sent','awaiting_pin')", ctx.userId);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.unlinked' });
  return { ok: true };
}

export async function sendTest(ctx) {
  const l = q.get("SELECT wa_id FROM whatsapp_links WHERE organization_id = ? AND user_id = ? AND status = 'verified'", ctx.orgId, ctx.userId);
  if (!l) throw errors.invalid('Número não vinculado.');
  try { await wa.sendText(l.wa_id, 'LORLER · Central de Decisões\nTeste de envio OK. Você receberá aqui os pedidos de aprovação. Envie AJUDA para ver os comandos.'); }
  catch (e) { throw errors.invalid(e.message); }
  return { ok: true };
}

// ---------- Notificação de aprovação ----------
function proposalText(p, d, code) {
  const pr = json(p.parameters, {});
  const prod = p.product_id ? q.get('SELECT code FROM products WHERE id = ?', p.product_id)?.code : null;
  const lines = [
    `*LORLER · Aprovação necessária*${d.is_demo ? ' (DEMONSTRAÇÃO)' : ''}`,
    `*${clampText(pr.title || p.summary, 120)}*`,
    `Ação: ${TOOL_LABEL[p.tool_code] || p.tool_code}${prod ? ` · ${prod}` : ''}`,
    `Destino: ${clampText(p.target, 120)}`,
  ];
  if (p.tool_code === 'publish_instagram_post') lines.push(`Legenda: ${clampText(pr.caption || '', 300)}${(pr.caption || '').length > 300 ? '…' : ''}`, pr.image_url ? 'Imagem: definida' : '⚠ Imagem ainda não definida — complete no painel');
  else if (p.tool_code?.startsWith('master_')) lines.push(`Mudança: ${clampText(masterDiff(pr), 400)}`);
  else if (pr.description) lines.push(clampText(pr.description, 300));
  if (Number(pr.max_amount) > 0) lines.push(`Valor máximo: ${fmtMoney(pr.max_amount)}`);
  lines.push(`Válida até: ${fmtDate(p.expires_at)} · v${p.version}`, '', `Código: *${code}*`, `Responda *APROVAR ${code}* (pede seu PIN), *REJEITAR ${code} motivo*, *REVISAR ${code} o que mudar* ou *VER ${code}*.`);
  return lines.join('\n');
}

export function masterDiff(pr) {
  const after = pr.values || pr.changes || (pr.days ? { prorrogar_dias: pr.days } : {});
  return Object.entries(after).map(([k, v]) => `${k}: ${JSON.stringify(pr.before?.[k] ?? '—')} → ${JSON.stringify(v)}`).join('; ') || '—';
}

export async function notifyApproval(proposalId) {
  if (!wa.isConfigured()) return { skipped: 'not_configured' };
  const p = q.get('SELECT * FROM action_proposals WHERE id = ?', proposalId);
  if (!p || p.status !== 'awaiting_approval') return { skipped: 'not_pending' };
  const d = q.get('SELECT * FROM decisions WHERE id = ?', p.decision_id);
  const ev = q.get("SELECT required_approvers FROM policy_evaluations WHERE action_proposal_id = ? AND stage = 'proposal' ORDER BY evaluated_at DESC LIMIT 1", p.id);
  const roles = json(ev?.required_approvers, ['owner']);
  const targets = q.all(`SELECT l.*, m.role FROM whatsapp_links l JOIN organization_members m ON m.user_id = l.user_id AND m.organization_id = l.organization_id
    WHERE l.organization_id = ? AND l.status = 'verified' AND l.notify = 1 AND m.status = 'active'`, p.organization_id).filter((t) => roles.includes(t.role));
  const sent = [];
  for (const t of targets) {
    // Pedidos anteriores da mesma decisão deixam de valer
    q.run(`UPDATE whatsapp_requests SET status = 'superseded' WHERE user_id = ? AND status IN ('sent','awaiting_pin') AND action_proposal_id IN (SELECT id FROM action_proposals WHERE decision_id = ?)`, t.user_id, p.decision_id);
    const code = genCode();
    const reqId = uuid();
    insert('whatsapp_requests', { id: reqId, organization_id: p.organization_id, action_proposal_id: p.id, proposal_version: p.version, payload_hash: p.payload_hash, user_id: t.user_id, code, status: 'sent', pending_until: null, wa_message_id: null, send_error: null, created_at: now(), decided_at: null });
    const body = proposalText(p, d, code);
    const c = wa.waConfig();
    let msgId = null; let err = null;
    try {
      if (c.template) {
        const pr = json(p.parameters, {});
        msgId = await wa.sendTemplate(t.wa_id, c.template, c.templateLang, [clampText(pr.title || p.summary, 120), TOOL_LABEL[p.tool_code] || p.tool_code, code]);
        try { await wa.sendButtons(t.wa_id, body, buttonsFor(code), 'Central de Decisões LORLER'); } catch { /* fora da janela: o modelo já avisou */ }
      } else {
        msgId = await wa.sendButtons(t.wa_id, body, buttonsFor(code), 'Central de Decisões LORLER');
      }
    } catch (e) { err = e.message; }
    q.run('UPDATE whatsapp_requests SET wa_message_id = ?, send_error = ?, status = ? WHERE id = ?', msgId, err, err ? 'failed' : 'sent', reqId);
    audit({ orgId: p.organization_id, actorType: 'system', actorId: 'whatsapp', event: err ? 'whatsapp.notify_failed' : 'whatsapp.notified', objectType: 'action_proposal', objectId: p.id, metadata: { to: wa.maskNumber(t.wa_id), error: err } });
    sent.push({ user_id: t.user_id, ok: !err, error: err });
  }
  return { sent };
}
const buttonsFor = (code) => [{ id: `aprovar:${code}`, title: 'Aprovar' }, { id: `rejeitar:${code}`, title: 'Rejeitar' }, { id: `ver:${code}`, title: 'Ver detalhes' }];

// Despacha a outbox (chamado pelo worker)
export async function processOutbox() {
  const evs = q.all("SELECT * FROM outbox_events WHERE status = 'pending' AND type = 'approval.requested' AND next_attempt_at <= ? ORDER BY created_at LIMIT 10", now());
  for (const e of evs) {
    try {
      const r = await notifyApproval(json(e.payload, {}).proposal_id);
      const failed = r.sent?.some((x) => !x.ok);
      if (failed && e.attempts < 3) q.run('UPDATE outbox_events SET attempts = attempts + 1, next_attempt_at = ? WHERE id = ?', addMs(5 * 60_000 * (e.attempts + 1)), e.id);
      else q.run("UPDATE outbox_events SET status = ?, attempts = attempts + 1 WHERE id = ?", failed ? 'failed' : 'sent', e.id);
    } catch (err) {
      q.run("UPDATE outbox_events SET attempts = attempts + 1, status = CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END, next_attempt_at = ? WHERE id = ?", addMs(10 * 60_000), e.id);
    }
  }
}

// ---------- Mensagens recebidas ----------
function ctxFor(link) {
  const m = q.get("SELECT * FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'", link.organization_id, link.user_id);
  if (!m) return null;
  const u = q.get('SELECT display_name, email FROM users WHERE id = ?', link.user_id);
  return { userId: link.user_id, orgId: link.organization_id, role: m.role, memberId: m.id, name: u?.display_name, email: u?.email, productIds: new Set(q.all('SELECT product_id FROM member_product_scopes WHERE member_id = ?', m.id).map((r) => r.product_id)) };
}

const HELP = 'Comandos LORLER:\n• *RESUMO* — briefing do dia\n• *RADAR* — situação de cada sistema\n• *PENDENTES* — aprovações aguardando você\n• *VER código* — detalhes completos\n• *APROVAR código* — aprovar (pede o PIN)\n• *REJEITAR código motivo*\n• *REVISAR código o que mudar*\n• *CANCELAR* — desiste da confirmação em andamento\n• *MARKETING* — posts agendados e o que espera aprovação\n• *REUNIÃO DE MARKETING* — monto o plano com você (posts, anúncio e ações)\n• Foto ou vídeo — eu coloco nos posts';

export async function handleInbound(msg, { reply = (to, t) => wa.sendText(to, t), defer = null } = {}) {
  // Deduplicação por id da mensagem (reentregas do webhook)
  try { insert('inbound_events', { id: uuid(), source: 'whatsapp', event_id: msg.id, received_at: now() }); } catch { return { duplicate: true }; }
  let text = String(msg.text || '').trim();
  const say = (t) => reply(msg.from, t).catch(() => {});

  // Vínculo do número: "LORLER 123456"
  const lm = /^lorler\s+(\d{6})$/i.exec(text);
  if (lm) {
    const link = q.get("SELECT * FROM whatsapp_links WHERE link_code_hash = ? AND link_code_expires_at > ? AND status IN ('pending','verified')", sha256(lm[1]), now());
    if (!link) { await say('Código de vínculo inválido ou expirado. Gere um novo no painel da Central de Decisões.'); return { linked: false }; }
    const other = q.get("SELECT id FROM whatsapp_links WHERE wa_id = ? AND status = 'verified' AND id <> ?", msg.from, link.id);
    if (other) q.run("UPDATE whatsapp_links SET status = 'disabled', wa_id = NULL WHERE id = ?", other.id);
    q.run("UPDATE whatsapp_links SET wa_id = ?, status = 'verified', verified_at = ?, link_code_hash = NULL, link_code_expires_at = NULL WHERE id = ?", msg.from, now(), link.id);
    audit({ orgId: link.organization_id, actorType: 'user', actorId: link.user_id, event: 'whatsapp.linked', metadata: { number: wa.maskNumber(msg.from) } });
    await say(`Número vinculado à Central de Decisões LORLER. ${link.pin_hash ? '' : 'Agora cadastre seu PIN no painel (Administração › WhatsApp) para poder aprovar por aqui.'}\n\n${HELP}`);
    return { linked: true };
  }

  const link = q.get("SELECT * FROM whatsapp_links WHERE wa_id = ? AND status = 'verified'", msg.from);
  if (!link) {
    // número público da LORLER: quem não é da equipe fala com o agente de suporte (só dúvidas técnicas dos sistemas)
    const sorg = support.activeOrg();
    if (!sorg) return { ignored: 'unknown_number' }; // agente desligado: números desconhecidos não recebem resposta
    const work = (async () => {
      let t = text;
      if (!t && msg.audio && voiceLocal.sttConfigured()) {
        try { const media = await (waChatHooks.download || wa.downloadMedia)(msg.audio.id); t = (await voiceLocal.transcribe(media.buffer, media.mime || msg.audio.mime)).trim(); } catch { t = ''; }
      }
      if (!t) { await say(msg.audio ? 'Não consegui ouvir o áudio. Pode escrever sua dúvida?' : 'Recebi! Me conta em texto qual é a dúvida sobre o sistema que eu te ajudo.'); return { support: 'no_text' }; }
      return support.supportTurn(sorg, msg, t, { reply });
    })();
    if (defer) { defer(work); return { support: 'deferred' }; }
    return work;
  }
  const ctx = ctxFor(link);
  if (!ctx) { await say('Seu acesso à organização está inativo.'); return { ignored: 'inactive' }; }

  // Nota de voz: vira texto pelo Whisper da VPS (o áudio não sai do servidor) e segue como se tivesse sido digitada.
  // Roda depois de devolver 200 para a Meta (baixar + transcrever pode levar alguns segundos).
  if (msg.audio && !text) {
    const work = (async () => {
      try { await wa.markRead(msg.id, true); } catch { /* cosmético */ }
      if (!voiceLocal.sttConfigured()) { await say('Recebi seu áudio 🎧, mas o reconhecimento de voz ainda não está instalado no servidor. Pode me mandar por escrito?'); return { audio: 'stt_off' }; }
      let heard = '';
      try {
        const media = await (waChatHooks.download || wa.downloadMedia)(msg.audio.id);
        heard = (await voiceLocal.transcribe(media.buffer, media.mime || msg.audio.mime)).trim();
      } catch (e) { console.warn(JSON.stringify({ level: 'warn', event: 'whatsapp.audio_failed', message: String(e.message).slice(0, 160) })); }
      if (!heard) { await say('Não consegui entender o áudio. Pode repetir ou mandar por escrito?'); return { audio: 'empty' }; }
      return handleInbound({ ...msg, id: `${msg.id}:voz`, text: heard, audio: undefined, voice: true }, { reply, defer: null });
    })();
    if (defer) { defer(work); return { audio: 'deferred' }; }
    return work;
  }

  // Foto ou vídeo: vira mídia pública dos posts (do plano em reunião ou do último rascunho)
  if (msg.media) {
    try { await wa.markRead(msg.id, true); } catch { /* */ }
    try {
      const file = await (waChatHooks.download || wa.downloadMedia)(msg.media.id);
      const saved = mkt.saveMedia(ctx, file.buffer, file.mime || msg.media.mime, `whatsapp.${msg.media.kind === 'video' ? 'mp4' : 'jpg'}`);
      const n = meeting.attachMedia(ctx, saved);
      await say(n ? `Recebi ${saved.kind === 'video' ? 'o vídeo' : 'a imagem'} e coloquei em ${n} post${n > 1 ? 's' : ''}. 👍` : `Recebi ${saved.kind === 'video' ? 'o vídeo' : 'a imagem'} e guardei. Diga, por exemplo, "agende um post no Instagram amanhã 18h sobre …" que eu uso ${saved.kind === 'video' ? 'ele' : 'ela'}.`);
      if (!text) return { media: saved.id, attached: n };
    } catch (e) { await say(`Não consegui pegar ${msg.media.kind === 'video' ? 'o vídeo' : 'a imagem'}: ${e.message}`); return { media: 'error' }; }
  }

  // PIN de aprovação do marketing (plano ou post)
  const mktWait = q.get("SELECT 'c' AS t, id FROM mkt_campaigns WHERE organization_id = ? AND wa_pin_until > ? UNION ALL SELECT 'i' AS t, id FROM mkt_items WHERE organization_id = ? AND wa_pin_until > ? LIMIT 1", ctx.orgId, now(), ctx.orgId, now());
  if (mktWait && /^\d{4,8}$/.test(text)) return confirmMktPin(ctx, link, mktWait, text, say);
  if (mktWait && /^cancelar$/i.test(text)) { q.run('UPDATE mkt_campaigns SET wa_pin_until = NULL WHERE organization_id = ?', ctx.orgId); q.run('UPDATE mkt_items SET wa_pin_until = NULL WHERE organization_id = ?', ctx.orgId); await say('Ok, nada foi aprovado.'); return { canceled: true }; }

  // Confirmação de PIN pendente
  const waiting = q.get("SELECT * FROM whatsapp_requests WHERE user_id = ? AND status = 'awaiting_pin' AND pending_until > ? ORDER BY created_at DESC LIMIT 1", ctx.userId, now());
  if (waiting && /^\d{4,8}$/.test(text)) return confirmPin(ctx, link, waiting, text, say);
  if (/^cancelar$/i.test(text)) {
    q.run("UPDATE whatsapp_requests SET status = 'sent', pending_until = NULL WHERE user_id = ? AND status = 'awaiting_pin'", ctx.userId);
    await say('Confirmação cancelada. Nada foi aprovado.');
    return { canceled: true };
  }

  let cmd = null; let code = null; let rest = '';
  if (msg.buttonId) { [cmd, code] = String(msg.buttonId).split(':'); }
  else {
    const m = /^(aprovar|rejeitar|revisar|ver)\s+([A-Z0-9]{6})\b\s*(.*)$/is.exec(text);
    if (m) { cmd = m[1].toLowerCase(); code = m[2].toUpperCase(); rest = m[3].trim(); }
    else if (/^pendentes?$/i.test(text)) cmd = 'pendentes';
    else if (/^(resumo|briefing)$/i.test(text)) cmd = 'resumo';
    else if (/^radar$/i.test(text)) cmd = 'radar';
    else if (/^(marketing|posts|agenda de posts)$/i.test(text)) cmd = 'marketing';
  }
  // APROVAR M12345 → plano ou post do marketing (pede o PIN)
  if (cmd === 'aprovar' && /^M[A-Z0-9]{5}$/.test(code || '')) {
    const target = mkt.findByCode(ctx.orgId, code);
    if (target) {
      if (!can(ctx, 'approve')) { await say('Seu perfil não pode aprovar publicações.'); return { error: 'forbidden' }; }
      if (!link.pin_hash) { await say('Cadastre seu PIN no painel (WhatsApp › PIN) para aprovar por aqui.'); return { error: 'no_pin' }; }
      if (link.pin_locked_until && link.pin_locked_until > now()) { await say('PIN bloqueado por tentativas erradas. Tente mais tarde ou aprove pelo painel.'); return { error: 'locked' }; }
      const resumo = target.campaign_id ? (() => { const c = mkt.getCampaign(ctx, target.campaign_id); return `o plano *${clampText(c.name, 60)}* (${c.items.filter((i) => i.status === 'aguardando_aprovacao').length} itens)`; })() : (() => { const it = mkt.getItem(ctx, target.item_id); return `*${clampText(it.title, 60)}* — ${mkt.fmtWhen(it.scheduled_at)} no ${it.networks.map((n) => mkt.NETWORK_LABEL[n]).join(' e ')}`; })();
      q.run(`UPDATE ${target.campaign_id ? 'mkt_campaigns' : 'mkt_items'} SET wa_pin_until = ? WHERE id = ?`, addMs(5 * 60_000), target.campaign_id || target.item_id);
      await say(`Para aprovar ${resumo}, envie seu PIN (vale 5 minutos). Depois disso eu publico sozinho no horário. CANCELAR desiste.`);
      return { awaiting_pin: 'marketing' };
    }
  }
  if (cmd === 'marketing') {
    const pend = mkt.pendingApproval(ctx); const up = mkt.upcoming(ctx, { days: 7, limit: 8 });
    const linhas = [...pend.campaigns.map((c) => `🗂️ Plano ${clampText(c.name, 50)} — APROVAR ${c.wa_code}`), ...pend.items.map((i) => `📣 ${clampText(i.title, 50)} (${mkt.fmtWhen(i.scheduled_at)}) — APROVAR ${i.wa_code}`)];
    await say(`${linhas.length ? `*Esperando sua aprovação*\n${linhas.join('\n')}\n\n` : 'Nada esperando aprovação.\n\n'}*Próximos 7 dias*\n${up.length ? up.map((i) => `${mkt.fmtWhen(i.scheduled_at)} · ${i.kind === 'post' ? i.networks.map((n) => mkt.NETWORK_LABEL[n]).join('+') : mkt.KIND_LABEL[i.kind]} · ${clampText(i.title, 40)} (${i.status_label})`).join('\n') : 'nada agendado'}\n\nPara um plano novo, diga "reunião de marketing".`);
    return { marketing: true };
  }
  if (!cmd) {
    if (/^(ajuda|comandos|menu|help)$/i.test(text) || !getSettings(ctx.orgId).whatsapp_chat || !text) { await say(HELP); return { help: true }; }
    const chat = chatTurn(ctx, msg, text, say);
    if (defer) { defer(chat); return { chat: 'deferred' }; }
    return chat;
  }

  if (cmd === 'resumo') {
    const b = await buildBriefing(ctx);
    const org = q.get('SELECT timezone FROM organizations WHERE id = ?', ctx.orgId);
    await say(briefingText(b, String(ctx.name || '').split(' ')[0], org?.timezone || undefined));
    return { briefing: true };
  }
  if (cmd === 'radar') { await say(await radarForCtx(ctx)); return { radar: true }; }

  if (cmd === 'pendentes') {
    const rows = q.all(`SELECT r.code, p.summary, p.expires_at FROM whatsapp_requests r JOIN action_proposals p ON p.id = r.action_proposal_id
      WHERE r.user_id = ? AND r.status IN ('sent','awaiting_pin') AND p.status = 'awaiting_approval' ORDER BY r.created_at DESC LIMIT 10`, ctx.userId);
    await say(rows.length ? `Aprovações pendentes:\n${rows.map((r) => `• *${r.code}* — ${clampText(r.summary, 80)} (até ${fmtDate(r.expires_at)})`).join('\n')}` : 'Nenhuma aprovação pendente para você.');
    return { listed: rows.length };
  }

  const req = q.get('SELECT * FROM whatsapp_requests WHERE code = ? AND user_id = ?', String(code || '').toUpperCase(), ctx.userId);
  if (!req) { await say('Código não encontrado para o seu número.'); return { error: 'code' }; }
  const p = q.get('SELECT * FROM action_proposals WHERE id = ? AND organization_id = ?', req.action_proposal_id, ctx.orgId);
  if (!p || p.status !== 'awaiting_approval' || p.version !== req.proposal_version || p.payload_hash !== req.payload_hash || !['sent', 'awaiting_pin'].includes(req.status)) {
    await say(`Este pedido não está mais válido (situação: ${p?.status || 'inexistente'}${p && p.version !== req.proposal_version ? ', a proposta mudou de versão' : ''}). Envie PENDENTES para ver os atuais.`);
    return { error: 'stale' };
  }
  const d = q.get('SELECT * FROM decisions WHERE id = ?', p.decision_id);

  if (cmd === 'ver') {
    const pr = json(p.parameters, {});
    const syn = q.get("SELECT result_ref FROM run_steps WHERE run_id = ? AND step_key = 'synthesis'", p.run_id);
    const s = json(syn?.result_ref, {});
    const parts = [proposalText(p, d, req.code)];
    if (p.tool_code === 'publish_instagram_post') parts.push(`\nLegenda completa:\n${pr.caption || '—'}`, pr.image_url ? `Imagem: ${pr.image_url}` : '');
    if (s.risks?.length) parts.push(`\nRiscos: ${s.risks.slice(0, 4).join('; ')}`);
    if (s.divergences?.length) parts.push(`Divergências: ${s.divergences.slice(0, 3).join('; ')}`);
    await say(parts.filter(Boolean).join('\n'));
    return { shown: true };
  }
  if (cmd === 'rejeitar') {
    try {
      reject(ctx, p.id, { proposal_version: p.version, payload_hash: p.payload_hash, comment: `Via WhatsApp${rest ? `: ${rest}` : ''}` }, null);
      q.run("UPDATE whatsapp_requests SET status = 'rejected', decided_at = ? WHERE id = ?", now(), req.id);
      await say('Proposta rejeitada e registrada. O coordenador foi informado.');
      return { rejected: true };
    } catch (e) { await say(`Não foi possível rejeitar: ${e.message}`); return { error: e.message }; }
  }
  if (cmd === 'revisar') {
    try {
      const r = requestRevision(ctx, p.id, { proposal_version: p.version, payload_hash: p.payload_hash, comment: rest || 'Revisar a proposta (pedido via WhatsApp).' }, null);
      const { enqueueRun } = await import('../orchestrator/engine.js');
      enqueueRun(q.get('SELECT * FROM decisions WHERE id = ?', r.decisionId), ctx, { revision_requested_by_approver: r.comment || 'Revisar a proposta.' });
      q.run("UPDATE whatsapp_requests SET status = 'revision', decided_at = ? WHERE id = ?", now(), req.id);
      await say('Revisão solicitada. Os agentes vão refazer a proposta e você recebe o novo pedido por aqui.');
      return { revision: true };
    } catch (e) { await say(`Não foi possível pedir revisão: ${e.message}`); return { error: e.message }; }
  }
  if (cmd === 'aprovar') {
    if (!link.pin_hash) { await say('Cadastre seu PIN no painel (Administração › WhatsApp) para aprovar por aqui.'); return { error: 'no_pin' }; }
    if (link.pin_locked_until && link.pin_locked_until > now()) { await say('PIN bloqueado por tentativas erradas. Tente mais tarde ou aprove pelo painel.'); return { error: 'locked' }; }
    q.run("UPDATE whatsapp_requests SET status = 'awaiting_pin', pending_until = ? WHERE id = ?", addMs(5 * 60_000), req.id);
    await say(`Para confirmar a aprovação de *${clampText(p.summary, 80)}*, envie seu PIN (válido por 5 minutos). Envie CANCELAR para desistir.`);
    return { awaiting_pin: true };
  }
  await say(HELP);
  return { help: true };
}

async function confirmMktPin(ctx, link, wait, pin, say) {
  if (link.pin_locked_until && link.pin_locked_until > now()) { await say('PIN bloqueado. Aprove pelo painel.'); return { error: 'locked' }; }
  if (!checkPin(pin, link.pin_hash)) {
    const fails = link.pin_failed + 1;
    q.run('UPDATE whatsapp_links SET pin_failed = ?, pin_locked_until = ? WHERE id = ?', fails >= 3 ? 0 : fails, fails >= 3 ? addMs(15 * 60_000) : null, link.id);
    if (fails >= 3) { q.run('UPDATE mkt_campaigns SET wa_pin_until = NULL WHERE id = ?', wait.id); q.run('UPDATE mkt_items SET wa_pin_until = NULL WHERE id = ?', wait.id); }
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.pin_failed', objectType: wait.t === 'c' ? 'mkt_campaign' : 'mkt_item', objectId: wait.id, metadata: { attempts: fails } });
    await say(fails >= 3 ? 'PIN incorreto 3 vezes. Aprovações por WhatsApp bloqueadas por 15 minutos.' : `PIN incorreto. Tentativas restantes: ${3 - fails}.`);
    return { error: 'pin' };
  }
  q.run('UPDATE whatsapp_links SET pin_failed = 0 WHERE id = ?', link.id);
  try {
    const r = mkt.approve(ctx, wait.t === 'c' ? { campaign_id: wait.id, via: 'whatsapp' } : { item_id: wait.id, via: 'whatsapp' });
    const parts = [];
    if (r.queued.length) parts.push(`${r.queued.length} post${r.queued.length > 1 ? 's' : ''} na fila (saem sozinhos no horário)`);
    if (r.ready_ads.length) parts.push(`${r.ready_ads.length} anúncio pronto pra você subir (te mando os detalhes no painel, em Marketing)`);
    if (r.tasks.length) parts.push(`${r.tasks.length} tarefa${r.tasks.length > 1 ? 's' : ''} das ações comerciais`);
    const pend = r.skipped.length ? `\n⚠️ Ficou de fora: ${r.skipped.map((x) => `${clampText(x.title, 40)} (${x.issues[0]})`).join('; ')}.` : '';
    await say(`✅ Aprovado. ${parts.join(', ') || 'Nada para executar'}.${pend}`);
    return { approved: true, marketing: r };
  } catch (e) { await say(`Não consegui aprovar: ${e.message}`); return { error: e.message }; }
}

async function confirmPin(ctx, link, req, pin, say) {
  if (link.pin_locked_until && link.pin_locked_until > now()) { await say('PIN bloqueado. Aprove pelo painel.'); return { error: 'locked' }; }
  if (!checkPin(pin, link.pin_hash)) {
    const fails = link.pin_failed + 1;
    q.run('UPDATE whatsapp_links SET pin_failed = ?, pin_locked_until = ? WHERE id = ?', fails >= 3 ? 0 : fails, fails >= 3 ? addMs(15 * 60_000) : null, link.id);
    if (fails >= 3) q.run("UPDATE whatsapp_requests SET status = 'sent', pending_until = NULL WHERE id = ?", req.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.pin_failed', objectType: 'action_proposal', objectId: req.action_proposal_id, metadata: { attempts: fails } });
    await say(fails >= 3 ? 'PIN incorreto 3 vezes. Aprovações por WhatsApp bloqueadas por 15 minutos.' : `PIN incorreto. Tentativas restantes: ${3 - fails}.`);
    return { error: 'pin' };
  }
  q.run('UPDATE whatsapp_links SET pin_failed = 0 WHERE id = ?', link.id);
  const p = q.get('SELECT * FROM action_proposals WHERE id = ?', req.action_proposal_id);
  if (!p || p.version !== req.proposal_version || p.payload_hash !== req.payload_hash) { await say('A proposta mudou enquanto você confirmava. Nada foi aprovado.'); return { error: 'stale' }; }
  try {
    const r = await approve(ctx, p.id, { proposal_version: req.proposal_version, payload_hash: req.payload_hash, comment: 'Aprovado via WhatsApp (PIN confirmado)' }, null);
    q.run("UPDATE whatsapp_requests SET status = 'approved', decided_at = ?, pending_until = NULL WHERE id = ?", now(), req.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.approved', objectType: 'action_proposal', objectId: p.id, metadata: { channel: 'whatsapp', number: wa.maskNumber(link.wa_id) } });
    const ex = r.execution || {};
    const res = ex.status === 'succeeded' ? `Executado com sucesso${ex.external_ref ? ` (ref. ${String(ex.external_ref).slice(0, 18)})` : ''}.`
      : ex.status === 'blocked' ? `Aprovado, mas a execução foi bloqueada: ${(ex.reasons || [ex.reason]).join('; ')}.`
        : ex.status === 'uncertain' ? 'Aprovado; o resultado ficou INCERTO — confira e concilie no painel antes de repetir.'
          : `Aprovado. Execução: ${ex.status || '—'}${ex.error ? ` (${ex.error})` : ''}.`;
    await say(`✅ Aprovado. ${res}`);
    return { approved: true, execution: ex.status };
  } catch (e) {
    q.run("UPDATE whatsapp_requests SET status = 'sent', pending_until = NULL WHERE id = ?", req.id);
    await say(`Não foi possível aprovar: ${e.message}`);
    return { error: e.message };
  }
}

// ---------- Conversa natural pelo WhatsApp ----------
const YES = /^(sim|s|pode|pode sim|pode abrir|abre|abra|manda ver|confirmo|confirmado|ok|okay|beleza|blz|bora|isso|isso mesmo|fechado|claro|vai|vamos|por favor|quero|uhum|aham)\b/i;
const NO = /^(n[aã]o|nao precisa|deixa|deixa pra la|agora n[aã]o|cancela|esquece)\b/i;

function splitMessage(t) {
  const parts = String(t || '').split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  if (parts.length <= 3) return parts;
  return [...parts.slice(0, 2), parts.slice(2).join('\n\n')];
}

async function chatTurn(ctx, msg, text, say) {
  try { await wa.markRead(msg.id, true); } catch { /* indicador é cosmético */ }
  if (/^(esquece (a|nossa) conversa|apaga (a|nossa) conversa|nova conversa)$/i.test(text)) {
    forgetWaChat(ctx); await say('Pronto, comecei do zero por aqui. 🙂'); return { chat: 'reset' };
  }
  const user = q.get('SELECT display_name FROM users WHERE id = ?', ctx.userId);
  const org = q.get('SELECT timezone, executions_paused FROM organizations WHERE id = ?', ctx.orgId);
  const c = { ...ctx, firstName: String(user?.display_name || ctx.name || '').split(' ')[0] || 'você', timezone: org?.timezone || 'America/Sao_Paulo', paused: !!org?.executions_paused };
  const history = waHistory(c);
  const pending = pendingAnalysis(history);
  const { createDecision } = await import('../api/routes.js');
  const { converse } = await import('./conversation.js');
  const started = Date.now();
  let r;
  try {
    if (pending && text.length <= 40 && YES.test(text)) r = await converse(c, { confirm_analysis: pending }, { channel: 'whatsapp', createDecision: (b) => createDecision(c, b, null) });
    else if (pending && text.length <= 40 && NO.test(text)) r = { reply: 'Tranquilo, não abro nada então. Se mudar de ideia é só falar.', intent: 'answer' };
    else r = await converse(c, { message: text, history: history.map((h) => ({ role: h.role, text: h.text })) }, { channel: 'whatsapp', createDecision: (b) => createDecision(c, b, null) });
  } catch (e) {
    r = { reply: e.status === 400 ? e.message : 'Tive um probleminha para responder agora. Pode mandar de novo daqui a pouco?', intent: 'answer' };
  }
  addWaTurn(c, 'user', text);
  addWaTurn(c, 'assistant', r.reply, r.intent === 'propose_analysis' && r.analysis_question ? { analysis_question: r.analysis_question } : null);
  if (r.intent === 'analysis_opened' && r.decision_id) {
    try { insert('wa_followups', { decision_id: r.decision_id, organization_id: c.orgId, user_id: c.userId, wa_id: msg.from, created_at: now(), notified_at: null }); } catch { /* */ }
  }
  // pergunta por áudio → resposta por áudio (voz local Kokoro), como uma pessoa faria; se falhar, vai por escrito
  if (msg.voice && voiceLocal.ttsConfigured() && wantsVoiceReply(c)) {
    try {
      const s = getSettings(c.orgId);
      const audio = await voiceLocal.synthesize(spokenText(r.reply), { voice: s.voice.local_voice, speed: s.voice.rate || 1, format: 'opus' });
      await (waChatHooks.sendVoice || wa.sendVoiceNote)(msg.from, audio, 'audio/ogg');
      return { chat: r.intent, voice: true };
    } catch (e) { console.warn(JSON.stringify({ level: 'warn', event: 'whatsapp.voice_reply_failed', message: String(e.message).slice(0, 160) })); }
  }
  // ritmo de quem digita: respostas instantâneas parecem robô
  const parts = splitMessage(r.reply);
  const typed = Math.min(3500, 700 + parts[0].length * 18) - (Date.now() - started);
  if (typed > 0) await waChatHooks.delay(typed);
  for (let i = 0; i < parts.length; i++) {
    if (i) await waChatHooks.delay(Math.min(2500, 500 + parts[i].length * 12));
    await say(parts[i]);
  }
  return { chat: r.intent };
}

/** Avisa pelo WhatsApp quando a análise aberta pela conversa termina (chamado pela rotina do worker). */
export async function processChatFollowups() {
  const rows = q.all(`SELECT f.*, d.status, d.question, d.current_run_id FROM wa_followups f JOIN decisions d ON d.id = f.decision_id
    WHERE f.notified_at IS NULL AND d.status IN ('completed','awaiting_approval','insufficient_data','failed','canceled','expired') LIMIT 10`);
  for (const f of rows) {
    q.run('UPDATE wa_followups SET notified_at = ? WHERE decision_id = ?', now(), f.decision_id);
    const link = q.get("SELECT id FROM whatsapp_links WHERE user_id = ? AND wa_id = ? AND status = 'verified'", f.user_id, f.wa_id);
    if (!link || Date.now() - Date.parse(f.created_at) > 23 * 3600_000) continue; // fora da janela de 24 h da Meta
    const step = f.current_run_id ? q.get("SELECT result_ref FROM run_steps WHERE run_id = ? AND step_key = 'synthesis' AND status = 'done'", f.current_run_id) : null;
    const s = json(step?.result_ref, {});
    let t;
    if (['failed', 'canceled', 'expired'].includes(f.status)) t = `A análise sobre "${clampText(f.question, 90)}" não chegou ao fim (situação: ${f.status}). Dá uma olhada no painel quando puder.`;
    else {
      t = `Saiu a análise sobre "${clampText(f.question, 90)}".`;
      if (s.proposal) t += `\n\nRecomendação: ${clampText(String(s.proposal), 600)}`;
      if (f.status === 'awaiting_approval') t += '\n\nTem uma ação esperando sua aprovação — vou te mandar o pedido com o código.';
      if (f.status === 'insufficient_data') t += '\n\nOs especialistas acharam os dados insuficientes para cravar uma resposta.';
    }
    try { await wa.sendText(f.wa_id, t); } catch (e) { console.error('[whatsapp] aviso de análise', e.message); }
    try { addWaTurn({ orgId: f.organization_id, userId: f.user_id }, 'assistant', t); } catch { /* */ }
  }
}

/** Avisa pelo WhatsApp quando um post do marketing é publicado (ou dá erro). Chamado pela rotina do worker. */
export async function processMarketing({ send = null } = {}) {
  const changed = mkt.processResults();
  for (const it of changed) {
    const who = it.approved_by || it.created_by;
    const link = who ? q.get("SELECT wa_id FROM whatsapp_links WHERE user_id = ? AND organization_id = ? AND status = 'verified' AND wa_id IS NOT NULL", who, it.organization_id) : null;
    q.run('UPDATE mkt_items SET notified_at = ? WHERE id = ?', now(), it.id);
    if (!link || (!send && !wa.isConfigured())) continue;
    const r = it.result?.redes || {};
    const linhas = it.networks.map((n) => `${r[n]?.situacao === 'publicado' ? '✅' : '❌'} ${mkt.NETWORK_LABEL[n]}${r[n]?.url ? `: ${r[n].url}` : r[n]?.erro ? ` — ${clampText(r[n].erro, 120)}` : ''}`).join('\n');
    const text = `${it.status === 'publicado' ? '📣 Publicado' : it.status === 'parcial' ? '📣 Publicado em parte' : '⚠️ Não consegui publicar'}: *${clampText(it.title, 70)}*\n${linhas}${it.result?.erro ? `\n${clampText(it.result.erro, 160)}` : ''}`;
    try { if (send) await send(link.wa_id, text); else await wa.sendText(link.wa_id, text); } catch (e) { console.warn('[marketing] aviso', e.message); }
  }
  return { notified: changed.length };
}

/** Manda o resumo de um plano/post enviado para aprovação pelo painel (com o código para aprovar com PIN). */
export async function notifySubmission(ctx, text) {
  const link = q.get("SELECT wa_id FROM whatsapp_links WHERE user_id = ? AND organization_id = ? AND status = 'verified' AND wa_id IS NOT NULL", ctx.userId, ctx.orgId);
  if (!link || !wa.isConfigured()) return false;
  try { await wa.sendText(link.wa_id, text); return true; } catch { return false; }
}
