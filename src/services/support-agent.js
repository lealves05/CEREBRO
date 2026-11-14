// Agente de suporte no número público da LORLER (o "WhatsApp do suporte" do Master), ligado ao Cérebro.
//  - Quem NÃO é da equipe (cliente, curioso) só recebe respostas TÉCNICAS sobre os sistemas LORLER (como usar, passo a
//    passo, vídeo-aulas, acesso, configuração). Nada de números da empresa, decisões, marketing, cofre ou aprovações.
//  - Assunto fora disso → resposta educada dizendo que ali é só suporte técnico.
//  - "falar com atendente" → avisa o dono no número pessoal dele, com a última mensagem do cliente.
//  - O número pessoal do dono (cadastrado no painel) fica vinculado ao usuário dele: ali o Cérebro conversa sem
//    restrição e sabe que é ele (aprovações continuam pedindo o PIN).
import { q, insert, uuid, now } from '../db.js';
import { errors, clampText } from '../lib/util.js';
import { audit } from './audit.js';
import * as wa from '../connectors/whatsapp.js';
import { isConfigured as masterConfigured, supportBrain } from '../connectors/master.js';
import { SYSTEM_CODES } from '../seed.js';
import { bridgeStatus } from './master-whatsapp.js';

export const hooks = { brain: (body) => supportBrain(body) };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const DIGITS = (s) => String(s || '').replace(/\D/g, '');
const hits = new Map();

export function settingsFor(orgId) {
  const r = q.get('SELECT * FROM support_agent WHERE organization_id = ?', orgId);
  return { enabled: !!r?.enabled, handoff: r ? !!r.handoff : true, hours: r?.hours || '', greeting: r?.greeting || '', owner_user_id: r?.owner_user_id || null };
}
/** A organização que atende o número público (a primeira com o agente ligado). */
export function activeOrg() { return q.get('SELECT organization_id FROM support_agent WHERE enabled = 1 ORDER BY updated_at LIMIT 1')?.organization_id || null; }

export function publicView(ctx) {
  const s = settingsFor(ctx.orgId);
  const link = q.get("SELECT wa_id, status FROM whatsapp_links WHERE organization_id = ? AND user_id = ?", ctx.orgId, ctx.userId);
  const today = new Date(Date.now() - 86400_000).toISOString();
  const stats = q.get('SELECT COUNT(DISTINCT wa_id) AS pessoas, COUNT(*) AS msgs FROM support_chats WHERE organization_id = ? AND created_at > ?', ctx.orgId, today);
  return { ...s, my_number: link?.status === 'verified' ? wa.maskNumber(link.wa_id) : null, business_number: wa.waConfig().businessNumber || null, configured: wa.isConfigured(), transport: wa.transport(), bridge: bridgeStatus(), master: masterConfigured(), last24h: stats };
}

export function saveSettings(ctx, b) {
  const cur = settingsFor(ctx.orgId);
  const row = { enabled: b.enabled == null ? (cur.enabled ? 1 : 0) : (b.enabled ? 1 : 0), handoff: b.handoff == null ? (cur.handoff ? 1 : 0) : (b.handoff ? 1 : 0), hours: clampText(String(b.hours ?? cur.hours).replace(/[<>\r\n]/g, ' '), 120), greeting: clampText(String(b.greeting ?? cur.greeting).replace(/[<>]/g, ' '), 400) };
  if (q.get('SELECT 1 FROM support_agent WHERE organization_id = ?', ctx.orgId)) q.run('UPDATE support_agent SET enabled = ?, handoff = ?, hours = ?, greeting = ?, owner_user_id = COALESCE(owner_user_id, ?), updated_at = ? WHERE organization_id = ?', row.enabled, row.handoff, row.hours, row.greeting, ctx.userId, now(), ctx.orgId);
  else insert('support_agent', { organization_id: ctx.orgId, ...row, owner_user_id: ctx.userId, updated_at: now() });
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'support_agent.updated', metadata: { enabled: !!row.enabled, handoff: !!row.handoff } });
  return publicView(ctx);
}

/** Cadastra o número pessoal do dono: vincula ao usuário dele (sem precisar do código LORLER). */
export function setMyNumber(ctx, number) {
  let n = DIGITS(number);
  if (n.length === 10 || n.length === 11) n = `55${n}`; // DDD + número brasileiro
  if (!/^\d{12,15}$/.test(n)) throw errors.invalid('Número inválido. Use DDD + número, ex.: 19 99999-9999.');
  if (n === wa.waConfig().businessNumber) throw errors.invalid('Esse é o número da LORLER (o do suporte). Cadastre o seu número pessoal.');
  const other = q.get("SELECT id, user_id FROM whatsapp_links WHERE wa_id = ? AND status = 'verified' AND NOT (organization_id = ? AND user_id = ?)", n, ctx.orgId, ctx.userId);
  if (other) q.run("UPDATE whatsapp_links SET status = 'disabled', wa_id = NULL WHERE id = ?", other.id);
  const ex = q.get('SELECT id FROM whatsapp_links WHERE organization_id = ? AND user_id = ?', ctx.orgId, ctx.userId);
  if (ex) q.run("UPDATE whatsapp_links SET wa_id = ?, status = 'verified', verified_at = ?, link_code_hash = NULL, link_code_expires_at = NULL WHERE id = ?", n, now(), ex.id);
  else insert('whatsapp_links', { id: uuid(), organization_id: ctx.orgId, user_id: ctx.userId, wa_id: n, status: 'verified', link_code_hash: null, link_code_expires_at: null, pin_hash: null, pin_failed: 0, pin_locked_until: null, notify: 1, verified_at: now(), created_at: now() });
  q.run('UPDATE support_agent SET owner_user_id = ? WHERE organization_id = ?', ctx.userId, ctx.orgId);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'whatsapp.owner_number_set', metadata: { number: wa.maskNumber(n) } });
  return { number: wa.maskNumber(n) };
}

// ---------------- conversa de suporte ----------------
const OFF_TOPIC = /\b(faturamento|quanto (a lorler|voces|vc) (fatura|ganha)|receita da empresa|socio|dono da lorler|salario|politica|eleic|futebol|aposta|bet|piada|namor|receita de|horoscopo|bitcoin|cripto|investir)\b/;
const HUMAN = /\b(atendente|humano|pessoa de verdade|falar com alguem|falar com o leandro|suporte humano|quero falar com|ligar pra voce|me liga)\b/;
const TECH_HINT = new RegExp(`\\b(${SYSTEM_CODES.map((c) => c.toLowerCase()).join('|')}|sistema|login|senha|acesso|acessar|cadastr|configur|instal|agenda|agendamento|comanda|mesa|estoque|caixa|venda|nota|nfc|boleto|pix|whatsapp|relatorio|usuario|plano|assinatura|erro|bug|nao abre|nao funciona|travou|como (faco|faz|uso|usar|configuro|cadastro|emito|imprimo|vejo)|onde (fica|vejo|acho)|video ?aula|tutorial|app|celular|impressora|leitor|codigo de barras|os\\b|ordem de servico|orcamento|cliente|profissional|servico|produto)`);

function history(orgId, waId) {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  q.run('DELETE FROM support_chats WHERE created_at < ?', new Date(Date.now() - 7 * 86400_000).toISOString());
  return q.all('SELECT role, text FROM support_chats WHERE organization_id = ? AND wa_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 8', orgId, waId, since).reverse();
}
const remember = (orgId, waId, role, text) => insert('support_chats', { id: uuid(), organization_id: orgId, wa_id: waId, role, text: clampText(String(text || ''), 1500), created_at: now() });

const RULES = 'Você é o suporte técnico da LORLER pelo WhatsApp, falando com um CLIENTE ou interessado (não é alguém da equipe). '
  + 'Responda SOMENTE dúvidas técnicas sobre os sistemas LORLER (ORBI, TORVEN, RUSTEN, APOLVEN, ANIBI e CIFREN): como usar, passo a passo, onde fica cada função, acesso e senha, configuração, impressoras e leitores, integração com WhatsApp e Pix, e indique a vídeo-aula quando houver. '
  + 'NUNCA fale de números, clientes, faturamento ou decisões internas da LORLER, nem de outras empresas clientes; nunca prometa preço, desconto ou prazo que não esteja na base; nunca peça senha ou dados de cartão. '
  + 'Se a pergunta não for técnica sobre os sistemas, diga com gentileza que por este canal você só ajuda com dúvidas técnicas dos sistemas e pergunte em que pode ajudar. '
  + 'Se não souber, diga que vai chamar um atendente. Mensagens curtas de WhatsApp (até 4 frases), sem markdown pesado, no máximo um emoji.';

/** Uma mensagem de quem não é da equipe. reply(text) envia. Devolve o resumo do que aconteceu. */
export async function supportTurn(orgId, msg, text, { reply }) {
  const s = settingsFor(orgId);
  const waId = msg.from;
  const t = Date.now(); const h = (hits.get(waId) || []).filter((x) => t - x < 60_000);
  if (h.length >= 8) return { support: 'rate_limited' };
  h.push(t); hits.set(waId, h);
  try { await wa.markRead(msg.id, true); } catch { /* cosmético */ }
  const f = fold(text);
  const past = history(orgId, waId);
  remember(orgId, waId, 'user', text);
  const say = async (out) => { remember(orgId, waId, 'assistant', out); await reply(waId, out); };
  if (!past.length && /^(oi|ola|bom dia|boa tarde|boa noite|e ai|opa|tudo bem)\b/.test(f) && f.length < 40) {
    await say(s.greeting || `Olá! 👋 Aqui é o suporte técnico da LORLER. Me conta sua dúvida sobre o ${SYSTEM_CODES.slice(0, 4).join(', ')} ou outro sistema que eu te ajudo.${s.hours ? ` Atendimento humano: ${s.hours}.` : ''}`);
    return { support: 'greeting' };
  }
  if (HUMAN.test(f)) {
    if (s.handoff) {
      const owner = s.owner_user_id ? q.get("SELECT wa_id FROM whatsapp_links WHERE user_id = ? AND organization_id = ? AND status = 'verified' AND wa_id IS NOT NULL", s.owner_user_id, orgId) : null;
      const lastQ = past.filter((p) => p.role === 'user').slice(-2).map((p) => p.text).concat(text).join(' / ');
      if (owner) { try { await wa.sendText(owner.wa_id, `🙋 Cliente pediu atendente no suporte: +${waId}\n“${clampText(lastQ, 400)}”\nResponda direto pelo WhatsApp: https://wa.me/${waId}`); } catch { /* */ } }
      await say(`Certo! Já chamei um atendente, ele te responde por aqui${s.hours ? ` (${s.hours})` : ' assim que possível'}. Se quiser, já vai me contando os detalhes.`);
      return { support: 'handoff' };
    }
  }
  if (OFF_TOPIC.test(f) && !TECH_HINT.test(f)) {
    await say('Por aqui eu só consigo ajudar com dúvidas técnicas sobre os sistemas da LORLER (ORBI, TORVEN, RUSTEN, APOLVEN, ANIBI e CIFREN). Tem alguma dúvida sobre como usar algum deles?');
    return { support: 'off_topic' };
  }
  let out = null;
  if (masterConfigured()) {
    try {
      const r = await hooks.brain({ message: text, history: past.map((p) => ({ role: p.role, text: p.text })), contexto: { canal: 'suporte_whatsapp_cliente', regras: RULES }, telas: [], name: 'Suporte LORLER', persona: RULES });
      if (r && typeof r.reply === 'string' && r.reply.trim()) out = clampText(r.reply.trim(), 1500);
    } catch (e) { console.warn(JSON.stringify({ level: 'warn', event: 'support_agent.ai_failed', message: clampText(String(e.message), 160) })); }
  }
  if (!out) out = TECH_HINT.test(f)
    ? `Boa pergunta! Os passos com vídeo estão no próprio sistema, no botão *Ajuda* (no topo de cada tela) e em *Suporte e treinamento*. Se preferir, diga "atendente" que eu chamo alguém da equipe.`
    : 'Por aqui eu ajudo com dúvidas técnicas sobre os sistemas da LORLER. Me conta qual sistema você usa e o que precisa fazer?';
  // trava final: nada de assunto interno na resposta
  if (/\b(faturamento|receita recorrente|mrr|inadimpl|aprovac|cofre|campanha interna)\b/i.test(fold(out))) out = 'Por aqui eu ajudo só com dúvidas técnicas sobre os sistemas da LORLER. Em que posso ajudar?';
  await say(out);
  return { support: 'answer' };
}
