// Marketing do Cérebro: agenda de posts (Instagram, Facebook, TikTok, LinkedIn), anúncios pagos e ações comerciais,
// organizados em planos (campanhas). Regras:
//  - nada é publicado, enviado a cliente ou gasto sem aprovação humana (senha no painel ou PIN no WhatsApp);
//  - depois de aprovado, cada post vai para a fila do publicador da LORLER na VPS, que publica sozinho no horário
//    pelas APIs oficiais das redes e devolve o link (ou o erro);
//  - anúncio pago nunca é ativado pelo Cérebro: ele entrega o pacote pronto (texto, criativo, público, orçamento e
//    duração) para você subir no gerenciador de anúncios — nenhum dinheiro sai sem você;
//  - ação comercial aprovada vira tarefa interna com os passos.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, insert, uuid, now, json } from '../db.js';
import { config, ROOT } from '../config.js';
import { errors, clampText, sha256, canonicalJson } from '../lib/util.js';
import { audit } from './audit.js';
import * as vault from './vault.js';

export const NETWORKS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube'];
export const PLAN_NETWORKS = ['instagram', 'facebook', 'tiktok', 'linkedin']; // padrão dos planos (YouTube só entra com vídeo)
export const NETWORK_LABEL = { instagram: 'Instagram', facebook: 'Facebook', tiktok: 'TikTok', linkedin: 'LinkedIn', youtube: 'YouTube' };
export const KIND_LABEL = { post: 'Post', anuncio: 'Anúncio', acao: 'Ação comercial' };
export const STATUS_LABEL = { rascunho: 'rascunho', aguardando_aprovacao: 'aguardando aprovação', aprovado: 'aprovado', na_fila: 'agendado (na fila)', publicado: 'publicado', parcial: 'publicado em parte', erro: 'com erro', cancelado: 'cancelado', concluido: 'concluído' };
const LIMITS = { instagram: 2200, facebook: 60000, tiktok: 2200, linkedin: 3000, youtube: 4900 };
// melhores horários (Brasília) por rede — ponto de partida; você ajusta na reunião
const BEST = { instagram: '18:30', facebook: '12:30', tiktok: '20:00', linkedin: '08:30', youtube: '19:00' };
const SYSTEM_SITES = { ORBI: 'orbi.lorler.com.br', TORVEN: 'torven.lorler.com.br', RUSTEN: 'rusten.lorler.com.br', APOLVEN: 'apolven.lorler.com.br', ANIBI: 'anibi.lorler.com.br', CIFREN: 'cifren.lorler.com.br' };
const SYSTEM_PITCH = {
  ORBI: 'agenda, vendas e clientes de salões, barbearias e estética num lugar só',
  TORVEN: 'ordens de serviço, orçamentos e oficina organizados do pedido à entrega',
  RUSTEN: 'comandas, mesas, estoque e lucro do bar e do restaurante na palma da mão',
  APOLVEN: 'cotações, carteira e comissões da corretora de seguros sem planilha',
  ANIBI: 'agenda, prontuário, vacinas e pet shop da clínica veterinária',
  CIFREN: 'contas, banco e finanças da empresa organizados e no azul',
};
export const MEDIA_BASE = 'https://cdn.jsdelivr.net/gh/lealves05/CEREBRO@midia-posts/posts';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const money = (c) => (Number(c || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const TZ = 'America/Sao_Paulo';

// ---------------- biblioteca pronta (posts por sistema com textos de cada rede e mídia pública) ----------------
let LIB = null;
export function library() {
  if (LIB) return LIB;
  try { LIB = JSON.parse(fs.readFileSync(path.join(ROOT || '.', 'config', 'marketing-biblioteca.json'), 'utf8')); } catch { LIB = []; }
  LIB = LIB.map((x) => {
    const n = String(x.id || '').toLowerCase().replace('-', '-');
    return { ...x, feed: `${MEDIA_BASE}/${n}-feed.jpg`, story: `${MEDIA_BASE}/${n}-story.jpg`, video: `${MEDIA_BASE}/${n}-video.mp4` };
  });
  return LIB;
}

// ---------------- fila do publicador (pasta lida pelo lorler-publicador na VPS) ----------------
export function queueDir() {
  if (process.env.LORLER_SOCIAL_FILA) return process.env.LORLER_SOCIAL_FILA;
  const base = config.dbFile && config.dbFile !== ':memory:' ? path.dirname(config.dbFile) : path.join(ROOT || '.', 'data');
  return path.join(base, 'social-fila');
}
const qdir = (sub) => { const d = path.join(queueDir(), sub); fs.mkdirSync(d, { recursive: true }); return d; };

/** Situação do publicador (o lorler-publicador grava status.json a cada ciclo de 5 min). */
export function publisherStatus() {
  try {
    const st = JSON.parse(fs.readFileSync(path.join(queueDir(), 'status.json'), 'utf8'));
    const age = (Date.now() - Date.parse(st.rodou_em || 0)) / 60000;
    return { ...st, online: age < 20, minutos: Math.round(age) };
  } catch { return { online: false, redes: [], credenciais: false, drive: false, nunca_rodou: true }; }
}

// ---------------- validação ----------------
function hashtagsOf(t) { return (String(t || '').match(/#[\p{L}\p{N}_]+/gu) || []).length; }
export function textFor(item, net) { const t = (item.texts || {})[net]; return t && t.trim() ? t : item.text; }

/** Problemas que impedem publicar em cada rede (o painel mostra; a aprovação recusa). */
export function issues(item) {
  const out = [];
  if (item.kind !== 'post') return out;
  const nets = item.networks || [];
  if (!nets.length) out.push('Escolha ao menos uma rede.');
  if (!item.scheduled_at) out.push('Defina a data e a hora.');
  else if (Date.parse(item.scheduled_at) < Date.now() - 5 * 60_000) out.push('O horário já passou.');
  for (const n of nets) {
    const t = textFor(item, n) || '';
    if (!t.trim() && n !== 'tiktok') out.push(`${NETWORK_LABEL[n]}: falta o texto.`);
    if (t.length > LIMITS[n]) out.push(`${NETWORK_LABEL[n]}: texto com ${t.length} caracteres (máx. ${LIMITS[n]}).`);
    if (n === 'instagram' && !item.media_url) out.push('Instagram: precisa de imagem ou vídeo.');
    if (n === 'instagram' && hashtagsOf(t) > 5) out.push('Instagram: no máximo 5 hashtags.');
    if (n === 'tiktok' && item.media_kind !== 'video') out.push('TikTok: precisa de vídeo.');
    if (n === 'youtube' && item.media_kind !== 'video') out.push('YouTube: precisa de vídeo.');
  }
  if (item.media_url && !/^https:\/\//.test(item.media_url)) out.push('A mídia precisa de um link https público.');
  return out;
}

// ---------------- leitura ----------------
function shapeItem(r) {
  if (!r) return null;
  const it = { ...r, networks: json(r.networks, []), texts: json(r.texts, {}), ad: json(r.ad, {}), action: json(r.action, {}), result: json(r.result, {}) };
  delete it.wa_pin_until;
  it.issues = issues(it);
  it.status_label = STATUS_LABEL[it.status] || it.status;
  return it;
}
function shapeCampaign(r) { return r ? { ...r, networks: json(r.networks, []), budget: money(r.budget_cents), wa_pin_until: undefined } : null; }

export function getItem(ctx, id) { const r = q.get('SELECT * FROM mkt_items WHERE id = ? AND organization_id = ?', String(id || ''), ctx.orgId); if (!r) throw errors.notFound(); return shapeItem(r); }
export function getCampaign(ctx, id) {
  const r = q.get('SELECT * FROM mkt_campaigns WHERE id = ? AND organization_id = ?', String(id || ''), ctx.orgId); if (!r) throw errors.notFound();
  return { ...shapeCampaign(r), items: q.all('SELECT * FROM mkt_items WHERE campaign_id = ? ORDER BY COALESCE(scheduled_at, created_at)', r.id).map(shapeItem) };
}
export function listItems(ctx, { from = null, to = null, status = null, limit = 300 } = {}) {
  const w = ['organization_id = ?']; const p = [ctx.orgId];
  if (from) { w.push('(scheduled_at IS NULL OR scheduled_at >= ?)'); p.push(from); }
  if (to) { w.push('(scheduled_at IS NULL OR scheduled_at < ?)'); p.push(to); }
  if (status) { w.push('status = ?'); p.push(status); }
  return q.all(`SELECT * FROM mkt_items WHERE ${w.join(' AND ')} ORDER BY COALESCE(scheduled_at, created_at) LIMIT ?`, ...p, limit).map(shapeItem);
}
export function listCampaigns(ctx) {
  return q.all('SELECT c.*, (SELECT COUNT(*) FROM mkt_items i WHERE i.campaign_id = c.id) AS items FROM mkt_campaigns c WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100', ctx.orgId).map(shapeCampaign);
}

// ---------------- escrita ----------------
function cleanNets(v) { const a = Array.isArray(v) ? v : String(v || '').split(/[\s,]+/); return [...new Set(a.map((x) => fold(x).trim()).map((x) => (x === 'face' || x === 'fb' ? 'facebook' : x === 'insta' || x === 'ig' ? 'instagram' : x === 'tik tok' || x === 'tt' ? 'tiktok' : x === 'linked in' || x === 'li' ? 'linkedin' : x === 'yt' || x === 'shorts' ? 'youtube' : x)).filter((x) => NETWORKS.includes(x)))]; }
function cleanDate(v) { if (!v) return null; const t = Date.parse(v); if (Number.isNaN(t)) throw errors.invalid('Data/hora inválida.'); return new Date(t).toISOString(); }
function cleanUrl(v) { const s = String(v || '').trim(); if (!s) return ''; if (!/^https:\/\/[^\s]+$/i.test(s) || s.length > 1000) throw errors.invalid('Link de mídia inválido (use https).'); return s; }
function mediaKind(url, given) { if (given === 'imagem' || given === 'video') return given; if (!url) return ''; return /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url) ? 'video' : 'imagem'; }

export function createItem(ctx, b, { source = 'painel', campaignId = null } = {}) {
  const kind = ['post', 'anuncio', 'acao'].includes(b.kind) ? b.kind : 'post';
  const media = cleanUrl(b.media_url);
  const row = {
    id: uuid(), organization_id: ctx.orgId, created_by: ctx.userId || null, campaign_id: campaignId || b.campaign_id || null, kind,
    title: clampText(String(b.title || '').replace(/[\r\n]/g, ' ').trim(), 140) || KIND_LABEL[kind],
    networks: JSON.stringify(cleanNets(b.networks)), text: clampText(String(b.text || ''), 6000),
    texts: JSON.stringify(Object.fromEntries(Object.entries(b.texts || {}).filter(([k, v]) => NETWORKS.includes(k) && typeof v === 'string' && v.trim()).map(([k, v]) => [k, clampText(v, LIMITS[k] + 500)]))),
    media_url: media, media_kind: mediaKind(media, b.media_kind), format: ['9x16', '4x5', '1x1', ''].includes(b.format) ? b.format : '',
    link: clampText(String(b.link || ''), 500), scheduled_at: cleanDate(b.scheduled_at), status: 'rascunho',
    ad: JSON.stringify(b.ad && typeof b.ad === 'object' ? b.ad : {}), action: JSON.stringify(b.action && typeof b.action === 'object' ? b.action : {}),
    source, created_at: now(), updated_at: now(),
  };
  insert('mkt_items', row);
  return shapeItem(q.get('SELECT * FROM mkt_items WHERE id = ?', row.id));
}

const EDITABLE = ['rascunho', 'aguardando_aprovacao', 'aprovado', 'erro'];
export function updateItem(ctx, id, b) {
  const cur = getItem(ctx, id);
  if (!EDITABLE.includes(cur.status)) throw errors.conflict(`Não dá para editar: está ${STATUS_LABEL[cur.status]}. Cancele primeiro.`);
  const set = {};
  if (b.title != null) set.title = clampText(String(b.title).replace(/[\r\n]/g, ' ').trim(), 140) || cur.title;
  if (b.networks != null) set.networks = JSON.stringify(cleanNets(b.networks));
  if (b.text != null) set.text = clampText(String(b.text), 6000);
  if (b.texts != null) set.texts = JSON.stringify(Object.fromEntries(Object.entries(b.texts || {}).filter(([k, v]) => NETWORKS.includes(k) && typeof v === 'string').map(([k, v]) => [k, clampText(v, LIMITS[k] + 500)])));
  if (b.media_url != null) { set.media_url = cleanUrl(b.media_url); set.media_kind = mediaKind(set.media_url, b.media_kind); }
  if (b.format != null) set.format = ['9x16', '4x5', '1x1', ''].includes(b.format) ? b.format : '';
  if (b.link != null) set.link = clampText(String(b.link), 500);
  if (b.scheduled_at !== undefined) set.scheduled_at = cleanDate(b.scheduled_at);
  if (b.ad != null && typeof b.ad === 'object') set.ad = JSON.stringify(b.ad);
  if (b.action != null && typeof b.action === 'object') set.action = JSON.stringify(b.action);
  // qualquer mudança derruba a aprovação: o que for publicado é sempre o que foi aprovado
  set.status = 'rascunho'; set.payload_hash = null; set.approved_by = null; set.approved_at = null; set.updated_at = now();
  const keys = Object.keys(set);
  q.run(`UPDATE mkt_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => set[k]), cur.id);
  return getItem(ctx, cur.id);
}

// ---------------- textos (biblioteca, modelo pt-BR ou IA) ----------------
function pickLib(product, n = 0) { const l = library().filter((x) => !product || x.sistema === product); return l.length ? l[n % l.length] : null; }

/** Textos por rede para um tema. Usa a biblioteca pronta do sistema quando existe; senão um modelo pt-BR bem escrito. */
export function draftTexts({ product = null, topic = '', offer = '', cta = '', libIndex = 0 } = {}) {
  const site = SYSTEM_SITES[product] || 'lorler.com.br';
  const lib = !topic && product ? pickLib(product, libIndex) : null;
  if (lib) {
    return {
      title: `${product}: ${lib.tema}`, media_url: lib.video, media_kind: 'video', format: '9x16', lib_id: lib.id,
      texts: { instagram: `${lib.ig}\n\n${lib.tags}`.slice(0, 2200), facebook: lib.fb, tiktok: lib.tt, linkedin: lib.li },
      text: lib.fb,
    };
  }
  const nome = product || 'LORLER';
  const tema = clampText(String(topic || SYSTEM_PITCH[product] || 'organizar a gestão do seu negócio').trim().replace(/[.!]+$/, ''), 160);
  const oferta = offer ? ` ${String(offer).trim().replace(/[.!]*$/, '.')}` : '';
  const chamada = cta || (offer ? 'Garanta a sua pelo link.' : `Teste grátis: ${site}`);
  const tag = `#${nome} #LORLER #gestao #empreendedorismo`;
  const ig = `${tema.charAt(0).toUpperCase()}${tema.slice(1)}? 👀\n\nCom o ${nome}, ${SYSTEM_PITCH[product] || 'sua gestão fica simples, no computador e no celular'}.${oferta}\n\n${chamada} (link na bio)\n\n${tag}`;
  const fb = `${tema.charAt(0).toUpperCase()}${tema.slice(1)}?\n\nO ${nome} resolve: ${SYSTEM_PITCH[product] || 'gestão simples, no computador e no celular'}.${oferta}\n\n${chamada} 👇`;
  const tt = `${tema.charAt(0).toUpperCase()}${tema.slice(1)}? Olha isso 👀 ${chamada} #${nome} #LORLER`;
  const li = `${tema.charAt(0).toUpperCase()}${tema.slice(1)} é um desafio comum para quem empreende.\n\nO ${nome} nasceu para isso: ${SYSTEM_PITCH[product] || 'organizar a operação e dar visão do negócio'}.${oferta}\n\nSe faz sentido para você ou para alguém que você conhece, ${chamada.charAt(0).toLowerCase()}${chamada.slice(1)}`;
  const libMedia = product ? pickLib(product, libIndex) : null;
  return { title: `${nome}: ${clampText(tema, 60)}`, texts: { instagram: ig, facebook: fb, tiktok: tt, linkedin: li }, text: fb, media_url: libMedia?.video || '', media_kind: libMedia ? 'video' : '', format: libMedia ? '9x16' : '' };
}

// ---------------- datas ----------------
function localParts(d) { const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }); const o = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value])); return o; }
/** ISO de uma data local (YYYY-MM-DD) e hora (HH:MM) em Brasília (UTC-3, sem horário de verão). */
export function atLocal(dateStr, hhmm) { return new Date(`${dateStr}T${hhmm}:00-03:00`).toISOString(); }
export function todayLocal() { const o = localParts(new Date()); return `${o.year}-${o.month}-${o.day}`; }
function addDays(dateStr, n) { const d = new Date(`${dateStr}T12:00:00-03:00`); d.setUTCDate(d.getUTCDate() + n); const o = localParts(d); return `${o.year}-${o.month}-${o.day}`; }
export function fmtWhen(iso) { if (!iso) return 'sem data'; return new Date(iso).toLocaleString('pt-BR', { timeZone: TZ, weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', ''); }

// ---------------- plano (campanha) ----------------
/**
 * Monta um plano completo: posts nas redes ao longo do período, 1 anúncio pago (se houver orçamento) e ações comerciais.
 * b: { name, objective, product_code, offer, audience, start_date, end_date, budget_cents, networks, posts_per_week, topics[] }
 */
export function planCampaign(ctx, b, { source = 'painel' } = {}) {
  const product = SYSTEM_SITES[String(b.product_code || '').toUpperCase()] ? String(b.product_code).toUpperCase() : null;
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(b.start_date || '')) ? b.start_date : addDays(todayLocal(), 1);
  let end = /^\d{4}-\d{2}-\d{2}$/.test(String(b.end_date || '')) ? b.end_date : addDays(start, 13);
  if (end < start) end = addDays(start, 13);
  const days = Math.min(62, Math.round((Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400_000) + 1);
  const nets = cleanNets(b.networks).length ? cleanNets(b.networks) : PLAN_NETWORKS;
  const perWeek = Math.min(7, Math.max(1, parseInt(b.posts_per_week, 10) || 3));
  const budget = Math.max(0, Math.min(100_000_00, parseInt(b.budget_cents, 10) || 0));
  const objective = ['vendas', 'leads', 'reconhecimento', 'engajamento', 'reativacao'].includes(b.objective) ? b.objective : 'vendas';
  const name = clampText(String(b.name || '').trim(), 120) || `${product || 'LORLER'} — ${({ vendas: 'vendas', leads: 'novos contatos', reconhecimento: 'marca', engajamento: 'engajamento', reativacao: 'reativar clientes' })[objective]} ${start.slice(8, 10)}/${start.slice(5, 7)}`;
  const offer = clampText(String(b.offer || ''), 300); const audience = clampText(String(b.audience || ''), 300);
  const camp = { id: uuid(), organization_id: ctx.orgId, created_by: ctx.userId || null, name, objective, product_code: product, offer, audience, start_date: start, end_date: end, budget_cents: budget, networks: JSON.stringify(nets), status: 'rascunho', notes: clampText(String(b.notes || ''), 2000), created_at: now(), updated_at: now() };
  insert('mkt_campaigns', camp);
  const topics = (Array.isArray(b.topics) ? b.topics : []).map((t) => clampText(String(t), 160)).filter(Boolean);
  // posts: espalhados no período (seg/qua/sex primeiro), horário bom de cada rede
  const total = Math.max(1, Math.round((days / 7) * perWeek));
  const pref = [1, 3, 5, 2, 4, 6, 0]; // dias da semana preferidos (0 = domingo)
  const slots = [];
  for (let i = 0; i < days && slots.length < total * 3; i++) { const d = addDays(start, i); const wd = new Date(`${d}T12:00:00-03:00`).getUTCDay(); slots.push({ d, rank: pref.indexOf(wd) }); }
  const chosen = slots.sort((a, b2) => a.rank - b2.rank || a.d.localeCompare(b2.d)).slice(0, total).map((s) => s.d).sort();
  const made = [];
  chosen.forEach((d, i) => {
    const dr = draftTexts({ product, topic: topics[i] || '', offer, libIndex: i });
    // cada rede no seu melhor horário: um item por dia com o horário do Instagram (ou da 1ª rede); LinkedIn em dia útil de manhã sai em item próprio
    const main = nets.filter((n) => n !== 'linkedin');
    if (main.length) made.push(createItem(ctx, { kind: 'post', title: dr.title, networks: main, text: dr.text, texts: dr.texts, media_url: dr.media_url, media_kind: dr.media_kind, format: dr.format, scheduled_at: atLocal(d, BEST[main[0]] || '18:30'), link: product ? `https://${SYSTEM_SITES[product]}` : '' }, { source, campaignId: camp.id }));
    if (nets.includes('linkedin') && i % 2 === 0) made.push(createItem(ctx, { kind: 'post', title: `${dr.title} (LinkedIn)`, networks: ['linkedin'], text: dr.texts.linkedin, texts: { linkedin: dr.texts.linkedin }, media_url: dr.media_url, media_kind: dr.media_kind, format: dr.format, scheduled_at: atLocal(d, BEST.linkedin) }, { source, campaignId: camp.id }));
  });
  // anúncio pago (pacote pronto — o Cérebro não ativa gasto)
  if (budget > 0) {
    const daily = Math.max(600, Math.round(budget / days));
    const lib = product ? pickLib(product, 0) : null;
    made.push(createItem(ctx, {
      kind: 'anuncio', title: `Anúncio: ${name}`, networks: nets.filter((n) => n !== 'linkedin').slice(0, 2).length ? nets.filter((n) => n !== 'linkedin').slice(0, 2) : ['instagram'],
      text: draftTexts({ product, offer }).texts.instagram, media_url: lib?.video || '', media_kind: lib ? 'video' : '', format: '9x16', scheduled_at: atLocal(start, '09:00'),
      ad: {
        objetivo: { vendas: 'Vendas / conversões', leads: 'Cadastros (leads)', reconhecimento: 'Reconhecimento', engajamento: 'Engajamento', reativacao: 'Tráfego para clientes antigos' }[objective],
        publico: audience || (product ? `Donos e gestores de ${({ ORBI: 'salões, barbearias e estética', TORVEN: 'oficinas, serralherias e assistência técnica', RUSTEN: 'bares e restaurantes', APOLVEN: 'corretoras de seguros', ANIBI: 'clínicas veterinárias e pet shops', CIFREN: 'pequenas empresas' })[product]}, 25–55 anos, Brasil` : 'Empreendedores, 25–55 anos, Brasil'),
        orcamento_total: money(budget), orcamento_diario: money(daily), dias: days, inicio: start, fim: end,
        cta: objective === 'leads' ? 'Cadastre-se' : 'Saiba mais', destino: product ? `https://${SYSTEM_SITES[product]}` : 'https://lorler.com.br',
        onde_subir: 'Meta: business.facebook.com › Gerenciador de Anúncios › Criar (campanha, conjunto e anúncio com este texto e vídeo). TikTok: ads.tiktok.com. LinkedIn: linkedin.com/campaignmanager.',
      },
    }, { source, campaignId: camp.id }));
  }
  // ações comerciais
  const acts = [
    { title: `Condição especial${offer ? `: ${offer}` : ''}`, tipo: 'oferta', passos: [`Cadastrar a condição no ${product || 'sistema'} (cupom/desconto/plano) válida de ${start.split('-').reverse().join('/')} a ${end.split('-').reverse().join('/')}`, 'Conferir o preço final e a margem', 'Avisar o suporte para atender quem chegar pela campanha'] },
    { title: 'Mensagem para a base (WhatsApp)', tipo: 'mensagem', passos: [`Separar os contatos ${objective === 'reativacao' ? 'que cancelaram ou estão parados' : 'em teste e os leads dos últimos 60 dias'}`, 'Enviar pelo modelo aprovado da Meta (categoria Marketing) com o link da campanha', 'Responder em até 1 hora quem chamar'] },
    { title: 'Follow-up de demonstrações', tipo: 'follow-up', passos: ['Listar quem pediu demonstração e não fechou', 'Ligar ou mandar mensagem oferecendo a condição da campanha', 'Registrar o resultado de cada contato'] },
  ];
  for (const a of acts) made.push(createItem(ctx, { kind: 'acao', title: a.title, networks: [], text: a.passos.map((p, i) => `${i + 1}. ${p}`).join('\n'), action: { tipo: a.tipo, passos: a.passos }, scheduled_at: atLocal(start, '10:00') }, { source, campaignId: camp.id }));
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId || null, event: 'marketing.plan_created', objectType: 'mkt_campaign', objectId: camp.id, metadata: { items: made.length, budget_cents: budget, source } });
  return getCampaign(ctx, camp.id);
}

export function summarizeCampaign(c, { max = 12 } = {}) {
  const lines = c.items.slice(0, max).map((it, i) => `${i + 1}. ${it.kind === 'post' ? `📣 ${it.networks.map((n) => NETWORK_LABEL[n]).join('+')}` : it.kind === 'anuncio' ? '💰 Anúncio' : '🤝 Ação'} · ${it.kind === 'acao' ? 'início' : fmtWhen(it.scheduled_at)} · ${clampText(it.title, 60)}${it.issues.length ? ' ⚠️' : ''}`);
  if (c.items.length > max) lines.push(`… e mais ${c.items.length - max}.`);
  return lines.join('\n');
}

// ---------------- aprovação ----------------
const itemPayload = (it) => ({ id: it.id, kind: it.kind, networks: it.networks, text: it.text, texts: it.texts, media_url: it.media_url, scheduled_at: it.scheduled_at, ad: it.ad, action: it.action });
const hashItem = (it) => sha256(canonicalJson(itemPayload(it)));
function newCode() {
  for (let i = 0; i < 20; i++) {
    const c = `M${crypto.randomBytes(4).toString('base64').replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 5).padEnd(5, '7')}`;
    if (!q.get('SELECT 1 FROM mkt_items WHERE wa_code = ?', c) && !q.get('SELECT 1 FROM mkt_campaigns WHERE wa_code = ?', c) && !q.get('SELECT 1 FROM whatsapp_requests WHERE code = ?', c)) return c;
  }
  throw new Error('sem código');
}

/** Põe um item ou um plano inteiro para aprovação (gera o código usado no WhatsApp). */
export function submit(ctx, { item_id = null, campaign_id = null }) {
  if (campaign_id) {
    const c = getCampaign(ctx, campaign_id);
    const open = c.items.filter((i) => ['rascunho', 'aguardando_aprovacao', 'erro'].includes(i.status));
    if (!open.length) throw errors.conflict('Nada para aprovar neste plano.');
    const code = q.get('SELECT wa_code FROM mkt_campaigns WHERE id = ?', c.id).wa_code || newCode();
    const h = sha256(canonicalJson(open.map(itemPayload)));
    q.run('UPDATE mkt_campaigns SET wa_code = ?, payload_hash = ?, updated_at = ? WHERE id = ?', code, h, now(), c.id);
    for (const i of open) q.run("UPDATE mkt_items SET status = 'aguardando_aprovacao', payload_hash = ?, updated_at = ? WHERE id = ?", hashItem(i), now(), i.id);
    return { code, campaign: getCampaign(ctx, c.id) };
  }
  const it = getItem(ctx, item_id);
  if (!['rascunho', 'aguardando_aprovacao', 'erro'].includes(it.status)) throw errors.conflict(`Está ${it.status_label}.`);
  const code = q.get('SELECT wa_code FROM mkt_items WHERE id = ?', it.id).wa_code || newCode();
  q.run("UPDATE mkt_items SET status = 'aguardando_aprovacao', wa_code = ?, payload_hash = ?, updated_at = ? WHERE id = ?", code, hashItem(it), now(), it.id);
  return { code, item: getItem(ctx, it.id) };
}

/** Aprova (o chamador já confirmou senha ou PIN e a permissão "approve"). Posts vão para a fila; ações viram tarefas. */
export function approve(ctx, { item_id = null, campaign_id = null, via = 'painel', publishNow = false }) {
  const targets = campaign_id ? getCampaign(ctx, campaign_id).items.filter((i) => ['rascunho', 'aguardando_aprovacao', 'erro'].includes(i.status)) : [getItem(ctx, item_id)];
  if (!targets.length) throw errors.conflict('Nada para aprovar.');
  const blocked = targets.filter((i) => i.issues.length);
  const out = { queued: [], ready_ads: [], tasks: [], skipped: blocked.map((i) => ({ id: i.id, title: i.title, issues: i.issues })) };
  for (const it of targets) {
    if (it.issues.length) continue;
    if (it.payload_hash && it.payload_hash !== hashItem(it)) { out.skipped.push({ id: it.id, title: it.title, issues: ['mudou depois do envio para aprovação'] }); continue; }
    // aprovado no WhatsApp = publica já (o publicador da VPS é acionado na hora); horário que já passou também sai na hora
    const nowIso = new Date().toISOString();
    const when = it.kind === 'post' && (publishNow || !it.scheduled_at || it.scheduled_at < nowIso) ? nowIso : it.scheduled_at;
    if (when !== it.scheduled_at) q.run('UPDATE mkt_items SET scheduled_at = ? WHERE id = ?', when, it.id);
    q.run("UPDATE mkt_items SET status = 'aprovado', approved_by = ?, approved_at = ?, payload_hash = ?, updated_at = ? WHERE id = ?", ctx.userId, now(), hashItem({ ...it, scheduled_at: when }), now(), it.id);
    if (it.kind === 'post') { enqueue({ ...it, scheduled_at: when, status: 'aprovado' }); out.queued.push(it.id); if (when === nowIso) (out.now ||= []).push(it.id); }
    else if (it.kind === 'acao') { out.tasks.push(...createTasks(ctx, it)); q.run("UPDATE mkt_items SET status = 'concluido', updated_at = ? WHERE id = ?", now(), it.id); }
    else out.ready_ads.push(it.id);
  }
  if (campaign_id) q.run("UPDATE mkt_campaigns SET status = 'ativa', approved_by = ?, approved_at = ?, wa_pin_until = NULL, updated_at = ? WHERE id = ?", ctx.userId, now(), now(), campaign_id);
  else q.run('UPDATE mkt_items SET wa_pin_until = NULL WHERE id = ?', item_id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'marketing.approved', objectType: campaign_id ? 'mkt_campaign' : 'mkt_item', objectId: campaign_id || item_id, metadata: { via, queued: out.queued.length, ads: out.ready_ads.length, tasks: out.tasks.length, skipped: out.skipped.length } });
  try {
    const day = todayLocal();
    vault.appendTo({ ...ctx, timezone: TZ }, { folder: 'outputs', slug: `marketing-${day}`, title: `Marketing — ${day}`, heading: 'Aprovações', text: `- ${new Date().toLocaleTimeString('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })} (${via}): ${out.queued.length} post(s) agendado(s), ${out.ready_ads.length} anúncio(s) pronto(s), ${out.tasks.length} tarefa(s) criada(s)${out.skipped.length ? `, ${out.skipped.length} com pendência` : ''}.`, source: 'marketing' });
  } catch { /* cofre opcional */ }
  return out;
}

function createTasks(ctx, it) {
  const passos = Array.isArray(it.action?.passos) && it.action.passos.length ? it.action.passos : [it.title];
  return passos.map((p, i) => {
    const ref = `mkt:${it.id}:${i}`;
    if (q.get('SELECT 1 FROM internal_tasks WHERE business_ref = ?', ref)) return ref;
    insert('internal_tasks', { id: uuid(), organization_id: ctx.orgId, business_ref: ref, title: clampText(`${it.title} — ${p}`, 200), description: `Ação comercial aprovada no marketing do Cérebro (passo ${i + 1} de ${passos.length}).`, product_id: null, owner_hint: null, due_date: it.scheduled_at ? it.scheduled_at.slice(0, 10) : null, status: 'open', created_at: now() });
    return ref;
  });
}

/** Escreve o post no formato do publicador da LORLER (saida/cerebro-<id>.json). */
export function enqueue(it, { retryAt = null } = {}) {
  const local = videoFileFromUrl(it.media_url);
  const post = {
    id: `cerebro-${it.id}`, quando: retryAt || it.scheduled_at, redes: it.networks, texto: it.text || textFor(it, it.networks[0]),
    textos: Object.fromEntries(it.networks.map((n) => [n, textFor(it, n)])), titulo: clampText(it.title, 90),
    ...(it.media_url ? { [it.media_kind === 'video' ? 'video_url' : 'imagem_url']: it.media_url } : {}),
    ...(local ? { midia_arquivo: local } : {}), ...(retryAt ? { tentar_de_novo: retryAt } : {}),
    ...(it.format ? { formato: it.format } : {}), ...(it.link ? { link: it.link } : {}),
    youtube: { privacidade: 'public', tags: ['LORLER', ...(/^(ORBI|TORVEN|RUSTEN|APOLVEN|ANIBI|CIFREN)\b/.exec(it.title || '') || []).slice(0, 1)] },
    tiktok: { modo: 'rascunho' }, origem: 'cerebro',
  };
  fs.writeFileSync(path.join(qdir('saida'), `cerebro-${it.id}.json`), JSON.stringify(post, null, 2));
  q.run("UPDATE mkt_items SET status = 'na_fila', queued_at = ?, updated_at = ? WHERE id = ?", now(), now(), it.id);
}

export function cancel(ctx, id) {
  const it = getItem(ctx, id);
  if (['publicado', 'cancelado', 'concluido'].includes(it.status)) throw errors.conflict(`Já está ${it.status_label}.`);
  if (it.status === 'na_fila') {
    const f = path.join(qdir('saida'), `cerebro-${it.id}.json`);
    if (fs.existsSync(f)) fs.rmSync(f, { force: true }); // ainda não foi para o publicador
    else fs.writeFileSync(path.join(qdir('saida'), `cancelar-cerebro-${it.id}`), now()); // o publicador apaga da fila dele
  }
  q.run("UPDATE mkt_items SET status = 'cancelado', updated_at = ? WHERE id = ?", now(), it.id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'marketing.canceled', objectType: 'mkt_item', objectId: it.id });
  return getItem(ctx, it.id);
}

/** Lê os resultados devolvidos pelo publicador e atualiza cada post. Devolve os que mudaram (para avisar). */
export function processResults() {
  let dir; try { dir = qdir('resultados'); } catch { return []; }
  const changed = [];
  for (const f of fs.readdirSync(dir).filter((x) => /^cerebro-.+\.resultado\.json$/.test(x))) {
    const id = f.replace(/^cerebro-/, '').replace(/\.resultado\.json$/, '');
    const it = q.get('SELECT * FROM mkt_items WHERE id = ?', id); if (!it) continue;
    let est; try { est = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const redes = est.redes || {}; const nets = json(it.networks, []);
    const prev = json(it.result, {});
    // pediu TENTAR DE NOVO: ignora o resultado antigo até o publicador reabrir o post
    if (prev.retry_at && est.tentar_de_novo !== prev.retry_at) {
      if (Date.now() - Date.parse(prev.retry_at) > 20 * 60_000 && !prev.retry_stale) {
        const r2 = { ...prev, retry_stale: true, erro: 'O publicador da VPS não reabriu o post: ele precisa ser atualizado (rode o LIGAR-PUBLICADOR-CEREBRO.bat no PC).' };
        q.run("UPDATE mkt_items SET status = 'erro', result = ?, updated_at = ? WHERE id = ?", JSON.stringify(r2), now(), id);
        changed.push({ ...shapeItem(q.get('SELECT * FROM mkt_items WHERE id = ?', id)), ok: [], bad: nets });
      }
      continue;
    }
    const ok = nets.filter((n) => redes[n]?.situacao === 'publicado');
    const bad = nets.filter((n) => redes[n]?.situacao === 'desistido' || (est.concluido && redes[n]?.situacao !== 'publicado'));
    let status = it.status;
    if (est.erro && !ok.length) status = 'erro';
    else if (ok.length === nets.length) status = 'publicado';
    else if (est.concluido && ok.length) status = 'parcial';
    else if (est.concluido) status = 'erro';
    const result = { redes: Object.fromEntries(nets.map((n) => [n, { situacao: redes[n]?.situacao || 'pendente', url: redes[n]?.url || null, erro: redes[n]?.erro || null }])), erro: est.erro || est.erro_midia || null, atualizado_em: est.atualizado_em || now() };
    // rede esperando um ajuste na conta (ex.: Instagram sem permissão): avisa uma vez com o passo a passo
    const ajuste = nets.filter((n) => redes[n]?.situacao === 'aguardando_ajuste');
    if (prev.aviso_ajuste && ajuste.length) result.aviso_ajuste = prev.aviso_ajuste;
    const avisarAjuste = ajuste.length && !prev.aviso_ajuste && !est.concluido;
    if (avisarAjuste) result.aviso_ajuste = now();
    if (status !== it.status || avisarAjuste || JSON.stringify(result.redes) !== JSON.stringify(prev.redes || {})) {
      q.run('UPDATE mkt_items SET status = ?, result = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(result), now(), id);
      if (['publicado', 'parcial', 'erro'].includes(status) && !it.notified_at) changed.push({ ...shapeItem(q.get('SELECT * FROM mkt_items WHERE id = ?', id)), ok, bad });
      else if (avisarAjuste) changed.push({ ...shapeItem(q.get('SELECT * FROM mkt_items WHERE id = ?', id)), ok, bad, ajuste, aviso: true });
    }
  }
  return changed;
}

/** "TENTAR DE NOVO": devolve à fila só as redes que não saíram (o conteúdo já foi aprovado; não pede PIN de novo). */
export function retry(ctx, id) {
  const it = getItem(ctx, id);
  if (it.kind !== 'post') throw errors.conflict('Só posts podem ser tentados de novo.');
  const falhou = it.networks.filter((n) => it.result?.redes?.[n]?.situacao !== 'publicado');
  if (!['erro', 'parcial', 'na_fila'].includes(it.status) || !falhou.length) throw errors.conflict(`Este post está ${it.status_label}; não há nada para tentar de novo.`);
  if (!it.approved_at) throw errors.conflict('Este post ainda não foi aprovado.');
  const at = new Date().toISOString();
  enqueue(it, { retryAt: at });
  const prev = it.result || {};
  q.run('UPDATE mkt_items SET result = ?, notified_at = NULL, updated_at = ? WHERE id = ?', JSON.stringify({ ...prev, retry_at: at, retry_stale: false, aviso_ajuste: null, erro: null }), now(), it.id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'marketing.retry', objectType: 'mkt_item', objectId: it.id, metadata: { networks: falhou } });
  return { item: getItem(ctx, it.id), networks: falhou };
}
/** Último post que falhou (ou saiu em parte) para o "TENTAR DE NOVO" sem código. */
export function lastFailed(ctx) {
  const r = q.get("SELECT id FROM mkt_items WHERE organization_id = ? AND kind = 'post' AND approved_at IS NOT NULL AND (status IN ('erro','parcial') OR (status = 'na_fila' AND result LIKE '%aguardando_ajuste%')) ORDER BY updated_at DESC LIMIT 1", ctx.orgId);
  return r ? getItem(ctx, r.id) : null;
}

// ---------------- biblioteca de vídeos prontos (enviados do PC pelo ENVIAR-VIDEOS-CEREBRO.bat) ----------------
export function videosDir() {
  if (process.env.LORLER_VIDEOS) return process.env.LORLER_VIDEOS;
  return path.join(path.dirname(queueDir()), 'videos');
}
const SYSTEMS = ['ORBI', 'TORVEN', 'RUSTEN', 'APOLVEN', 'ANIBI', 'CIFREN'];
const VIDEO_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.mp4$/i;
const videoBase = () => `${(config.publicUrl || 'https://cerebro.lorler.com.br').replace(/\/+$/, '')}/api/public/video/`;
export function videoUrl(file) { return videoBase() + encodeURIComponent(file); }
export function videoFileFromUrl(url) {
  const u = String(url || '');
  if (!u.startsWith(videoBase())) return null;
  const f = decodeURIComponent(u.slice(videoBase().length));
  return VIDEO_RE.test(f) ? path.join(videosDir(), f) : null;
}
/** Legendas prontas do mensagens-whatsapp.txt ([arquivo.mp4] seguido do texto). */
function videoCaptions() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(videosDir(), 'mensagens-whatsapp.txt'), 'utf8');
    for (const m of txt.matchAll(/\[([^\]\n]+\.mp4)\]\s*\n([\s\S]*?)(?=\n\s*\[[^\]\n]+\.mp4\]|\n━|$)/g)) out[m[1].trim().toLowerCase()] = m[2].trim();
  } catch { /* sem legendas */ }
  return out;
}
export function listVideos(ctx) {
  let files = [];
  try { files = fs.readdirSync(videosDir()).filter((f) => VIDEO_RE.test(f)).sort(); } catch { return []; }
  const caps = videoCaptions();
  const uses = Object.fromEntries((ctx ? q.all('SELECT file, COUNT(*) AS n, MAX(created_at) AS last FROM mkt_video_uses WHERE organization_id = ? GROUP BY file', ctx.orgId) : []).map((r) => [r.file, r]));
  return files.map((f) => {
    const st = fs.statSync(path.join(videosDir(), f));
    const sistema = SYSTEMS.find((s) => f.toUpperCase().startsWith(s)) || 'LORLER';
    const nome = f.replace(/\.mp4$/i, '').replace(/^[a-z]+-\d+-/i, '').replace(/[-_]+/g, ' ');
    return { file: f, sistema, titulo: `${sistema}: ${nome.charAt(0).toUpperCase()}${nome.slice(1)}`, legenda: caps[f.toLowerCase()] || '', bytes: st.size, url: videoUrl(f), usos: uses[f]?.n || 0, ultimo_uso: uses[f]?.last || null };
  });
}
/** Escolhe um vídeo: pelo nome/sistema pedido ou o menos usado (rodízio). */
export function pickVideo(ctx, { sistema = '', termo = '' } = {}) {
  const all = listVideos(ctx);
  if (!all.length) return null;
  const t = fold(termo).replace(/\b(o|a|do|da|de|video|videos|sobre)\b/g, ' ').trim();
  let list = sistema ? all.filter((v) => v.sistema === String(sistema).toUpperCase()) : all;
  if (t) { const hit = list.filter((v) => t.split(/\s+/).some((w) => w.length > 2 && fold(v.file).includes(w))); if (hit.length) list = hit; }
  if (!list.length) list = all;
  return [...list].sort((a, b) => a.usos - b.usos || String(a.ultimo_uso || '').localeCompare(String(b.ultimo_uso || '')) || a.file.localeCompare(b.file))[0];
}
/** Cria o post com um vídeo da biblioteca (Reels, Facebook, YouTube Shorts e o que mais estiver conectado). */
export function createVideoPost(ctx, video, { networks = null, scheduled_at = null, source = 'conversa' } = {}) {
  const nets = (networks && cleanNets(networks).length ? cleanNets(networks) : ['instagram', 'facebook', 'youtube']);
  const product = SYSTEMS.includes(video.sistema) ? video.sistema : null;
  const dr = draftTexts({ product, topic: video.titulo.replace(/^\w+:\s*/, '') });
  const base = video.legenda || dr.texts.instagram;
  const tags = product ? `\n\n#${product.toLowerCase()} #lorler #gestao` : '\n\n#lorler #gestao';
  const texts = { instagram: clampText(`${base}${tags}`, 2200), facebook: base, youtube: `${base}\n\n${product ? `https://${SYSTEM_SITES[product]}` : 'https://lorler.com.br'}`, tiktok: clampText(base, 2200), linkedin: base };
  const when = scheduled_at || new Date(Date.now() + 10 * 60_000).toISOString();
  const it = createItem(ctx, { kind: 'post', title: video.titulo.slice(0, 120), networks: nets, text: base, texts: Object.fromEntries(nets.map((n) => [n, texts[n]])), media_url: video.url, media_kind: 'video', format: '9x16', scheduled_at: when, link: product ? `https://${SYSTEM_SITES[product]}` : 'https://lorler.com.br' }, { source });
  insert('mkt_video_uses', { organization_id: ctx.orgId, file: video.file, item_id: it.id, created_at: now() });
  return it;
}
export function readVideo(file) {
  const f = String(file || '');
  if (!VIDEO_RE.test(f)) return null;
  const p = path.join(videosDir(), f);
  try { const st = fs.statSync(p); return st.isFile() ? { path: p, bytes: st.size } : null; } catch { return null; }
}

// ---------------- mídia enviada (foto/vídeo do WhatsApp ou do painel), servida em link público para as redes ----------------
const MIME_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };
export function saveMedia(ctx, buffer, mime, filename = '') {
  const m = String(mime || '').split(';')[0].trim().toLowerCase();
  if (!MIME_EXT[m]) throw errors.invalid('Formato não aceito (use JPG, PNG, WEBP ou MP4).');
  if (!buffer?.length || buffer.length > 16 * 1024 * 1024) throw errors.invalid('Arquivo vazio ou maior que 16 MB.');
  const id = crypto.randomBytes(16).toString('hex');
  // (insert() serializa objetos como JSON; o binário vai direto)
  q.run('INSERT INTO mkt_media (id, organization_id, created_by, filename, mime, bytes, sha256, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, ctx.orgId, ctx.userId || null, clampText(String(filename || `midia.${MIME_EXT[m]}`), 120), m, buffer.length, crypto.createHash('sha256').update(buffer).digest('hex'), new Uint8Array(buffer), now());
  return { id, url: mediaUrl(id, m), kind: m.startsWith('video') ? 'video' : 'imagem', bytes: buffer.length };
}
export function mediaUrl(id, mime) { return `${(config.publicUrl || 'https://cerebro.lorler.com.br').replace(/\/+$/, '')}/api/public/midia/${id}.${MIME_EXT[mime] || 'bin'}`; }
export function readMedia(idWithExt) {
  const id = String(idWithExt || '').replace(/\.[a-z0-9]{2,4}$/i, '');
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return q.get('SELECT mime, data, bytes FROM mkt_media WHERE id = ?', id) || null;
}

/** Próximos itens (para o HUD, a agenda e o JARVIS). */
export function upcoming(ctx, { days = 7, limit = 20 } = {}) {
  const from = new Date(Date.now() - 2 * 3600_000).toISOString(); const to = new Date(Date.now() + days * 86400_000).toISOString();
  return q.all("SELECT * FROM mkt_items WHERE organization_id = ? AND status NOT IN ('cancelado') AND scheduled_at >= ? AND scheduled_at < ? ORDER BY scheduled_at LIMIT ?", ctx.orgId, from, to, limit).map(shapeItem);
}
export function pendingApproval(ctx) {
  return {
    campaigns: q.all("SELECT * FROM mkt_campaigns WHERE organization_id = ? AND wa_code IS NOT NULL AND status = 'rascunho' ORDER BY updated_at DESC LIMIT 10", ctx.orgId).map(shapeCampaign),
    items: q.all("SELECT * FROM mkt_items WHERE organization_id = ? AND status = 'aguardando_aprovacao' AND campaign_id IS NULL ORDER BY scheduled_at LIMIT 20", ctx.orgId).map(shapeItem),
  };
}
export function findByCode(orgId, code) {
  const c = String(code || '').toUpperCase();
  const camp = q.get('SELECT id FROM mkt_campaigns WHERE organization_id = ? AND wa_code = ?', orgId, c);
  if (camp) return { campaign_id: camp.id };
  const it = q.get('SELECT id FROM mkt_items WHERE organization_id = ? AND wa_code = ?', orgId, c);
  return it ? { item_id: it.id } : null;
}
