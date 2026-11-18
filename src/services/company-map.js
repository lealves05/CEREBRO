// Mapa da empresa: o Cérebro como "equipe" de agentes por departamento, com rotinas que rodam sozinhas.
//   Departamentos: CRM, Tarefas, Financeiro, Segurança, Traqueamento, Educação (retenção), Marketing e Cofre.
//   Rotinas autônomas (no fuso da organização):
//     contatos  06:00  Captador de Leads   → cadastros novos nas últimas 24 h (Master) e quem está terminando o teste
//     caixa     09:00  Financeiro          → recebido ontem/hoje, em atraso e vencendo (Master)
//     post      12:00  Social Media        → post do dia pronto para aprovar: arte nova ou vídeo da biblioteca, dia sim dia não (dias úteis; pula se já houver post do dia)
//     sites     a cada hora  Guardião      → confere se os sites dos sistemas estão no ar; avisa quando cai e quando volta
//     risco     seg 10:30  Retenção        → clientes sem acesso há 7 dias ou com o teste acabando
//   Tudo vai para a atividade do mapa e, se o WhatsApp do dono estiver ligado, chega como mensagem.
//   As rotinas só leem e preparam; o que muda alguma coisa (post, Master) continua pedindo a sua aprovação.
import { q, uuid, now, json } from '../db.js';
import { clampText, errors } from '../lib/util.js';
import { call as masterCall, isConfigured as masterConfigured } from '../connectors/master.js';
import * as wa from '../connectors/whatsapp.js';
import * as mkt from './marketing.js';

export const mapHooks = { master: (...a) => masterCall(...a), fetch: (...a) => fetch(...a), send: null, now: () => new Date() };
const TZ = 'America/Sao_Paulo';
export const SITES = [
  ['LORLER', 'https://lorler.com.br'], ['ORBI', 'https://orbi.lorler.com.br'], ['TORVEN', 'https://torven.lorler.com.br'],
  ['RUSTEN', 'https://rusten.lorler.com.br'], ['APOLVEN', 'https://apolven.lorler.com.br'], ['ANIBI', 'https://anibi.lorler.com.br'],
  ['CIFREN', 'https://cifren.lorler.com.br'], ['Master', 'https://master.lorler.com.br'],
];
export const JOBS = {
  contatos: { label: 'Contatos novos', agent: 'Captador de Leads', dept: 'crm', time: '06:00', when: 'madrugada' },
  caixa: { label: 'Caixa do dia', agent: 'Financeiro', dept: 'financeiro', time: '09:00', when: '9h' },
  post: { label: 'Post do dia', agent: 'Social Media', dept: 'marketing', time: '12:00', when: 'meio-dia', weekdays: true },
  sites: { label: 'Sites no ar', agent: 'Guardião', dept: 'seguranca', time: null, when: 'de hora em hora' },
  risco: { label: 'Clientes em risco', agent: 'Retenção', dept: 'educacao', time: '10:30', when: 'segundas', mondays: true },
};
export const DEPTS = [
  { id: 'crm', n: '01', name: 'CRM', verb: 'vender', agents: ['Captador de Leads', 'Qualificador de Contatos', 'Consultor de Fechamento'] },
  { id: 'tarefas', n: '02', name: 'Tarefas', verb: 'organizar', agents: ['Organizador do Dia', 'Sala de Decisão'] },
  { id: 'financeiro', n: '03', name: 'Financeiro', verb: 'controlar', agents: ['Financeiro', 'Cobrança'] },
  { id: 'seguranca', n: '04', name: 'Segurança', verb: 'proteger', agents: ['Guardião dos Sites', 'Auditoria'] },
  { id: 'traqueamento', n: '05', name: 'Traqueamento', verb: 'medir', agents: ['Gestor de Métricas'] },
  { id: 'educacao', n: '06', name: 'Educação', verb: 'reter', agents: ['Retenção', 'Vídeo-aulas'] },
  { id: 'marketing', n: '07', name: 'Marketing', verb: 'divulgar', agents: ['Social Media', 'Designer de Artes', 'Planejador de Campanhas'] },
  { id: 'vault', n: '08', name: 'Cofre', verb: 'guardar', agents: ['Segundo Cérebro'] },
];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
function localParts(d = mapHooks.now(), tz = TZ) {
  const o = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${o.year}-${o.month}-${o.day}`, minutes: Number(o.hour) * 60 + Number(o.minute), weekday: o.weekday };
}
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const money = (v) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const asList = (r) => (Array.isArray(r) ? r : r?.items || []);

// ---------------- atividade ----------------
export function log(orgId, dept, agent, text) {
  q.run('INSERT INTO company_activity (id, organization_id, dept, agent, text, created_at) VALUES (?, ?, ?, ?, ?, ?)', uuid(), orgId, dept, agent, clampText(text, 400), now());
  q.run("DELETE FROM company_activity WHERE organization_id = ? AND created_at < ?", orgId, new Date(Date.now() - 30 * 86400_000).toISOString());
}
export const activity = (ctx, limit = 20) => q.all('SELECT dept, agent, text, created_at FROM company_activity WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?', ctx.orgId, limit);

// ---------------- configuração das rotinas ----------------
function jobRow(orgId, job) {
  let r = q.get('SELECT * FROM autopilot_jobs WHERE organization_id = ? AND job = ?', orgId, job);
  if (!r) { q.run('INSERT OR IGNORE INTO autopilot_jobs (organization_id, job, enabled, at_time, updated_at) VALUES (?, ?, 1, ?, ?)', orgId, job, JOBS[job].time, now()); r = q.get('SELECT * FROM autopilot_jobs WHERE organization_id = ? AND job = ?', orgId, job); }
  return r;
}
export function jobs(ctx) {
  const lp = localParts();
  return Object.entries(JOBS).map(([k, d]) => {
    const r = jobRow(ctx.orgId, k);
    const t = r.at_time || d.time;
    const today = d.time ? r.last_run === lp.date : !!r.last_run && Date.now() - Date.parse(r.last_run) < 3600_000;
    return { job: k, label: d.label, agent: d.agent, dept: d.dept, when: t ? `${t}${d.mondays ? ' (seg)' : d.weekdays ? ' (dias úteis)' : ''}` : d.when, time: t, enabled: !!r.enabled, done_today: today, last_run: r.last_run, last_result: r.last_result };
  });
}
export function setJob(ctx, job, { enabled, time } = {}) {
  if (!JOBS[job]) throw errors.invalid('Rotina desconhecida.');
  const r = jobRow(ctx.orgId, job);
  if (time != null && JOBS[job].time && !HHMM.test(String(time))) throw errors.invalid('Horário inválido (use HH:MM).');
  q.run('UPDATE autopilot_jobs SET enabled = ?, at_time = ?, updated_at = ? WHERE organization_id = ? AND job = ?', enabled == null ? r.enabled : enabled ? 1 : 0, time != null && JOBS[job].time ? String(time) : r.at_time, now(), ctx.orgId, job);
  return jobs(ctx).find((j) => j.job === job);
}

// ---------------- quem recebe (dono com WhatsApp) ----------------
function ownerCtx(orgId) {
  const m = q.get("SELECT m.user_id, m.role, m.id AS member_id FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.role = 'owner' AND m.status = 'active' AND u.status = 'active' ORDER BY m.created_at LIMIT 1", orgId);
  if (!m) return null;
  return { orgId, userId: m.user_id, role: 'owner', memberId: m.member_id, productIds: null, channel: 'rotina' };
}
async function tell(ctx, text) {
  if (mapHooks.send) return mapHooks.send(ctx, text);
  const link = q.get("SELECT wa_id FROM whatsapp_links WHERE user_id = ? AND organization_id = ? AND status = 'verified' AND wa_id IS NOT NULL AND notify = 1", ctx.userId, ctx.orgId);
  if (!link || !wa.isConfigured()) return false;
  try { await wa.sendText(link.wa_id, text); return true; } catch { return false; }
}

// ---------------- as rotinas ----------------
async function tenants(qs = '') { return asList(await mapHooks.master(`/tenants${qs ? `?${qs}` : ''}`)); }

export const RUN = {
  async contatos(ctx) {
    if (!masterConfigured()) return { text: 'Área Master desligada.', quiet: true };
    const all = await tenants();
    const since = Date.now() - 86400_000;
    const novos = all.filter((t) => Date.parse(t.created_at) >= since);
    const acabando = all.filter((t) => t.trial_type && t.trial_ends_at && Date.parse(t.trial_ends_at) - Date.now() < 3 * 86400_000 && Date.parse(t.trial_ends_at) > Date.now());
    const txt = `${novos.length} contato${novos.length === 1 ? '' : 's'} novo${novos.length === 1 ? '' : 's'} nas últimas 24 h${acabando.length ? ` · ${acabando.length} com o teste acabando` : ''}`;
    log(ctx.orgId, 'crm', 'Captador de Leads', txt);
    const lines = [...novos.slice(0, 8).map((t) => `• ${t.name} (${String(t.product || '').toUpperCase()})${t.phone ? ` — ${t.phone}` : ''}`), ...acabando.slice(0, 5).map((t) => `⏳ ${t.name}: teste acaba em ${new Date(t.trial_ends_at).toLocaleDateString('pt-BR', { timeZone: TZ })}`)];
    return { text: `🌅 *Captador de Leads*: ${txt}.${lines.length ? `\n${lines.join('\n')}` : ''}${acabando.length ? '\nQuer que eu prorrogue algum teste? É só dizer "prorrogue o teste da …".' : ''}`, quiet: !novos.length && !acabando.length };
  },
  async caixa(ctx) {
    if (!masterConfigured()) return { text: 'Área Master desligada.', quiet: true };
    const pays = asList(await mapHooks.master('/payments?status=CONFIRMED'));
    const lp = localParts(); const ontem = localParts(new Date(Date.now() - 86400_000)).date;
    const dia = (p) => (p.paid_at ? localParts(new Date(p.paid_at)).date : '');
    const hoje = pays.filter((p) => dia(p) === lp.date); const anteontem = pays.filter((p) => dia(p) === ontem);
    const soma = (l) => l.reduce((s, p) => s + Number(p.amount || 0), 0);
    const atraso = await tenants('status=INADIMPLENTE').catch(() => []);
    const venc = await tenants('expiring=1').catch(() => []);
    const txt = `caixa conferido: ${money(soma(anteontem))} ontem, ${money(soma(hoje))} hoje · ${atraso.length} em atraso · ${venc.length} vencendo`;
    log(ctx.orgId, 'financeiro', 'Financeiro', txt);
    return { text: `💰 *Financeiro*: ${txt}.${atraso.length ? `\nEm atraso: ${atraso.slice(0, 6).map((t) => t.name).join(', ')}.` : ''}${venc.length ? `\nVencendo: ${venc.slice(0, 6).map((t) => t.name).join(', ')}.` : ''}`, data: { ontem: soma(anteontem), hoje: soma(hoje) } };
  },
  async post(ctx) {
    const lp = localParts();
    const jaTem = q.get("SELECT 1 FROM mkt_items WHERE organization_id = ? AND kind = 'post' AND status NOT IN ('cancelado','erro') AND scheduled_at >= ? AND scheduled_at < ? LIMIT 1", ctx.orgId, mkt.atLocal(lp.date, '00:00'), new Date(Date.parse(mkt.atLocal(lp.date, '00:00')) + 2 * 86400_000).toISOString());
    if (jaTem) { log(ctx.orgId, 'marketing', 'Social Media', 'já existe post para hoje/amanhã — não criei outro'); return { text: '', quiet: true }; }
    const owner = await import('./owner-actions.js');
    const systems = ['ORBI', 'TORVEN', 'RUSTEN', 'APOLVEN', 'ANIBI', 'CIFREN'];
    const dia = Math.floor(Date.parse(lp.date) / 86400_000);
    const sistema = systems[dia % systems.length];
    // dia sim, dia não: vídeo pronto da biblioteca (Reels/Shorts) quando houver; nos outros, arte nova
    const usarVideo = dia % 2 === 1 && mkt.listVideos(ctx).some((v) => v.sistema === sistema);
    const r = await owner.perform({ ...ctx, channel: 'whatsapp' }, usarVideo ? 'postar_video' : 'gerar_imagem', { sistema });
    log(ctx.orgId, 'marketing', 'Social Media', `post do dia (${sistema}, ${usarVideo ? 'vídeo' : 'arte'}) pronto para aprovar`);
    return { text: `📣 *Post do dia*: ${r?.reply || ''}` };
  },
  async sites(ctx) {
    const row = jobRow(ctx.orgId, 'sites'); const prev = new Set(json(row.state, {}).fora || []);
    const res = await Promise.all(SITES.map(async ([n, url]) => {
      try { const r = await mapHooks.fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(12000) }); return [n, r.status < 500 || r.status === 503 && n === 'Master']; }
      catch { return [n, false]; }
    }));
    const fora = res.filter(([, ok]) => !ok).map(([n]) => n);
    q.run('UPDATE autopilot_jobs SET state = ? WHERE organization_id = ? AND job = ?', JSON.stringify({ fora, total: SITES.length, at: now() }), ctx.orgId, 'sites');
    const caiu = fora.filter((n) => !prev.has(n)); const voltou = [...prev].filter((n) => !fora.includes(n));
    const txt = `${SITES.length - fora.length}/${SITES.length} sites no ar`;
    if (caiu.length || voltou.length) log(ctx.orgId, 'seguranca', 'Guardião', `${txt}${caiu.length ? ` · fora: ${caiu.join(', ')}` : ''}${voltou.length ? ` · voltou: ${voltou.join(', ')}` : ''}`);
    return { text: caiu.length ? `🚨 *Guardião*: fora do ar agora: ${caiu.join(', ')}. Te aviso quando voltar.` : voltou.length ? `✅ *Guardião*: voltou ao ar: ${voltou.join(', ')}.` : txt, quiet: !caiu.length && !voltou.length };
  },
  async risco(ctx) {
    if (!masterConfigured()) return { text: 'Área Master desligada.', quiet: true };
    const all = (await tenants()).filter((t) => !t.admin_blocked && !['CANCELED', 'EXPIRED'].includes(t.status));
    const parado = all.filter((t) => t.last_access_at && Date.now() - Date.parse(t.last_access_at) > 7 * 86400_000);
    const nunca = all.filter((t) => !t.last_access_at && Date.now() - Date.parse(t.created_at) > 3 * 86400_000);
    const lista = [...parado, ...nunca];
    const txt = `clientes em risco: ${lista.length}`;
    log(ctx.orgId, 'educacao', 'Retenção', txt);
    return { text: `🎓 *Retenção*: ${txt} (sem acesso há 7 dias ou nunca entraram).${lista.length ? `\n${lista.slice(0, 10).map((t) => `• ${t.name} (${String(t.product || '').toUpperCase()})`).join('\n')}\nSugestão: mandar a vídeo-aula de primeiros passos e oferecer ajuda.` : ''}`, quiet: !lista.length };
  },
};

/** Roda uma rotina agora (botão "rodar agora" ou o agendador). */
export async function runJob(ctx, job, { manual = false, notify = true } = {}) {
  if (!RUN[job]) throw errors.invalid('Rotina desconhecida.');
  const d = JOBS[job]; jobRow(ctx.orgId, job);
  let out;
  try { out = await RUN[job](ctx); }
  catch (e) { out = { text: `${d.label}: não consegui agora (${clampText(e.message, 120)}).`, error: true }; log(ctx.orgId, d.dept, d.agent, `${d.label}: falhou (${clampText(e.message, 80)})`); }
  q.run('UPDATE autopilot_jobs SET last_run = ?, last_result = ?, updated_at = ? WHERE organization_id = ? AND job = ?', d.time ? localParts().date : now(), clampText(out.text || '', 300), now(), ctx.orgId, job);
  if (notify && out.text && !out.sentInside && (!out.quiet || manual)) await tell(ctx, out.text);
  return out;
}

/** Agendador: chamado pelo worker a cada volta. */
export async function processAutopilot() {
  const orgs = q.all("SELECT DISTINCT organization_id AS id FROM organization_members WHERE role = 'owner' AND status = 'active'");
  let ran = 0;
  for (const { id } of orgs) {
    const ctx = ownerCtx(id); if (!ctx) continue;
    const lp = localParts();
    for (const [k, d] of Object.entries(JOBS)) {
      const r = jobRow(id, k);
      if (!r.enabled) continue;
      if (!d.time) { // de hora em hora
        if (r.last_run && Date.now() - Date.parse(r.last_run) < 3600_000) continue;
      } else {
        const at = toMin(r.at_time || d.time);
        if (r.last_run === lp.date || lp.minutes < at || lp.minutes > at + 120) continue;
        if (d.mondays && lp.weekday !== 'Mon') continue;
        if (d.weekdays && ['Sat', 'Sun'].includes(lp.weekday)) continue;
      }
      // marca antes de rodar: nunca duas vezes
      q.run('UPDATE autopilot_jobs SET last_run = ? WHERE organization_id = ? AND job = ?', d.time ? lp.date : now(), id, k);
      try { await runJob(ctx, k); ran++; } catch (e) { console.error('[mapa]', k, e.message); }
    }
  }
  return { ran };
}

// ---------------- o mapa ----------------
export async function companyMap(ctx) {
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const count = (sql, ...a) => q.get(sql, ...a)?.n || 0;
  const pend = mkt.pendingApproval(ctx);
  const props = q.all("SELECT p.id, p.summary, d.question FROM action_proposals p JOIN decisions d ON d.id = p.decision_id WHERE p.organization_id = ? AND p.status = 'awaiting_approval' ORDER BY p.created_at DESC LIMIT 6", ctx.orgId);
  const brain = {
    conversas: count('SELECT COUNT(*) n FROM wa_chat_turns WHERE organization_id = ? AND created_at > ?', ctx.orgId, since30) + count('SELECT COUNT(*) n FROM conversation_turns WHERE organization_id = ? AND created_at > ?', ctx.orgId, since30),
    reunioes: count('SELECT COUNT(*) n FROM mkt_meetings WHERE organization_id = ?', ctx.orgId),
    notas: count('SELECT COUNT(*) n FROM vault_notes WHERE organization_id = ?', ctx.orgId),
    decisoes: count('SELECT COUNT(*) n FROM decisions WHERE organization_id = ?', ctx.orgId),
    pendencias: pend.campaigns.length + pend.items.length + props.length,
  };
  // números ao vivo (o que não der para ler fica em branco, sem travar o mapa)
  let ts = []; let pays = [];
  if (masterConfigured()) {
    ts = await tenants().catch(() => []);
    pays = asList(await mapHooks.master('/payments?status=CONFIRMED').catch(() => []));
  }
  const lp = localParts();
  const hoje = pays.filter((p) => p.paid_at && localParts(new Date(p.paid_at)).date === lp.date).reduce((s, p) => s + Number(p.amount || 0), 0);
  const novos = ts.filter((t) => Date.parse(t.created_at) >= Date.now() - 86400_000).length;
  const teste = ts.filter((t) => t.trial_type && t.status === 'TRIAL').length;
  const pagantes = ts.filter((t) => t.status === 'ACTIVE' && !t.trial_type).length;
  const conv = ts.length ? Math.round((pagantes / ts.length) * 100) : 0;
  const risco = ts.filter((t) => !t.admin_blocked && t.last_access_at && Date.now() - Date.parse(t.last_access_at) > 7 * 86400_000).length;
  const sites = json(jobRow(ctx.orgId, 'sites').state, {});
  const week = mkt.listItems(ctx, { from: new Date(Date.now() - 7 * 86400_000).toISOString(), to: new Date(Date.now() + 7 * 86400_000).toISOString() });
  const agentsDb = q.all('SELECT name FROM agents WHERE organization_id = ? AND enabled = 1', ctx.orgId).map((a) => a.name);
  const kpi = {
    crm: `${novos} cadastro${novos === 1 ? '' : 's'} novo${novos === 1 ? '' : 's'} (24 h) · ${teste} em teste`,
    tarefas: `${brain.pendencias} pendência${brain.pendencias === 1 ? '' : 's'} para aprovar`,
    financeiro: `${money(hoje)} · recebido hoje`,
    seguranca: sites.total ? `${sites.total - (sites.fora || []).length}/${sites.total} sites no ar` : 'primeira conferência em até 1 h',
    traqueamento: `${pagantes} pagante${pagantes === 1 ? '' : 's'} · conversão ${conv}%`,
    educacao: `clientes em risco: ${risco}`,
    marketing: `${week.filter((i) => i.status === 'publicado').length} publicados · ${week.filter((i) => ['aprovado', 'na_fila'].includes(i.status)).length} na fila`,
    vault: `${brain.notas} nota${brain.notas === 1 ? '' : 's'} · ${brain.decisoes} decis${brain.decisoes === 1 ? 'ão' : 'ões'}`,
  };
  const pub = mkt.publisherStatus();
  const sup = q.get('SELECT enabled FROM support_agent WHERE organization_id = ?', ctx.orgId);
  const link = q.get("SELECT wa_id FROM whatsapp_links WHERE user_id = ? AND organization_id = ? AND status = 'verified'", ctx.userId, ctx.orgId);
  const totalAgents = DEPTS.reduce((s, d) => s + d.agents.length, 0) + agentsDb.length + 3;
  return {
    fontes: [
      { nome: 'Área Master', ok: masterConfigured(), info: masterConfigured() ? `${ts.length} empresas` : 'desligada' },
      { nome: 'WhatsApp', ok: wa.isConfigured(), info: wa.transport() === 'master' ? 'QR Code do Master' : wa.transport() || 'desligado' },
      { nome: 'Redes sociais', ok: !!pub.online && (pub.redes || []).length > 0, info: (pub.redes || []).length ? pub.redes.join(', ') : pub.online ? 'publicador sem redes' : 'publicador parado' },
      { nome: 'Cofre', ok: true, info: `${brain.notas} notas` },
    ],
    voce: { whatsapp: !!link, numero: link ? wa.maskNumber(link.wa_id) : null },
    segundo_cerebro: brain,
    equipe: { agentes: totalAgents, times: DEPTS.length },
    departamentos: DEPTS.map((d) => ({ ...d, agents: d.id === 'tarefas' ? [...d.agents, ...agentsDb.slice(0, 2)] : d.agents, kpi: kpi[d.id], rotinas: Object.entries(JOBS).filter(([, j]) => j.dept === d.id).map(([k]) => k) })),
    rotinas: jobs(ctx),
    linha_de_frente: [
      { nome: 'Atendente', info: wa.transport() === 'master' ? 'suporte técnico no WhatsApp da LORLER (Master)' : sup?.enabled ? 'suporte técnico no WhatsApp' : 'ligue no Master › WhatsApp do suporte', ok: wa.transport() === 'master' || !!sup?.enabled },
      { nome: 'Vendedor', info: `${teste} em teste · ${novos} novos`, ok: masterConfigured() },
      { nome: 'Assistente pessoal', info: link ? `você no WhatsApp (${wa.maskNumber(link.wa_id)})` : 'vincule seu WhatsApp', ok: !!link },
    ],
    para_aprovar: [
      ...pend.campaigns.map((c) => ({ tipo: 'Campanha', titulo: c.name, codigo: c.wa_code, href: '#/marketing' })),
      ...pend.items.map((i) => ({ tipo: i.kind === 'anuncio' ? 'Anúncio' : i.kind === 'acao' ? 'Ação comercial' : 'Post', titulo: i.title, codigo: i.wa_code, href: '#/marketing' })),
      ...props.map((p) => ({ tipo: 'Decisão', titulo: clampText(p.summary || p.question, 90), href: '#/aprovacoes' })),
    ].slice(0, 8),
    atividade: activity(ctx, 15),
    gerado_em: now(),
  };
}

/** Versão curta para o WhatsApp/voz ("mapa da empresa"). */
export async function mapSummary(ctx) {
  const m = await companyMap(ctx);
  const dep = m.departamentos.map((d) => `• ${d.name}: ${d.kpi}`).join('\n');
  const rot = m.rotinas.map((r) => `${r.enabled ? (r.done_today ? '✓' : '·') : '✗'} ${r.label} (${r.when})`).join('\n');
  return `🗺️ *Mapa da empresa* — ${m.equipe.agentes} agentes em ${m.equipe.times} times\n${dep}\n\nRotinas de hoje:\n${rot}${m.para_aprovar.length ? `\n\nPara aprovar: ${m.para_aprovar.map((p) => `${p.tipo} "${clampText(p.titulo, 40)}"${p.codigo ? ` (${p.codigo})` : ''}`).join('; ')}` : ''}`;
}
