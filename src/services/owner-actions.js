// Acesso total do dono (pelo WhatsApp pessoal, voz ou HUD) ao Cérebro e à Área Master.
// O modelo de IA (o mesmo da Central de Atendimento, no Master) escolhe uma ação deste catálogo e o Cérebro executa.
// Leituras saem na hora; mudanças (bloquear, liberar, prorrogar, plano, pagamento, responder cliente) pedem um "SIM".
// Pedidos comuns têm um atalho sem IA (redes sociais, criar post, agenda), para funcionar mesmo com a IA fora do ar.
import { clampText } from '../lib/util.js';
import { call as masterCall, isConfigured as masterConfigured } from '../connectors/master.js';
import * as mkt from './marketing.js';
import * as meeting from './meeting.js';
import { runners as skillRunners } from './skills.js';
import { audit } from './audit.js';

export const hooks = { master: (...a) => masterCall(...a) };
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const pending = new Map(); // `${org}:${user}` → { action, args, label, until }
const PENDING_MS = 10 * 60_000;
const key = (ctx) => `${ctx.orgId}:${ctx.userId}`;
export const isOwner = (ctx) => ctx?.role === 'owner';

export const CATALOG = [
  { nome: 'redes_status', descricao: 'confere a conexão com as redes sociais e se o publicador da VPS está pronto para publicar' },
  { nome: 'criar_post', descricao: 'cria um post (texto e mídia da biblioteca) e deixa pronto para aprovar', args: 'tema, redes[instagram|facebook|tiktok|linkedin], quando (ex.: "amanhã 18h"), sistema (ORBI, TORVEN...)' },
  { nome: 'agenda_posts', descricao: 'lista os posts e ações agendados e o que espera aprovação' },
  { nome: 'reuniao_marketing', descricao: 'começa a reunião de marketing (plano de posts, anúncio e ações comerciais)' },
  { nome: 'empresas', descricao: 'lista empresas clientes da Área Master', args: 'filtro (teste|inadimplentes|vencendo|ativas|bloqueadas), sistema, termo' },
  { nome: 'empresa_detalhe', descricao: 'situação completa de uma empresa (plano, teste, pagamentos, acesso)', args: 'empresa (nome, e-mail ou CNPJ)' },
  { nome: 'empresa_bloquear', descricao: 'bloqueia o acesso de uma empresa', args: 'empresa, motivo' },
  { nome: 'empresa_liberar', descricao: 'libera o acesso de uma empresa bloqueada', args: 'empresa, ate (AAAA-MM-DD, opcional), motivo' },
  { nome: 'empresa_prorrogar_teste', descricao: 'prorroga o período de teste', args: 'empresa, dias' },
  { nome: 'empresa_pagamento_recebido', descricao: 'marca o pagamento como recebido (Pix por fora, depósito) e libera o período', args: 'empresa, observacao' },
  { nome: 'empresa_trocar_plano', descricao: 'troca o plano de uma empresa', args: 'empresa, plano (nome do plano)' },
  { nome: 'assinaturas', descricao: 'assinaturas e cobranças: vencendo, em atraso, pagamentos recentes' },
  { nome: 'atendimento_conversas', descricao: 'conversas abertas da Central de Atendimento (clientes falando com o suporte)' },
  { nome: 'atendimento_responder', descricao: 'responde um cliente na Central de Atendimento', args: 'empresa, texto' },
];
const NAMES = [...CATALOG.map((a) => a.nome), 'redes_e_post'];
const WRITES = new Set(['empresa_bloquear', 'empresa_liberar', 'empresa_prorrogar_teste', 'empresa_pagamento_recebido', 'empresa_trocar_plano', 'atendimento_responder']);

// ---------------- atalhos sem IA ----------------
export function quickIntent(text) {
  const f = fold(text);
  const redes = /\b(redes?( sociais)?|instagram|insta|facebook|face|tiktok|linkedin|publicador)\b/.test(f);
  const querPost = /\b(cri|ger|faz|mont|escrev|prepar)\w* (um |uma |o |a )?(post|publicacao)/.test(f);
  if (redes && /\b(conex|conect|disponiv|pront|funcion|ligad|status|situacao|verific|confer|ja (da|posso|podemos)|consegu)/.test(f)) return { nome: querPost ? 'redes_e_post' : 'redes_status', args: {} };
  const pergunta = /^(qual|quais|quando|como|onde|por ?que|o que|quanto)\b/.test(f);
  if (!pergunta && (/\b(ger|cri|faz|mont|escrev|prepar|agend|program|post|public)\w*\b.*\b(post|publicacao|story|stories|reels?|carrossel)\b/.test(f) || /\b(posta|postar|publica|publicar)\b.*\b(instagram|facebook|tiktok|linkedin|redes)\b/.test(f))) return { nome: 'criar_post', args: {} };
  if (/\b(o que (esta|ta) agendado|posts agendados|agenda (de|dos) posts|proximos posts|o que vai sair)\b/.test(f)) return { nome: 'agenda_posts', args: {} };
  if (/\b(empresas?|clientes?) (em teste|inadimplentes?|vencendo|bloquead|ativ)/.test(f)) {
    const filtro = /teste/.test(f) ? 'teste' : /inadimpl|atras/.test(f) ? 'inadimplentes' : /venc/.test(f) ? 'vencendo' : /bloque/.test(f) ? 'bloqueadas' : 'ativas';
    return { nome: 'empresas', args: { filtro } };
  }
  return null;
}

// ---------------- execução ----------------
const money = (v) => (v == null ? '—' : `R$ ${Number(v).toFixed(2).replace('.', ',')}`);
const day = (d) => (d ? new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '—');
const STATUS = { ACTIVE: 'ativa', TRIAL: 'em teste', PAST_DUE: 'em atraso', PAYMENT_PENDING: 'pagamento pendente', BLOCKED: 'bloqueada', CANCELED: 'cancelada', EXPIRED: 'vencida', SUSPENDED: 'suspensa' };
const st = (t) => (t.admin_blocked ? 'bloqueada pelo Master' : STATUS[t.status] || String(t.status || '').toLowerCase());

async function findTenant(term) {
  const t = String(term || '').trim();
  if (t.length < 2) throw new Error('Diga o nome (ou e-mail/CNPJ) da empresa.');
  const rows = await hooks.master(`/tenants?q=${encodeURIComponent(t.slice(0, 80))}`);
  const list = Array.isArray(rows) ? rows : rows?.items || [];
  if (!list.length) throw new Error(`Não achei nenhuma empresa com "${t}".`);
  const exact = list.find((x) => fold(x.name) === fold(t));
  if (exact || list.length === 1) return exact || list[0];
  throw new Error(`Achei ${list.length} empresas com "${t}": ${list.slice(0, 6).map((x) => `${x.name} (${String(x.product || '').toUpperCase()})`).join('; ')}. Qual delas?`);
}

async function run(ctx, nome, a = {}, text = '') {
  switch (nome) {
    case 'redes_status': {
      const p = mkt.publisherStatus();
      const todas = ['instagram', 'facebook', 'tiktok', 'linkedin'];
      const ok = (p.redes || []).filter((r) => todas.includes(r) || r === 'youtube');
      const falta = todas.filter((r) => !ok.includes(r));
      if (!p.online) return `O publicador da VPS não respondeu${p.minutos != null && !p.nunca_rodou ? ` (última rodada há ${p.minutos} min)` : ''}. Rode o LIGAR-PUBLICADOR-CEREBRO.bat no PC para ele voltar a ler a fila.`;
      if (!p.credenciais) return 'O publicador da VPS está ligado, mas ainda não recebeu as credenciais das redes. No PUBLICADOR.bat, use a opção 3 (Enviar para a VPS).';
      return ok.length
        ? `Publicador online (rodou há ${p.minutos} min). Prontas para publicar: ${ok.map((r) => mkt.NETWORK_LABEL[r] || r).join(', ')}.${falta.length ? ` Faltam: ${falta.map((r) => mkt.NETWORK_LABEL[r]).join(', ')} (PUBLICADOR.bat › 1 e depois › 3).` : ''} Quer que eu gere um post agora?`
        : 'O publicador está online, mas nenhuma rede foi conectada ainda. No PUBLICADOR.bat: opção 1 para conectar e opção 3 para enviar para a VPS.';
    }
    case 'criar_post': {
      const built = [a.sistema, Array.isArray(a.redes) && a.redes.length && `no ${a.redes.join(' e ')}`, a.quando, a.tema && `sobre ${a.tema}`].filter(Boolean).join(' ');
      const r = await skillRunners.marketing({ ...ctx }, built ? `agende um post ${built}` : text);
      return r.reply;
    }
    case 'redes_e_post': {
      const status = await run(ctx, 'redes_status', {});
      const post = await run(ctx, 'criar_post', {}, text);
      return `${status.replace(/ Quer que eu gere um post agora\?$/, '')}\n\n${post}`;
    }
    case 'agenda_posts': return (await skillRunners.marketing(ctx, 'o que está agendado')).reply;
    case 'reuniao_marketing': return (await meeting.handle(ctx, 'reunião de marketing', ctx.channel || 'whatsapp'))?.reply || 'Vamos lá: qual é o objetivo da campanha?';
    case 'empresas': {
      const qs = new URLSearchParams();
      if (a.filtro === 'teste') qs.set('trial', '1'); else if (a.filtro === 'inadimplentes') qs.set('status', 'INADIMPLENTE'); else if (a.filtro === 'vencendo') qs.set('expiring', '1'); else if (a.filtro === 'ativas') qs.set('status', 'ACTIVE');
      if (a.sistema) qs.set('product', String(a.sistema).toLowerCase());
      if (a.termo) qs.set('q', String(a.termo));
      let list = await hooks.master(`/tenants?${qs}`); list = Array.isArray(list) ? list : list?.items || [];
      if (a.filtro === 'bloqueadas') list = list.filter((t) => t.admin_blocked);
      if (!list.length) return 'Nenhuma empresa nesse filtro.';
      return `${list.length} empresa(s):\n${list.slice(0, 15).map((t) => `• ${t.name} (${String(t.product || '').toUpperCase()}) — ${st(t)}${t.plan_name ? `, ${t.plan_name}` : ''}${t.trial_ends_at && t.trial_type ? `, teste até ${day(t.trial_ends_at)}` : ''}${t.valid_until ? `, válido até ${day(t.valid_until)}` : ''}`).join('\n')}${list.length > 15 ? `\n… e mais ${list.length - 15}.` : ''}`;
    }
    case 'empresa_detalhe': {
      const t = await findTenant(a.empresa || a.termo);
      return `${t.name} (${String(t.product || '').toUpperCase()}): ${st(t)}. Plano ${t.plan_name || '—'}${t.billing_cycle ? ` (${t.billing_cycle === 'MONTHLY' ? 'mensal' : 'anual'})` : ''}. ${t.trial_type ? `Teste até ${day(t.trial_ends_at)}. ` : ''}Válido até ${day(t.valid_until)}. Último pagamento ${day(t.last_payment)}, próxima cobrança ${day(t.next_charge)}. Responsável: ${t.owner || '—'} · ${t.email || ''}${t.phone ? ` · ${t.phone}` : ''}. Último acesso ${day(t.last_access_at)}.`;
    }
    case 'empresa_bloquear': { const t = await findTenant(a.empresa); await hooks.master(`/tenants/${t.id}/block`, { method: 'POST', body: { confirm: true, reason: clampText(a.motivo || 'Pedido do dono pelo Cérebro', 300) } }); return `🔒 ${t.name} bloqueada.`; }
    case 'empresa_liberar': { const t = await findTenant(a.empresa); const ate = /^\d{4}-\d{2}-\d{2}$/.test(a.ate || '') ? a.ate : null; await hooks.master(`/tenants/${t.id}/release`, { method: 'POST', body: { confirm: true, mode: ate ? 'until' : 'restore', until: ate, reason: clampText(a.motivo || 'Pedido do dono pelo Cérebro', 300) } }); return `🔓 ${t.name} liberada${ate ? ` até ${day(ate + 'T12:00:00')}` : ''}.`; }
    case 'empresa_prorrogar_teste': { const t = await findTenant(a.empresa); const d = Math.max(1, Math.min(365, Number(a.dias) || 7)); await hooks.master(`/tenants/${t.id}/trial`, { method: 'POST', body: { action: 'extend', days: d, reason: 'Pedido do dono pelo Cérebro' } }); return `⏳ Teste de ${t.name} prorrogado por ${d} dias.`; }
    case 'empresa_pagamento_recebido': { const t = await findTenant(a.empresa); await hooks.master(`/tenants/${t.id}/payment-received`, { method: 'POST', body: { confirm: true, reason: clampText(a.observacao || 'Pagamento confirmado pelo dono no Cérebro', 300) } }); return `💰 Pagamento de ${t.name} registrado e período liberado.`; }
    case 'empresa_trocar_plano': {
      const t = await findTenant(a.empresa);
      let plans = await hooks.master(`/plans?product=${encodeURIComponent(t.product || '')}`); plans = Array.isArray(plans) ? plans : plans?.items || [];
      const p = plans.find((x) => fold(x.name) === fold(a.plano)) || plans.find((x) => fold(x.name).includes(fold(a.plano)));
      if (!p) throw new Error(`Não achei o plano "${a.plano}" no ${String(t.product || '').toUpperCase()}. Planos: ${plans.map((x) => x.name).join(', ')}.`);
      await hooks.master(`/tenants/${t.id}/plan`, { method: 'POST', body: { plan_id: p.id, reason: 'Pedido do dono pelo Cérebro' } });
      return `✅ ${t.name} agora está no plano ${p.name}.`;
    }
    case 'assinaturas': {
      let venc = await hooks.master('/tenants?expiring=1'); venc = Array.isArray(venc) ? venc : venc?.items || [];
      let atraso = await hooks.master('/tenants?status=INADIMPLENTE'); atraso = Array.isArray(atraso) ? atraso : atraso?.items || [];
      let pays = await hooks.master('/payments').catch(() => []); pays = (Array.isArray(pays) ? pays : pays?.items || []).filter((p) => p.status === 'CONFIRMED').slice(0, 5);
      return `Vencendo em 15 dias: ${venc.length ? venc.map((t) => `${t.name} (${day(t.valid_until)})`).join(', ') : 'nenhuma'}.\nEm atraso: ${atraso.length ? atraso.map((t) => t.name).join(', ') : 'nenhuma'}.\nÚltimos pagamentos: ${pays.length ? pays.map((p) => `${p.salon_name || p.name || '—'} ${money(p.amount ?? p.value)} em ${day(p.paid_at)}`).join('; ') : 'nenhum recente'}.`;
    }
    case 'atendimento_conversas': {
      const r = await hooks.master('/atendimento/conversas?status=abertas'); const items = r?.items || [];
      if (!items.length) return 'Nenhuma conversa aberta na Central de Atendimento.';
      return `${items.length} conversa(s) aberta(s):\n${items.slice(0, 10).map((c) => `• ${c.salon_name || c.company || c.tenant_name || '—'} (${String(c.product || '').toUpperCase()}) — ${c.handler === 'humano' ? 'com você' : 'com a IA'}: “${clampText(c.last_body || c.last_message || '', 90)}”`).join('\n')}`;
    }
    case 'atendimento_responder': {
      const r = await hooks.master('/atendimento/conversas?status=abertas'); const items = r?.items || [];
      const c = items.find((x) => fold(x.salon_name || x.company || x.tenant_name || '').includes(fold(a.empresa)));
      if (!c) throw new Error(`Não achei conversa aberta da empresa "${a.empresa}".`);
      await hooks.master(`/atendimento/conversas/${c.id}/mensagens`, { method: 'POST', body: { body: clampText(a.texto, 6000) } });
      return `✉️ Respondi ${c.salon_name || a.empresa} na Central de Atendimento.`;
    }
    default: throw new Error('Ação desconhecida.');
  }
}

function describe(nome, a) {
  return ({
    empresa_bloquear: `bloquear ${a.empresa}${a.motivo ? ` (motivo: ${a.motivo})` : ''}`,
    empresa_liberar: `liberar ${a.empresa}${a.ate ? ` até ${a.ate}` : ''}`,
    empresa_prorrogar_teste: `prorrogar o teste de ${a.empresa} por ${Number(a.dias) || 7} dias`,
    empresa_pagamento_recebido: `marcar o pagamento de ${a.empresa} como recebido e liberar o período`,
    empresa_trocar_plano: `trocar o plano de ${a.empresa} para ${a.plano}`,
    atendimento_responder: `responder ${a.empresa} na Central de Atendimento: “${clampText(a.texto, 200)}”`,
  })[nome] || nome;
}

/** Executa (leitura) ou pede o SIM (mudança). */
export async function perform(ctx, nome, args = {}, text = '') {
  if (!NAMES.includes(nome)) return null;
  const masterNeeded = nome.startsWith('empresa') || nome === 'empresas' || nome.startsWith('atendimento') || nome === 'assinaturas';
  if (masterNeeded && !masterConfigured()) return { reply: 'A Área Master ainda não está ligada no Cérebro (Integrações › Área Master).', intent: 'answer' };
  if (WRITES.has(nome)) {
    pending.set(key(ctx), { nome, args, until: Date.now() + PENDING_MS });
    return { reply: `Confirma ${describe(nome, args)}? Responda *SIM* para fazer ou *NÃO* para desistir.`, intent: 'answer', owner_action: nome, awaiting: true };
  }
  try { return { reply: await run(ctx, nome, args, text), intent: 'answer', owner_action: nome }; }
  catch (e) { return { reply: e.message, intent: 'answer', owner_action: nome }; }
}

/** Resposta ao "Confirma…?" pendente. */
export async function confirmPending(ctx, text) {
  const p = pending.get(key(ctx));
  if (!p) return null;
  if (p.until < Date.now()) { pending.delete(key(ctx)); return null; }
  const f = fold(text);
  if (/^(sim|s|pode|confirmo|confirma|isso|ok|manda|faz|fechado|pode fazer)\b/.test(f) && f.length <= 30) {
    pending.delete(key(ctx));
    try {
      const out = await run(ctx, p.nome, p.args);
      audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: `owner_action.${p.nome}`, metadata: { args: p.args, channel: ctx.channel || null } });
      return { reply: out, intent: 'answer', owner_action: p.nome };
    } catch (e) { return { reply: `Não deu certo: ${e.message}`, intent: 'answer', owner_action: p.nome }; }
  }
  if (/^(nao|n|cancela|deixa|esquece|desisto)\b/.test(f) && f.length <= 30) { pending.delete(key(ctx)); return { reply: 'Ok, não fiz nada.', intent: 'answer' }; }
  return null; // outra conversa: o pedido fica guardado por 10 min
}

export const catalogForBrain = () => CATALOG.map(({ nome, descricao, args }) => ({ nome, descricao, ...(args ? { args } : {}) }));
