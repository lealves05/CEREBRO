// Reunião de marketing com o Cérebro (WhatsApp, voz ou painel). Ele conduz como um gerente de marketing:
// objetivo → sistema → oferta → público → período → verba de anúncio → redes → posts por semana → plano.
// Na revisão você ajusta por mensagem ("tira o 3", "muda o 2 para sexta 19h", "texto do 1: …") e diz "aprovar".
// "Aprovar" aqui só põe o plano para aprovação: no WhatsApp vale com APROVAR <código> + PIN; no painel, com a senha.
// Depois de aprovado, os posts entram na fila do publicador e saem sozinhos no horário. A ata vai para o cofre.
import { q, insert, uuid, now, json } from '../db.js';
import { clampText } from '../lib/util.js';
import * as mkt from './marketing.js';
import * as vault from './vault.js';

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const SYSTEMS = ['ORBI', 'TORVEN', 'RUSTEN', 'APOLVEN', 'ANIBI', 'CIFREN'];
const STEPS = ['objective', 'product_code', 'offer', 'audience', 'period', 'budget_cents', 'networks', 'posts_per_week'];
const ASK = {
  objective: 'Qual é o objetivo? Vender mais, conseguir novos contatos (leads), divulgar a marca, engajar ou reativar clientes antigos?',
  product_code: 'Vamos trabalhar qual sistema? ORBI, TORVEN, RUSTEN, APOLVEN, ANIBI, CIFREN — ou a LORLER no geral?',
  offer: 'Tem alguma oferta pra campanha? Ex.: "30 dias grátis", "20% no plano anual". Se não tiver, diz "sem oferta".',
  audience: 'Pra quem é? Ex.: "donos de barbearia de Campinas". Se quiser o público padrão do sistema, diz "padrão".',
  period: 'Por quanto tempo? Ex.: "2 semanas", "30 dias" ou "até 30/11".',
  budget_cents: 'Vai ter anúncio pago? Quanto no total? Ex.: "R$ 300". Se não, diz "sem anúncio". (Eu monto o anúncio; quem sobe e paga é você.)',
  networks: 'Em quais redes? Instagram, Facebook, TikTok, LinkedIn — ou "todas".',
  posts_per_week: 'Quantos posts por semana? (o normal é 3)',
};
const START = /\b(reuniao|reuniao de marketing|vamos (fazer|planejar|montar) (uma )?(campanha|reuniao|plano)|nova campanha|plano (de marketing|comercial)|planejar (o )?marketing|montar (uma )?campanha)\b/;

export function active(ctx) {
  return q.get("SELECT * FROM mkt_meetings WHERE user_id = ? AND organization_id = ? AND status = 'aberta' AND updated_at > ? ORDER BY updated_at DESC LIMIT 1", ctx.userId, ctx.orgId, new Date(Date.now() - 12 * 3600_000).toISOString()) || null;
}
export const wantsStart = (text) => START.test(fold(text));

// ---------------- leitura das respostas ----------------
export function parseObjective(f) {
  if (/reativ|volta|antig|cancel|parad/.test(f)) return 'reativacao';
  if (/lead|contato|cadastr|demonstra|captar|capta/.test(f)) return 'leads';
  if (/marca|divulg|conhec|alcance|lancament|lanca/.test(f)) return 'reconhecimento';
  if (/engaj|seguidor|curtid|comentar/.test(f)) return 'engajamento';
  if (/vend|cliente|assinat|fatur|fechar|conver/.test(f)) return 'vendas';
  return null;
}
export function parseProduct(f) { const s = SYSTEMS.find((x) => new RegExp(`\\b${x.toLowerCase()}\\b`).test(f)); if (s) return s; if (/\b(lorler|geral|todos|todas|empresa)\b/.test(f)) return 'LORLER'; return null; }
export function parseBudget(f) {
  if (/\b(sem (anuncio|verba|dinheiro|pago)|nao|zero|nada|organico)\b/.test(f) && !/r\$|\d/.test(f)) return 0;
  const m = /r\$\s*([\d.]+(?:,\d{1,2})?)|([\d.]+(?:,\d{1,2})?)\s*(reais|conto|pila)/.exec(f) || (/^\s*([\d.]+(?:,\d{1,2})?)\s*$/.exec(f));
  if (!m) return null;
  const v = (m[1] || m[2]).replace(/\./g, '').replace(',', '.');
  return Math.round(Number(v) * 100);
}
export function parseNetworks(f) {
  if (/\b(todas|todos|tudo|as quatro|4 redes)\b/.test(f)) return mkt.PLAN_NETWORKS;
  const out = [];
  if (/insta|ig\b/.test(f)) out.push('instagram'); if (/face|fb\b/.test(f)) out.push('facebook'); if (/tik ?tok/.test(f)) out.push('tiktok'); if (/linked ?in/.test(f)) out.push('linkedin'); if (/youtube|shorts/.test(f)) out.push('youtube');
  return out.length ? out : null;
}
export function parsePeriod(f) {
  const start = mkt.todayLocal();
  const add = (n) => { const d = new Date(`${start}T12:00:00-03:00`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const ate = /ate (?:o dia )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(f);
  if (ate) { const y = ate[3] ? (ate[3].length === 2 ? `20${ate[3]}` : ate[3]) : start.slice(0, 4); return { start_date: add(1), end_date: `${y}-${ate[2].padStart(2, '0')}-${ate[1].padStart(2, '0')}` }; }
  const m = /(\d+|uma|um|duas|dois|tres)\s*(dia|semana|mes)/.exec(f);
  if (m) { const n = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3 }[m[1]] || Number(m[1]); const days = m[2] === 'dia' ? n : m[2] === 'semana' ? n * 7 : n * 30; return { start_date: add(1), end_date: add(Math.max(1, days)) }; }
  if (/\b(semana que vem|proxima semana)\b/.test(f)) return { start_date: add(1), end_date: add(7) };
  if (/\b(mes|mês)\b/.test(f)) return { start_date: add(1), end_date: add(30) };
  return null;
}
export function parsePerWeek(f) { const m = /(\d+)\s*(posts?|vezes|por semana|x)/.exec(f) || /^\s*(\d+)\s*$/.exec(f); if (m) return Math.min(7, Math.max(1, Number(m[1]))); if (/\b(normal|padrao|tanto faz)\b/.test(f)) return 3; return null; }

/** "sexta 19h", "amanhã 18:30", "20/11 às 9h" → ISO (Brasília). */
export function parseWhen(text, base = mkt.todayLocal()) {
  const f = fold(text);
  let date = null;
  const dm = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(f);
  const add = (n) => { const d = new Date(`${base}T12:00:00-03:00`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  if (dm) { const y = dm[3] ? (dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : base.slice(0, 4); date = `${y}-${dm[2].padStart(2, '0')}-${dm[1].padStart(2, '0')}`; }
  else if (/\bdepois de amanha\b/.test(f)) date = add(2);
  else if (/\bamanha\b/.test(f)) date = add(1);
  else if (/\bhoje\b/.test(f)) date = base;
  else {
    const wd = [['domingo', 0], ['segunda', 1], ['terca', 2], ['quarta', 3], ['quinta', 4], ['sexta', 5], ['sabado', 6]].find(([w]) => new RegExp(`\\b${w}`).test(f));
    if (wd) { const cur = new Date(`${base}T12:00:00-03:00`).getUTCDay(); let n = (wd[1] - cur + 7) % 7; if (n === 0) n = 7; date = add(n); }
  }
  const tm = /(?:as |às |a partir das )?\b(\d{1,2})\s*(?:h|:|horas?)\s*(\d{2})?\b/.exec(f);
  const time = tm ? `${tm[1].padStart(2, '0')}:${(tm[2] || '00').padStart(2, '0')}` : null;
  if (!date && !time) return null;
  return { date: date || add(1), time: time && Number(time.slice(0, 2)) < 24 ? time : null };
}

/** Lê tudo que der de uma frase só ("campanha do RUSTEN pra vender mais, 30 dias grátis, 2 semanas, R$ 300, todas as redes"). */
export function extractAll(text) {
  const f = fold(text); const d = {};
  const o = parseObjective(f); if (o) d.objective = o;
  const p = SYSTEMS.find((x) => new RegExp(`\\b${x.toLowerCase()}\\b`).test(f)) || (/\blorler\b/.test(f) ? 'LORLER' : null); if (p) d.product_code = p;
  // "30 dias grátis" é oferta, não período
  const semOferta = f.replace(/\d+\s*(dias?|mes(es)?|semanas?)\s*(gratis|gratuitos?|de teste|free|de graca)/g, ' ');
  const per = parsePeriod(semOferta); if (per) Object.assign(d, per, { period: true });
  const b = /r\$|reais|sem anuncio|sem verba/.test(f) ? parseBudget(f) : null; if (b != null) d.budget_cents = b;
  const n = parseNetworks(f); if (n) d.networks = n;
  const w = /por semana/.test(f) ? parsePerWeek(f) : null; if (w) d.posts_per_week = w;
  const of = /(oferta|promocao|promo|desconto|gratis|gratuito|cupom)[^,.;]*/.exec(f); if (of) d.offer = clampText(text.slice(of.index, of.index + of[0].length).trim(), 200);
  return d;
}

// ---------------- conversa ----------------
function save(m, patch) {
  const data = { ...json(m.data, {}), ...(patch.data || {}) };
  const log = [...json(m.log, []), ...(patch.log || [])].slice(-60);
  q.run('UPDATE mkt_meetings SET step = ?, data = ?, log = ?, campaign_id = ?, status = ?, updated_at = ? WHERE id = ?', patch.step ?? m.step, JSON.stringify(data), JSON.stringify(log), patch.campaign_id ?? m.campaign_id, patch.status ?? m.status, now(), m.id);
  return { ...m, step: patch.step ?? m.step, data: JSON.stringify(data), log: JSON.stringify(log), campaign_id: patch.campaign_id ?? m.campaign_id };
}
const nextStep = (data) => STEPS.find((s) => (s === 'period' ? !data.period : data[s] === undefined)) || 'plan';

export function start(ctx, text, channel) {
  const id = uuid();
  const data = extractAll(text);
  insert('mkt_meetings', { id, organization_id: ctx.orgId, user_id: ctx.userId, channel, step: 'objective', data: JSON.stringify(data), status: 'aberta', log: JSON.stringify([{ who: 'voce', t: text, at: now() }]), created_at: now(), updated_at: now() });
  const m = q.get('SELECT * FROM mkt_meetings WHERE id = ?', id);
  const step = nextStep(data);
  if (step === 'plan') return buildPlan(ctx, save(m, { step }), channel);
  const got = Object.keys(data).filter((k) => STEPS.includes(k) || k === 'period').length;
  save(m, { step });
  return { reply: `Bora! Reunião de marketing aberta.${got ? ' Já anotei o que você falou.' : ''} ${ASK[step]}`, intent: 'answer', meeting: id };
}

function fill(step, text) {
  const f = fold(text);
  const skip = /^(padrao|pula|tanto faz|voce decide|decide ai|nao sei|qualquer)\b/.test(f);
  switch (step) {
    case 'objective': return parseObjective(f) || (skip ? 'vendas' : null);
    case 'product_code': return parseProduct(f) || (skip ? 'LORLER' : null);
    case 'offer': return /^(sem|nao|nenhuma|nada)\b/.test(f) || skip ? '' : clampText(text.trim(), 200);
    case 'audience': return /^(padrao|pula|tanto faz|o de sempre)\b/.test(f) || skip ? '' : clampText(text.trim(), 200);
    case 'period': return parsePeriod(f) || (skip ? parsePeriod('2 semanas') : null);
    case 'budget_cents': { const b = parseBudget(f); return b != null ? b : skip ? 0 : null; }
    case 'networks': return parseNetworks(f) || (skip ? mkt.PLAN_NETWORKS : null);
    case 'posts_per_week': return parsePerWeek(f) || (skip ? 3 : null);
    default: return null;
  }
}

function buildPlan(ctx, m, channel) {
  const d = json(m.data, {});
  const camp = mkt.planCampaign(ctx, { ...d, product_code: d.product_code === 'LORLER' ? null : d.product_code }, { source: `reuniao:${channel}` });
  save(m, { step: 'review', campaign_id: camp.id, log: [{ who: 'cerebro', t: `plano ${camp.name}`, at: now() }] });
  const posts = camp.items.filter((i) => i.kind === 'post').length; const ads = camp.items.filter((i) => i.kind === 'anuncio').length; const acts = camp.items.filter((i) => i.kind === 'acao').length;
  const warn = camp.items.filter((i) => i.issues.length).length;
  return {
    reply: `Fechei o plano "${camp.name}": ${posts} post${posts === 1 ? '' : 's'}${ads ? `, 1 anúncio de ${camp.budget}` : ''} e ${acts} ações comerciais.\n\n${mkt.summarizeCampaign(camp)}\n\n${warn ? `⚠️ ${warn} item(ns) com pendência (ex.: falta mídia). ` : ''}Quer ajustar? Ex.: "tira o 3", "muda o 2 para sexta 19h", "texto do 1: …". Mande uma foto ou vídeo que eu coloco nos posts. Quando estiver bom, diga "aprovar".`,
    intent: 'answer', campaign_id: camp.id, meeting: m.id,
  };
}

function itemByNumber(campId, n) { const items = q.all('SELECT * FROM mkt_items WHERE campaign_id = ? ORDER BY COALESCE(scheduled_at, created_at)', campId); return items[n - 1] || null; }

function review(ctx, m, text, channel) {
  const f = fold(text);
  const camp = mkt.getCampaign(ctx, m.campaign_id);
  const n = Number((/\b(?:o |a |item |post |numero )?(\d{1,2})\b/.exec(f) || [])[1] || 0);
  if (/^(aprovar|aprova|pode aprovar|aprovado|fechado|manda ver|pode mandar|pode publicar|ta aprovado)\b/.test(f)) {
    const r = mkt.submit(ctx, { campaign_id: camp.id });
    closeWithMinutes(ctx, m, camp, r.code);
    const posts = r.campaign.items.filter((i) => i.kind === 'post' && i.status === 'aguardando_aprovacao').length;
    return { reply: channel === 'whatsapp' ? `Perfeito. Para confirmar, responda *APROVAR ${r.code}* e depois o seu PIN. Aí os ${posts} posts entram na fila e saem sozinhos no horário, as ações viram tarefas e o anúncio fica pronto pra você subir.` : `Perfeito, o plano foi para aprovação (código ${r.code}). Confirme no painel, em Marketing, com a sua senha — ou mande APROVAR ${r.code} no WhatsApp com o PIN.`, intent: 'answer', campaign_id: camp.id, approval_code: r.code };
  }
  if (/^(encerr|cancel|esquece|deixa pra la|fecha a reuniao|termina)/.test(f)) { save(m, { status: 'encerrada' }); return { reply: 'Reunião encerrada. O plano ficou salvo como rascunho no Marketing; quando quiser retomar é só falar.', intent: 'answer' }; }
  if (n && /\b(tira|remove|exclui|apaga|sem o|cancela)\b/.test(f)) { const it = itemByNumber(camp.id, n); if (!it) return { reply: `Não achei o item ${n}.`, intent: 'answer' }; q.run("UPDATE mkt_items SET status = 'cancelado', updated_at = ? WHERE id = ?", now(), it.id); return { reply: `Tirei o ${n} (${clampText(it.title, 60)}).`, intent: 'answer' }; }
  if (n && /\b(texto|legenda)\b/.test(f) && /:/.test(text)) { const it = itemByNumber(camp.id, n); if (!it) return { reply: `Não achei o item ${n}.`, intent: 'answer' }; const t = text.slice(text.indexOf(':') + 1).trim(); mkt.updateItem(ctx, it.id, { text: t, texts: {} }); return { reply: `Troquei o texto do ${n}.`, intent: 'answer' }; }
  if (n && /\b(muda|troca|passa|move|coloca|joga|para|pra)\b/.test(f)) {
    const it = itemByNumber(camp.id, n); const w = parseWhen(text.replace(/\b\d{1,2}\b(?=\s*(para|pra))/, ''));
    if (it && w) { const cur = it.scheduled_at ? new Date(it.scheduled_at) : null; const hh = w.time || (cur ? cur.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) : '18:30'); const up = mkt.updateItem(ctx, it.id, { scheduled_at: mkt.atLocal(w.date, hh) }); return { reply: `Feito: o ${n} vai ${mkt.fmtWhen(up.scheduled_at)}.`, intent: 'answer' }; }
  }
  if (/\b(adiciona|acrescenta|inclui|mais um|outro) (um )?post\b/.test(f)) {
    const w = parseWhen(text) || { date: camp.start_date, time: '18:30' };
    const topic = (/sobre (.+)$/i.exec(text) || [])[1] || '';
    const dr = mkt.draftTexts({ product: camp.product_code, topic, offer: camp.offer, libIndex: camp.items.length });
    mkt.createItem(ctx, { kind: 'post', title: dr.title, networks: camp.networks, text: dr.text, texts: dr.texts, media_url: dr.media_url, media_kind: dr.media_kind, format: dr.format, scheduled_at: mkt.atLocal(w.date, w.time || '18:30') }, { source: `reuniao:${channel}`, campaignId: camp.id });
    return { reply: 'Incluí mais um post no plano.', intent: 'answer' };
  }
  if (/\b(mostra|ver|lista|como ficou|resumo)\b/.test(f)) return { reply: mkt.summarizeCampaign(mkt.getCampaign(ctx, camp.id)), intent: 'answer' };
  return null; // não era ajuste: deixa a conversa normal responder (a reunião continua aberta)
}

function closeWithMinutes(ctx, m, camp, code) {
  save(m, { status: 'encerrada', log: [{ who: 'cerebro', t: `enviado para aprovação ${code}`, at: now() }] });
  try {
    const day = mkt.todayLocal(); const d = json(m.data, {});
    const c = mkt.getCampaign(ctx, camp.id);
    vault.writeNote({ ...ctx, timezone: 'America/Sao_Paulo' }, {
      folder: 'outputs', slug: `reuniao-marketing-${day}-${c.id.slice(0, 6)}`, title: `Reunião de marketing — ${c.name}`, source: 'reuniao',
      content: `# Reunião de marketing — ${c.name}\n\n**Data:** ${day} · **Canal:** ${m.channel} · **Código de aprovação:** ${code}\n\n## Decisões\n- Objetivo: ${d.objective || '—'}\n- Sistema: ${d.product_code ? `[[${d.product_code}]]` : 'LORLER'}\n- Oferta: ${c.offer || 'sem oferta'}\n- Público: ${c.audience || 'padrão do sistema'}\n- Período: ${c.start_date.split('-').reverse().join('/')} a ${c.end_date.split('-').reverse().join('/')}\n- Anúncio: ${c.budget_cents ? c.budget : 'sem anúncio'}\n- Redes: ${c.networks.map((x) => mkt.NETWORK_LABEL[x]).join(', ')}\n\n## Plano\n${mkt.summarizeCampaign(c, { max: 60 })}\n\n## Próximo passo\nAprovar com o código ${code} (PIN no WhatsApp ou senha no painel). Depois disso os posts saem sozinhos no horário.\n`,
    });
  } catch { /* cofre opcional */ }
}

/** Uma mensagem dentro da reunião (ou que abre uma). Devolve null quando não é assunto da reunião. */
export async function handle(ctx, text, channel = 'whatsapp') {
  let m = active(ctx);
  if (!m) return wantsStart(text) ? start(ctx, text, channel) : null;
  save(m, { log: [{ who: 'voce', t: clampText(text, 400), at: now() }] });
  if (m.step === 'review') return review(ctx, m, text, channel);
  const f = fold(text);
  if (/^(encerr|cancel|esquece|deixa pra la)/.test(f)) { save(m, { status: 'cancelada' }); return { reply: 'Beleza, reunião cancelada. Quando quiser, é só chamar.', intent: 'answer' }; }
  // aproveita o que vier a mais na resposta ("ORBI, 2 semanas, R$ 200")
  const extra = extractAll(text);
  const val = fill(m.step, text);
  const data = { ...extra };
  if (val !== null) { if (m.step === 'period') Object.assign(data, val, { period: true }); else data[m.step] = val; }
  else if (!Object.keys(extra).length) return { reply: `Não entendi. ${ASK[m.step]}`, intent: 'answer' };
  m = save(m, { data });
  const step = nextStep(json(m.data, {}));
  if (step === 'plan') return buildPlan(ctx, save(m, { step }), channel);
  save(m, { step });
  return { reply: ASK[step], intent: 'answer' };
}

/** Foto ou vídeo recebido: vai para os posts do plano em revisão que estão sem mídia (ou para o último rascunho). */
export function attachMedia(ctx, media) {
  const m = active(ctx);
  const campId = m?.campaign_id || null;
  const rows = campId
    ? q.all("SELECT id FROM mkt_items WHERE campaign_id = ? AND kind IN ('post','anuncio') AND status IN ('rascunho','aguardando_aprovacao','erro') AND (media_url = '' OR media_url LIKE 'https://cdn.jsdelivr.net/%') ORDER BY scheduled_at", campId)
    : q.all("SELECT id FROM mkt_items WHERE organization_id = ? AND created_by = ? AND kind = 'post' AND status IN ('rascunho','aguardando_aprovacao') AND created_at > ? ORDER BY created_at DESC LIMIT 1", ctx.orgId, ctx.userId, new Date(Date.now() - 86400_000).toISOString());
  const target = rows.slice(0, campId ? 3 : 1);
  for (const r of target) mkt.updateItem(ctx, r.id, { media_url: media.url, media_kind: media.kind, format: media.kind === 'video' ? '9x16' : '4x5' });
  return target.length;
}
