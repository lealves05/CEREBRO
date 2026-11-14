// Ponte com o WhatsApp da LORLER conectado no Master por QR Code (aparelho conectado).
// O Master entrega aqui só as mensagens do NÚMERO PESSOAL do dono (cadastrado em Master › Canal de suporte);
// as dos clientes ficam com o agente de suporte do Master (só dúvidas técnicas). O Cérebro busca as mensagens
// com espera longa (~15 s), conversa como sempre (reuniões, marketing, aprovações com PIN) e responde pelo Master.
import { q, uuid, now, insert } from '../db.js';
import { IS_WORKER } from '../config.js';
import { call } from '../connectors/master.js';
import * as wa from '../connectors/whatsapp.js';
import { audit } from './audit.js';

export const bridgeHooks = { call: (...a) => call(...a), handle: null };
let running = false; let stopped = false; let last = { at: null, ok: null, error: null, owner: null };
export const bridgeStatus = () => ({ ...last, active: running, transport: wa.transport() });

/** Vincula o número ao dono quando não há dúvida (um único proprietário ativo no Cérebro). */
function autoLink(phone) {
  const owners = q.all("SELECT m.organization_id, m.user_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.role = 'owner' AND m.status = 'active' AND u.status = 'active'");
  if (owners.length !== 1) return false;
  const o = owners[0];
  const ex = q.get('SELECT id, wa_id, status FROM whatsapp_links WHERE organization_id = ? AND user_id = ?', o.organization_id, o.user_id);
  if (ex?.status === 'verified' && ex.wa_id && ex.wa_id !== phone) return false; // já tem outro número: não troca sozinho
  if (ex) q.run("UPDATE whatsapp_links SET wa_id = ?, status = 'verified', verified_at = ? WHERE id = ?", phone, now(), ex.id);
  else insert('whatsapp_links', { id: uuid(), organization_id: o.organization_id, user_id: o.user_id, wa_id: phone, status: 'verified', link_code_hash: null, link_code_expires_at: null, pin_hash: null, pin_failed: 0, pin_locked_until: null, notify: 1, verified_at: now(), created_at: now() });
  audit({ orgId: o.organization_id, actorType: 'system', actorId: 'master-whatsapp', event: 'whatsapp.owner_number_set', metadata: { number: wa.maskNumber(phone), via: 'master' } });
  return true;
}

/** Uma busca no Master. Devolve quantas mensagens foram tratadas. */
export async function pollOnce({ wait = 15 } = {}) {
  const r = await bridgeHooks.call(`/atendimento/whatsapp/cerebro/pendentes?espera=${wait}`);
  last = { at: now(), ok: true, error: null, owner: r?.owner_number ? wa.maskNumber(r.owner_number) : null };
  const items = Array.isArray(r?.items) ? r.items : [];
  const handle = bridgeHooks.handle || (await import('./whatsapp-approvals.js')).handleInbound;
  for (const m of items) {
    const phone = String(m.phone || '').replace(/\D/g, '');
    if (!phone) continue;
    if (!q.get("SELECT 1 FROM whatsapp_links WHERE wa_id = ? AND status = 'verified'", phone) && !autoLink(phone)) {
      await wa.sendText(phone, 'Oi! Ainda não sei que é você. No Cérebro, abra *WhatsApp › Seu número pessoal* e salve este número.').catch(() => {});
      continue;
    }
    try { await handle({ id: `master.${m.id}`, from: phone, text: String(m.text || '').slice(0, 4000) }, { reply: (to, t) => wa.sendText(to, t) }); }
    catch (e) { console.warn(JSON.stringify({ level: 'warn', event: 'master_whatsapp.handle_failed', message: String(e.message).slice(0, 160) })); }
  }
  return items.length;
}

/** Laço contínuo (só no servidor Node, quando o WhatsApp sai pelo Master). */
export function startMasterWhatsApp() {
  if (running || IS_WORKER || process.env.NODE_ENV === 'test' || !wa.viaMaster()) return false;
  running = true; stopped = false;
  let backoff = 2000;
  const loop = async () => {
    while (!stopped) {
      try { await pollOnce(); backoff = 2000; }
      catch (e) {
        last = { ...last, at: now(), ok: false, error: String(e.message).slice(0, 200) };
        await new Promise((r) => setTimeout(r, backoff).unref?.());
        backoff = Math.min(backoff * 2, 60000);
      }
    }
    running = false;
  };
  loop();
  console.log('[whatsapp] conversa pelo WhatsApp da LORLER conectado no Master (QR Code)');
  return true;
}
export function stopMasterWhatsApp() { stopped = true; }
