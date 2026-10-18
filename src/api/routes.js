// Rotas da API da Central de Decisões LORLER. A organização e o papel vêm sempre da sessão validada.
import crypto from 'node:crypto';
import { q, insert, uuid, now, tx, json } from '../db.js';
import { config, secret } from '../config.js';
import { Router } from '../http/http.js';
import { errors, clampText, sha256, safeEqual } from '../lib/util.js';
import { hashPassword, login, destroySession, reauthenticate, requireRecentAuth, validatePasswordStrength, verifyPassword } from '../auth/auth.js';
import { can, requirePerm, requireProducts, loadOwned, PERMISSIONS } from '../auth/authz.js';
import { audit } from '../services/audit.js';
import { activePolicy } from '../services/policy.js';
import { approve, reject, requestRevision, revoke, reconcile, reviseContent } from '../services/actions.js';
import * as instagram from '../connectors/instagram.js';
import * as master from '../connectors/master.js';
import * as wa from '../connectors/whatsapp.js';
import * as waApprovals from '../services/whatsapp-approvals.js';
import { enqueueRun } from '../orchestrator/engine.js';
import { testIntegration, assertUrlAllowed } from '../connectors/connectors.js';
import { demoMetrics } from '../connectors/demo.js';
import { getProvider } from '../ai/provider.js';
import { addMember } from '../seed.js';
import { tokensCommitted } from '../services/budget.js';
import { buildAnalytics, clearAnalyticsCache } from '../services/analytics.js';
import { sourceReport } from '../services/reports.js';
import { bus } from '../orchestrator/events.js';
import { converse } from '../services/conversation.js';
import * as assistant from '../services/assistant.js';
import { platform } from '../platform.js';

export const router = new Router();
export const setupState = { token: null };

const DECISION_TYPES = ['comercial', 'financeiro', 'operacional', 'misto'];

// ---------------- Instalação / autenticação ----------------
router.get('/api/setup/status', () => ({ needs_setup: !q.get('SELECT id FROM users LIMIT 1') }), { public: true });

router.post('/api/setup/owner', ({ body, requestId }) => {
  if (q.get('SELECT id FROM users LIMIT 1')) throw errors.forbidden('Instalação já concluída.');
  if (!setupState.token || !safeEqual(String(body.setup_token || ''), setupState.token)) throw errors.forbidden('Código de instalação inválido. Consulte o console do servidor.');
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw errors.invalid('E-mail inválido.');
  const name = clampText(String(body.name || '').trim(), 80) || 'Owner';
  const hash = hashPassword(String(body.password || ''));
  const org = q.get('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
  const userId = uuid();
  tx(() => {
    insert('users', { id: userId, email, display_name: name, password_hash: hash, status: 'active', created_at: now() });
    addMember(org.id, userId, 'owner');
    audit({ orgId: org.id, actorType: 'user', actorId: userId, event: 'setup.owner_created', requestId });
  });
  setupState.token = null;
  return { ok: true };
}, { public: true });

router.post('/api/auth/login', ({ body, req, res, requestId }) => {
  const s = login(String(body.email || ''), String(body.password || ''), clientIp(req));
  setSessionCookie(res, s.token);
  audit({ actorType: 'user', actorId: s.userId, event: 'auth.login', requestId });
  return { ok: true, csrf: s.csrf };
}, { public: true });

router.post('/api/auth/logout', ({ ctx, res, token }) => {
  destroySession(token);
  res.setHeader('Set-Cookie', `lorler_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${config.cookieSecure ? '; Secure' : ''}`);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'auth.logout' });
  return { ok: true };
});

router.get('/api/auth/me', ({ ctx }) => ({
  user: { id: ctx.userId, email: ctx.email, name: ctx.name },
  organization: { id: ctx.orgId, name: ctx.orgName, timezone: ctx.timezone, executions_paused: ctx.paused },
  role: ctx.role,
  permissions: PERMISSIONS[ctx.role],
  memberships: ctx.memberships,
  csrf: ctx.session.csrf_token,
  environment: config.env,
  demo_mode: config.demoMode,
  ai_provider: getProvider().name,
}));

router.post('/api/auth/reauth', ({ ctx, body }) => { reauthenticate(ctx.session, String(body.password || '')); return { ok: true }; });

router.post('/api/auth/change-password', ({ ctx, body, requestId }) => {
  const u = q.get('SELECT password_hash FROM users WHERE id = ?', ctx.userId);
  if (!verifyPassword(String(body.current_password || ''), u.password_hash)) throw errors.invalid('Senha atual incorreta.');
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(String(body.new_password || '')), ctx.userId);
  q.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', ctx.userId, ctx.session.id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'auth.password_changed', requestId });
  return { ok: true };
});

export function clientIp(req) {
  if (config.trustProxy) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (h) return h;
  }
  return req.socket.remoteAddress || '';
}

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', `lorler_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionHours * 3600}${config.cookieSecure ? '; Secure' : ''}`);
}

// ---------------- Visão geral ----------------
router.get('/api/overview', ({ ctx }) => {
  requirePerm(ctx, 'view');
  const products = q.all(`SELECT p.id, p.code, p.name, p.description, i.status AS integration_status, i.last_checked_at FROM products p LEFT JOIN integrations i ON i.product_id = p.id
    WHERE p.organization_id = ? AND p.status = 'active' ORDER BY p.code`, ctx.orgId);
  const kpis = products.filter((p) => ctx.productIds.has(p.id)).map((p) => {
    const ev = q.get(`SELECT payload_ref, fetched_at, quality FROM evidence_items WHERE organization_id = ? AND product_id = ? AND source_type = 'integration' AND quality <> 'unavailable' ORDER BY fetched_at DESC LIMIT 1`, ctx.orgId, p.id);
    const real = ev ? json(ev.payload_ref, {}) : null;
    const demo = config.demoMode ? demoMetrics(p.code, null) : null;
    const pickM = (src) => src && ['active_subscriptions_at_period_end', 'new_subscriptions', 'cancellations', 'cash_received_in_period', 'support_tickets'].map((c) => ({ code: c, ...(src[c] || { value: null, quality: 'unavailable' }) }));
    return {
      product: p.code, name: p.name, description: p.description, integration_status: p.integration_status,
      real: real ? { period: real.period, fetched_at: ev.fetched_at, quality: ev.quality, metrics: pickM(real.metrics) } : null,
      demo: demo ? { label: 'Demonstração — dados fictícios', metrics: pickM(Object.fromEntries(demo.metrics.map((m) => [m.code, m]))) } : null,
    };
  });
  const recent = q.all('SELECT id, question, status, is_demo, created_at FROM decisions WHERE organization_id = ? ORDER BY created_at DESC LIMIT 8', ctx.orgId);
  const pending = q.get("SELECT COUNT(*) AS c FROM action_proposals WHERE organization_id = ? AND status = 'awaiting_approval'", ctx.orgId).c;
  const usage = q.get(`SELECT COALESCE(SUM(input_tokens + output_tokens),0) AS tokens, COUNT(*) AS calls, SUM(CASE WHEN cost_amount IS NOT NULL THEN CAST(cost_amount AS REAL) END) AS cost, MAX(currency) AS currency
    FROM usage_records WHERE organization_id = ? AND created_at >= ?`, ctx.orgId, monthStart());
  const pol = activePolicy(ctx.orgId);
  const committed = tokensCommitted(ctx.orgId);
  const alerts = [];
  if (!master.isConfigured()) for (const p of products) if (p.integration_status !== 'connected') alerts.push({ level: 'info', text: `${p.code}: integração pendente — indicadores reais indisponíveis.` });
  const budget = pol.rules.limits?.monthly_token_budget || 0;
  if (budget && (committed.active + committed.settled) / budget > 0.8) alerts.push({ level: 'warn', text: 'Consumo de tokens acima de 80% do orçamento técnico mensal.' });
  if (ctx.paused) alerts.unshift({ level: 'danger', text: 'Execuções pausadas pelo administrador.' });
  const failing = q.get("SELECT COUNT(*) AS c FROM runs WHERE organization_id = ? AND status = 'failed' AND queued_at >= ?", ctx.orgId, monthStart()).c;
  if (failing) alerts.push({ level: 'warn', text: `${failing} execução(ões) com falha neste mês.` });
  return { products: kpis, recent, pending_approvals: pending, usage: { ...usage, token_budget: budget, tokens_committed: committed.active + committed.settled }, alerts, provider: getProvider().name };
});

// ---------------- Centro de Análise (bases dos sistemas via Área Master) ----------------
router.get('/api/analytics', async ({ ctx, url }) => {
  requirePerm(ctx, 'view');
  const products = q.all("SELECT id, code, name, description FROM products WHERE organization_id = ? AND status = 'active' ORDER BY code", ctx.orgId).filter((p) => ctx.productIds.has(p.id));
  return buildAnalytics(products, { force: url.searchParams.get('refresh') === '1' && can(ctx, 'manage_integrations') });
});

router.get('/api/sources/:code/report', async ({ ctx, params }) => {
  requirePerm(ctx, 'view');
  const products = q.all("SELECT id, code, name, description FROM products WHERE organization_id = ? AND status = 'active' ORDER BY code", ctx.orgId).filter((p) => ctx.productIds.has(p.id));
  const r = await sourceReport(ctx, params.code, products);
  if (!r) throw errors.notFound();
  return r;
});

function monthStart() { const d = new Date(); d.setUTCDate(1); d.setUTCHours(3, 0, 0, 0); return d.toISOString(); }

router.get('/api/products', ({ ctx }) => q.all('SELECT id, code, name, description, status FROM products WHERE organization_id = ? ORDER BY code', ctx.orgId).map((p) => ({ ...p, in_scope: ctx.productIds.has(p.id) })));

// ---------------- Decisões ----------------
router.post('/api/decisions', ({ ctx, body, requestId }) => ({ status: 202, data: createDecision(ctx, body, requestId) }));

/** Cria a análise (decisão) e põe na fila — usado pela tela "Nova análise" e pela conversa por voz. */
export function createDecision(ctx, body, requestId) {
  requirePerm(ctx, 'create_decision');
  if (ctx.paused) throw errors.paused();
  const question = String(body.question || '').trim();
  if (question.length < 8 || question.length > 2000) throw errors.invalid('Descreva a pergunta com 8 a 2000 caracteres.');
  const productIds = Array.isArray(body.product_ids) ? [...new Set(body.product_ids.map(String))].slice(0, 10) : [];
  if (!productIds.length) throw errors.invalid('Selecione ao menos um produto.');
  requireProducts(ctx, productIds);
  const type = DECISION_TYPES.includes(body.decision_type) ? body.decision_type : 'misto';
  const start = Date.parse(body.period?.start); const end = Date.parse(body.period?.end_exclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw errors.invalid('Período inválido.');
  if (end - start > 400 * 86400_000) throw errors.invalid('Período máximo de 400 dias.');
  const isDemo = body.mode === 'demo';
  if (isDemo && !config.demoMode) throw errors.forbidden('Modo demonstração desabilitado neste ambiente.');
  const constraints = {};
  if (body.constraints?.business_budget) {
    const amt = String(body.constraints.business_budget).replace(',', '.');
    if (!/^\d+(\.\d{1,2})?$/.test(amt)) throw errors.invalid('Orçamento inválido.');
    constraints.business_budget = { amount: amt, currency: 'BRL', note: 'Restrição solicitada — não concede autorização de gasto.' };
  }
  if (body.constraints?.deadline) constraints.deadline = clampText(String(body.constraints.deadline), 40);
  if (body.constraints?.notes) constraints.notes = clampText(String(body.constraints.notes), 600);
  const scope = { product_ids: productIds, period: { start: new Date(start).toISOString(), end_exclusive: new Date(end).toISOString(), timezone: ctx.timezone }, decision_type: type, constraints };
  const decision = { id: uuid(), organization_id: ctx.orgId, created_by: ctx.userId, question, scope, status: 'draft', current_run_id: null, is_demo: isDemo ? 1 : 0, created_at: now() };
  insert('decisions', decision);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'decision.created', objectType: 'decision', objectId: decision.id, requestId, metadata: { demo: isDemo, products: productIds.length } });
  const runId = enqueueRun({ ...decision, scope: JSON.stringify(scope) }, ctx);
  return { decision_id: decision.id, run_id: runId, status: 'queued' };
}

// ---------------- Conversa (voz ou texto) ----------------
// Respostas curtas para falar; só abre análise depois de o usuário confirmar; nunca aprova nem executa nada.
const convoHits = new Map();
router.post('/api/conversation', async ({ ctx, body, requestId }) => {
  requirePerm(ctx, 'view');
  const key = ctx.userId; const t = Date.now();
  const hits = (convoHits.get(key) || []).filter((x) => t - x < 60_000);
  if (hits.length >= 30) throw errors.limit('Muitas mensagens em pouco tempo. Aguarde alguns segundos.');
  hits.push(t); convoHits.set(key, hits);
  const user = q.get('SELECT display_name FROM users WHERE id = ?', ctx.userId);
  const c = { ...ctx, firstName: String(user?.display_name || '').split(' ')[0] || 'operador' };
  return converse(c, body || {}, { requestId, channel: body?.channel === 'text' ? 'text' : 'voice', createDecision: (b) => createDecision(ctx, b, requestId) });
});

router.get('/api/decisions', ({ ctx, url }) => {
  requirePerm(ctx, 'view');
  const status = url.searchParams.get('status');
  const rows = q.all(`SELECT d.id, d.question, d.status, d.is_demo, d.created_at, d.scope, u.display_name AS author FROM decisions d JOIN users u ON u.id = d.created_by
    WHERE d.organization_id = ? ${status ? 'AND d.status = ?' : ''} ORDER BY d.created_at DESC LIMIT 100`, ctx.orgId, ...(status ? [status] : []));
  const visible = ctx.role === 'viewer' ? rows.filter((r) => ['completed', 'awaiting_approval', 'approved', 'rejected', 'insufficient_data'].includes(r.status)) : rows;
  return visible.map((r) => ({ ...r, scope: json(r.scope) }));
});

router.get('/api/decisions/:id', ({ ctx, params }) => {
  requirePerm(ctx, 'view');
  const d = loadOwned('decisions', params.id, ctx);
  const runs = q.all('SELECT id, status, model_calls, error, queued_at, started_at, finished_at, config_snapshot FROM runs WHERE decision_id = ? AND organization_id = ? ORDER BY queued_at', d.id, ctx.orgId);
  const run = runs.find((r) => r.id === d.current_run_id) || runs[runs.length - 1];
  return { decision: { ...d, scope: json(d.scope) }, runs: runs.map((r) => ({ ...r, config_snapshot: undefined })), current: run ? runDetail(ctx, run) : null };
});

function runDetail(ctx, run) {
  const snapshot = json(run.config_snapshot, {});
  const tasks = q.all('SELECT id, agent_code, round, kind, question, status, output, validation_notes, started_at, finished_at FROM agent_tasks WHERE run_id = ? AND organization_id = ? ORDER BY started_at', run.id, ctx.orgId)
    .map((t) => ({ ...t, output: json(t.output), validation_notes: json(t.validation_notes) }));
  const messages = q.all('SELECT id, round, sender_code, recipient_code, reply_to_id, type, content, created_at FROM agent_messages WHERE run_id = ? AND organization_id = ? ORDER BY created_at', run.id, ctx.orgId)
    .map((m) => ({ ...m, content: json(m.content, {}) }));
  const evidence = q.all('SELECT e.ref_code, e.source_type, e.source_ref, e.source_version, e.quality, e.fetched_at, e.checksum, e.is_demo, e.payload_ref, p.code AS product FROM evidence_items e LEFT JOIN products p ON p.id = e.product_id WHERE e.run_id = ? AND e.organization_id = ? ORDER BY CAST(SUBSTR(e.ref_code, 4) AS INTEGER)', run.id, ctx.orgId)
    .map((e) => ({ ...e, payload: json(e.payload_ref), payload_ref: undefined }));
  const proposals = q.all('SELECT * FROM action_proposals WHERE run_id = ? AND organization_id = ? ORDER BY version', run.id, ctx.orgId).map((p) => {
    const evals = q.all('SELECT stage, result, required_approvers, checks, evaluated_at FROM policy_evaluations WHERE action_proposal_id = ? ORDER BY evaluated_at', p.id).map((e) => ({ ...e, required_approvers: json(e.required_approvers), checks: json(e.checks) }));
    const approvals = q.all('SELECT a.result, a.comment, a.decided_at, u.display_name AS approver FROM approvals a JOIN users u ON u.id = a.approver_id WHERE a.action_proposal_id = ? ORDER BY decided_at', p.id);
    const executions = q.all('SELECT status, idempotency_key, external_ref, attempts, result, started_at, finished_at FROM action_executions WHERE action_proposal_id = ?', p.id).map((x) => ({ ...x, result: json(x.result) }));
    return { ...p, parameters: json(p.parameters), evaluations: evals, approvals, executions, can_decide: p.status === 'awaiting_approval' && can(ctx, 'approve') && (evals[0]?.required_approvers || []).includes(ctx.role) };
  });
  const synthesisTask = [...tasks].reverse().find((t) => t.kind === 'synthesis' && t.status === 'done');
  const synthesisStep = q.get("SELECT result_ref FROM run_steps WHERE run_id = ? AND step_key = 'synthesis' AND status = 'done'", run.id);
  const usage = q.get('SELECT COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COUNT(*) AS calls, SUM(CAST(cost_amount AS REAL)) AS cost, MAX(currency) AS currency FROM usage_records WHERE run_id = ?', run.id);
  return {
    run: { id: run.id, status: run.status, model_calls: run.model_calls, error: run.error, queued_at: run.queued_at, started_at: run.started_at, finished_at: run.finished_at, provider: snapshot.provider, policy_version: snapshot.policy_version, agents: Object.fromEntries(Object.entries(snapshot.agents || {}).map(([k, v]) => [k, { name: v.name, version: v.version, model: v.model }])) },
    synthesis: synthesisStep ? json(synthesisStep.result_ref) : synthesisTask?.output || null,
    tasks, messages, evidence, proposals, usage,
  };
}

router.get('/api/runs/:id', ({ ctx, params }) => {
  requirePerm(ctx, 'view');
  const run = loadOwned('runs', params.id, ctx);
  return runDetail(ctx, run);
});

router.post('/api/decisions/:id/cancel', ({ ctx, params, requestId }) => {
  const d = loadOwned('decisions', params.id, ctx);
  if (d.created_by !== ctx.userId && !can(ctx, 'approve')) throw errors.forbidden();
  const run = q.get('SELECT * FROM runs WHERE id = ?', d.current_run_id);
  if (!run || ['completed', 'failed', 'canceled', 'rejected', 'insufficient_data', 'expired'].includes(run.status)) throw errors.conflict('Execução já encerrada.');
  tx(() => {
    if (run.status === 'queued') {
      q.run("UPDATE runs SET status = 'canceled', cancel_requested = 1, finished_at = ? WHERE id = ?", now(), run.id);
      q.run("UPDATE decisions SET status = 'canceled' WHERE id = ?", d.id);
    } else q.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', run.id);
    q.run("UPDATE action_proposals SET status = 'canceled' WHERE decision_id = ? AND status IN ('awaiting_approval','draft','approved') AND id NOT IN (SELECT action_proposal_id FROM action_executions)", d.id);
    if (['awaiting_approval', 'approved'].includes(run.status)) q.run("UPDATE decisions SET status = 'canceled' WHERE id = ?", d.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'decision.cancel_requested', objectType: 'decision', objectId: d.id, requestId });
  });
  return { ok: true };
});

router.post('/api/decisions/:id/rerun', ({ ctx, params, body, requestId }) => {
  requirePerm(ctx, 'create_decision');
  if (ctx.paused) throw errors.paused();
  const d = loadOwned('decisions', params.id, ctx);
  const cur = q.get('SELECT status FROM runs WHERE id = ?', d.current_run_id);
  if (cur && ['queued', 'validating', 'collecting_data', 'analyzing', 'reviewing', 'synthesizing'].includes(cur.status)) throw errors.conflict('Já existe uma execução em andamento.');
  requireProducts(ctx, json(d.scope, {}).product_ids || []);
  const extra = body?.revision_comment ? { revision_requested_by_approver: clampText(String(body.revision_comment), 600) } : {};
  const runId = enqueueRun(d, ctx, extra);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'decision.rerun', objectType: 'decision', objectId: d.id, requestId });
  return { status: 202, data: { decision_id: d.id, run_id: runId } };
});

// ---------------- Aprovações ----------------
router.get('/api/approvals', ({ ctx }) => {
  requirePerm(ctx, 'view');
  return q.all(`SELECT p.id, p.decision_id, p.version, p.tool_code, p.summary, p.status, p.expires_at, p.created_at, d.question, d.is_demo, pr.code AS product
    FROM action_proposals p JOIN decisions d ON d.id = p.decision_id LEFT JOIN products pr ON pr.id = p.product_id
    WHERE p.organization_id = ? AND p.status IN ('awaiting_approval','approved','uncertain','denied') ORDER BY p.created_at DESC LIMIT 100`, ctx.orgId);
});

router.post('/api/actions/:id/approve', ({ ctx, params, body, requestId }) => {
  const p = loadOwned('action_proposals', params.id, ctx);
  const ev = q.get("SELECT required_approvers FROM policy_evaluations WHERE action_proposal_id = ? AND stage = 'proposal' ORDER BY evaluated_at DESC LIMIT 1", p.id);
  if (json(ev?.required_approvers, []).includes('owner') && p.tool_code !== 'create_internal_task') requireRecentAuth(ctx.session); // ações críticas: autenticação reforçada
  return approve(ctx, params.id, body, requestId);
});
router.post('/api/actions/:id/reject', ({ ctx, params, body, requestId }) => reject(ctx, params.id, body, requestId));
router.post('/api/actions/:id/request-revision', ({ ctx, params, body, requestId }) => {
  const r = requestRevision(ctx, params.id, body, requestId);
  const d = loadOwned('decisions', r.decisionId, ctx);
  const runId = enqueueRun(d, ctx, { revision_requested_by_approver: r.comment || 'Revisar a proposta.' });
  return { ok: true, run_id: runId };
});
router.post('/api/actions/:id/execute', async ({ ctx, params, requestId }) => {
  // Nova tentativa de execução de proposta aprovada e ainda não executada (ex.: conta vinculada depois da aprovação).
  if (!can(ctx, 'approve')) throw errors.forbidden();
  const p = loadOwned('action_proposals', params.id, ctx);
  if (p.status !== 'approved') throw errors.conflict('Somente propostas aprovadas e não executadas podem ser executadas.');
  const { execute } = await import('../services/actions.js');
  return execute(p.id, ctx.orgId, requestId);
});
router.post('/api/actions/:id/revise-content', ({ ctx, params, body, requestId }) => reviseContent(ctx, params.id, body, requestId));
router.post('/api/actions/:id/revoke', ({ ctx, params, requestId }) => revoke(ctx, params.id, requestId));
router.post('/api/actions/:id/reconcile', ({ ctx, params, requestId }) => reconcile(ctx, params.id, requestId));

router.get('/api/tasks', ({ ctx }) => {
  requirePerm(ctx, 'view');
  return q.all('SELECT t.id, t.title, t.description, t.due_date, t.status, t.created_at, p.code AS product FROM internal_tasks t LEFT JOIN products p ON p.id = t.product_id WHERE t.organization_id = ? ORDER BY t.created_at DESC LIMIT 100', ctx.orgId);
});
router.post('/api/tasks/:id/status', ({ ctx, params, body }) => {
  requirePerm(ctx, 'create_decision');
  const st = ['open', 'done', 'canceled'].includes(body.status) ? body.status : null;
  if (!st) throw errors.invalid('Status inválido.');
  const r = q.run('UPDATE internal_tasks SET status = ? WHERE id = ? AND organization_id = ?', st, params.id, ctx.orgId);
  if (!r.changes) throw errors.notFound();
  return { ok: true };
});

// ---------------- Agentes ----------------
router.get('/api/agents', ({ ctx }) => {
  requirePerm(ctx, 'view');
  return q.all('SELECT a.id, a.code, a.name, a.description, a.enabled, a.active_version_id FROM agents a WHERE a.organization_id = ? ORDER BY a.rowid', ctx.orgId).map((a) => {
    const versions = q.all('SELECT id, version, instructions, model_config, limits, output_schema_version, accepts_from, created_at FROM agent_versions WHERE agent_id = ? ORDER BY version DESC', a.id)
      .map((v) => ({ ...v, model_config: json(v.model_config), limits: json(v.limits), accepts_from: json(v.accepts_from), tools: q.all('SELECT t.code, t.type FROM agent_tool_grants g JOIN tools t ON t.id = g.tool_id WHERE g.agent_version_id = ?', v.id) }));
    return { ...a, versions, can_edit: can(ctx, 'manage_agents') };
  });
});

router.post('/api/agents/:id/versions', ({ ctx, params, body, requestId }) => {
  requirePerm(ctx, 'manage_agents');
  requireRecentAuth(ctx.session);
  const a = loadOwned('agents', params.id, ctx);
  const cur = q.get('SELECT * FROM agent_versions WHERE id = ?', a.active_version_id);
  const instructions = String(body.instructions || '').trim();
  if (instructions.length < 50 || instructions.length > 12000) throw errors.invalid('Instruções devem ter entre 50 e 12000 caracteres.');
  const limits = { ...json(cur.limits, {}), ...(body.limits || {}) };
  limits.max_output_tokens = Math.min(Math.max(parseInt(limits.max_output_tokens, 10) || 3000, 256), 16000);
  limits.timeout_ms = Math.min(Math.max(parseInt(limits.timeout_ms, 10) || 90000, 5000), 300000);
  limits.max_calls = Math.min(Math.max(parseInt(limits.max_calls, 10) || 3, 1), 6);
  const verId = uuid();
  tx(() => {
    insert('agent_versions', { id: verId, organization_id: ctx.orgId, agent_id: a.id, version: cur.version + 1, instructions, model_config: json(cur.model_config), limits, output_schema_version: cur.output_schema_version, accepts_from: json(cur.accepts_from), created_by: ctx.userId, created_at: now() });
    // Concessões de ferramentas são copiadas da versão anterior — o texto do prompt não amplia ferramentas.
    for (const g of q.all('SELECT tool_id, scope, limits FROM agent_tool_grants WHERE agent_version_id = ?', cur.id)) {
      insert('agent_tool_grants', { id: uuid(), organization_id: ctx.orgId, agent_version_id: verId, tool_id: g.tool_id, scope: g.scope, limits: g.limits });
    }
    q.run('UPDATE agents SET active_version_id = ? WHERE id = ?', verId, a.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'agent.version_created', objectType: 'agent', objectId: a.id, requestId, metadata: { version: cur.version + 1, instructions_hash: sha256(instructions) } });
  });
  return { ok: true, version: cur.version + 1 };
});

router.post('/api/agents/:id/toggle', ({ ctx, params, body, requestId }) => {
  requirePerm(ctx, 'manage_agents');
  const a = loadOwned('agents', params.id, ctx);
  if (a.code === 'coordinator' && !body.enabled) throw errors.invalid('O coordenador não pode ser desabilitado.');
  q.run('UPDATE agents SET enabled = ? WHERE id = ?', body.enabled ? 1 : 0, a.id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: body.enabled ? 'agent.enabled' : 'agent.disabled', objectType: 'agent', objectId: a.id, requestId });
  return { ok: true };
});

// ---------------- Conhecimento ----------------
router.get('/api/knowledge', ({ ctx, url }) => {
  requirePerm(ctx, 'view');
  const term = (url.searchParams.get('q') || '').trim().toLowerCase();
  const rows = q.all(`SELECT d.id, d.title, d.classification, d.status, d.is_demo, d.product_id, p.code AS product, v.version, v.content, v.checksum, v.effective_from, v.expires_at, u.display_name AS approved_by
    FROM knowledge_documents d JOIN knowledge_versions v ON v.id = d.current_version_id LEFT JOIN products p ON p.id = d.product_id LEFT JOIN users u ON u.id = v.approved_by
    WHERE d.organization_id = ? ORDER BY d.created_at`, ctx.orgId);
  return rows
    .filter((r) => !r.product_id || ctx.productIds.has(r.product_id)) // autorização antes de retornar conteúdo
    .filter((r) => (ctx.role === 'viewer' ? r.classification !== 'restricted' : true))
    .filter((r) => !term || r.title.toLowerCase().includes(term) || r.content.toLowerCase().includes(term))
    .map((r) => ({ ...r, content: r.content.replace(/\n\n\[regras estruturadas\].*$/s, ''), expired: !!(r.expires_at && r.expires_at <= now()) }));
});

router.post('/api/knowledge', ({ ctx, body, requestId }) => {
  requirePerm(ctx, 'manage_knowledge');
  const title = clampText(String(body.title || '').trim(), 200);
  const content = String(body.content || '').trim();
  if (title.length < 3 || content.length < 10 || content.length > 50000) throw errors.invalid('Título e conteúdo são obrigatórios (conteúdo até 50.000 caracteres).');
  const classification = ['public', 'internal', 'restricted'].includes(body.classification) ? body.classification : 'internal';
  let productId = null;
  if (body.product_id) { requireProducts(ctx, [String(body.product_id)]); productId = String(body.product_id); }
  const expires = body.expires_at && Number.isFinite(Date.parse(body.expires_at)) ? new Date(body.expires_at).toISOString() : null;
  let finalContent = content;
  if (body.rules && typeof body.rules === 'object') {
    const r = {};
    for (const k of ['max_discount_pct', 'approval_above_pct', 'max_duration_months']) if (Number.isFinite(Number(body.rules[k]))) r[k] = Number(body.rules[k]);
    if (Object.keys(r).length) finalContent += `\n\n[regras estruturadas] ${JSON.stringify(r)}`;
  }
  return tx(() => {
    let doc = body.document_id ? loadOwned('knowledge_documents', body.document_id, ctx) : null;
    if (!doc) {
      doc = { id: uuid(), organization_id: ctx.orgId, product_id: productId, title, classification, current_version_id: null, status: 'active', is_demo: 0, created_at: now() };
      insert('knowledge_documents', doc);
    }
    const prev = q.get('SELECT MAX(version) AS v FROM knowledge_versions WHERE document_id = ?', doc.id);
    const verId = uuid();
    insert('knowledge_versions', { id: verId, organization_id: ctx.orgId, document_id: doc.id, version: (prev?.v || 0) + 1, content: finalContent, content_ref: null, checksum: sha256(finalContent), effective_from: now(), expires_at: expires, approved_by: ctx.userId, created_at: now() });
    q.run('UPDATE knowledge_documents SET current_version_id = ?, title = ?, classification = ? WHERE id = ?', verId, title, classification, doc.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'knowledge.version_created', objectType: 'knowledge_document', objectId: doc.id, requestId });
    return { ok: true, document_id: doc.id };
  });
});

router.post('/api/knowledge/:id/archive', ({ ctx, params, requestId }) => {
  requirePerm(ctx, 'manage_knowledge');
  const d = loadOwned('knowledge_documents', params.id, ctx);
  q.run("UPDATE knowledge_documents SET status = 'archived' WHERE id = ?", d.id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'knowledge.archived', objectType: 'knowledge_document', objectId: d.id, requestId });
  return { ok: true };
});

// ---------------- Integrações ----------------
router.get('/api/integrations', ({ ctx }) => {
  requirePerm(ctx, 'view');
  return q.all('SELECT i.id, i.adapter, i.adapter_version, i.base_url, i.secret_ref, i.status, i.last_checked_at, i.last_check_result, p.code AS product, p.name FROM integrations i JOIN products p ON p.id = i.product_id WHERE i.organization_id = ? ORDER BY p.code', ctx.orgId)
    .map((i) => ({ ...i, secret_configured: !!secret(i.secret_ref), last_check_result: json(i.last_check_result), can_edit: can(ctx, 'manage_integrations') }));
});

router.put('/api/integrations/:id', async ({ ctx, params, body, requestId }) => {
  requirePerm(ctx, 'manage_integrations');
  const i = loadOwned('integrations', params.id, ctx);
  if (body.base_url !== undefined) {
    const url = String(body.base_url || '').trim();
    if (url) {
      try { await assertUrlAllowed(url); } catch (e) { throw errors.invalid(e.message); }
    }
    q.run("UPDATE integrations SET base_url = ?, status = 'pending_setup' WHERE id = ?", url || null, i.id);
  }
  if (body.status === 'disabled' || body.status === 'pending_setup') q.run('UPDATE integrations SET status = ? WHERE id = ?', body.status, i.id);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'integration.updated', objectType: 'integration', objectId: i.id, requestId, metadata: { status: body.status } });
  return { ok: true };
});

router.post('/api/integrations/:id/test', async ({ ctx, params, requestId }) => {
  requirePerm(ctx, 'manage_integrations');
  const i = loadOwned('integrations', params.id, ctx);
  const r = await testIntegration(i.id, ctx.orgId);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'integration.tested', objectType: 'integration', objectId: i.id, requestId, metadata: { status: r.status, kind: r.kind } });
  return r;
});

// ---------------- Instagram ----------------
router.get('/api/social/instagram', ({ ctx }) => {
  requirePerm(ctx, 'view');
  const acc = instagram.publicAccount(ctx.orgId);
  const posts = q.all(`SELECT p.id, p.decision_id, p.version, p.status, p.parameters, p.created_at, e.status AS exec_status, e.external_ref, e.result, e.finished_at
    FROM action_proposals p LEFT JOIN action_executions e ON e.action_proposal_id = p.id
    WHERE p.organization_id = ? AND p.tool_code = 'publish_instagram_post' ORDER BY p.created_at DESC LIMIT 30`, ctx.orgId)
    .map((r) => { const pr = json(r.parameters, {}); return { ...r, parameters: undefined, title: pr.title, caption: pr.caption, image_url: pr.image_url, result: json(r.result) }; });
  return {
    account: acc,
    app_configured: instagram.isAppConfigured(),
    redirect_uri: config.instagram.redirectUri || null,
    api_version: config.instagram.apiVersion,
    can_manage: can(ctx, 'manage_integrations'),
    posts,
  };
});

router.post('/api/social/instagram/oauth/start', ({ ctx, requestId }) => {
  requirePerm(ctx, 'manage_integrations');
  const url = instagram.startOAuth(ctx);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'instagram.oauth_started', requestId });
  return { authorize_url: url };
});

// Retorno do Instagram (GET público, protegido por state de uso único vinculado ao owner que iniciou)
router.get('/api/social/instagram/callback', async ({ url, res, requestId }) => {
  let target = '/#/integracoes?ig=ok';
  try {
    if (url.searchParams.get('error')) throw new instagram.InstagramError('denied', 'Autorização cancelada no Instagram.');
    const orgId = await instagram.handleCallback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
    audit({ orgId, actorType: 'service', actorId: 'instagram', event: 'instagram.linked', requestId, metadata: { method: 'oauth' } });
  } catch (e) {
    target = `/#/integracoes?ig=erro&msg=${encodeURIComponent(e.message || 'Falha na vinculação')}`;
  }
  res.writeHead(302, { Location: target, 'Cache-Control': 'no-store' });
  res.end();
  return null;
}, { public: true });

router.post('/api/social/instagram/token', async ({ ctx, body, requestId }) => {
  requirePerm(ctx, 'manage_integrations');
  requireRecentAuth(ctx.session);
  try {
    const acc = await instagram.linkManualToken(ctx, body.access_token);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'instagram.linked', requestId, metadata: { method: 'manual_token', username: acc?.username } });
    return { ok: true, account: acc };
  } catch (e) {
    if (e instanceof instagram.InstagramError) throw errors.invalid(e.message);
    throw e;
  }
});

router.post('/api/social/instagram/verify', async ({ ctx, requestId }) => {
  requirePerm(ctx, 'manage_integrations');
  try {
    const r = await instagram.verifyAccount(ctx.orgId);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'instagram.verified', requestId });
    return r;
  } catch (e) {
    if (e instanceof instagram.InstagramError) throw errors.invalid(e.message);
    throw e;
  }
});

router.post('/api/social/instagram/disconnect', ({ ctx, requestId }) => {
  requirePerm(ctx, 'manage_integrations');
  instagram.disconnect(ctx.orgId);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'instagram.disconnected', requestId });
  return { ok: true };
});

// ---------------- Área Master ----------------
router.get('/api/master/status', ({ ctx }) => {
  requirePerm(ctx, 'view');
  return { ...master.masterInfo(), last: master.lastMasterStatus(), can_manage: can(ctx, 'manage_integrations') };
});
router.post('/api/master/test', async ({ ctx, requestId }) => {
  requirePerm(ctx, 'manage_integrations');
  master.resetSession();
  clearAnalyticsCache();
  const r = await master.testConnection();
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'master.tested', requestId, metadata: { ok: r.ok, kind: r.kind } });
  return r;
});
router.get('/api/master/preview', async ({ ctx, url }) => {
  requirePerm(ctx, 'manage_integrations');
  const code = String(url.searchParams.get('product') || 'orbi').toLowerCase();
  const end = new Date(); const start = new Date(end.getTime() - 30 * 86400_000);
  try { return await master.productSnapshot(code, { start: start.toISOString(), end_exclusive: end.toISOString(), timezone: ctx.timezone }); }
  catch (e) { throw errors.unavailable(e.message); }
});

// ---------------- Assistente: personalidade, avatar e voz ----------------
router.get('/api/assistant', ({ ctx }) => ({
  settings: assistant.getSettings(ctx.orgId), can_edit: can(ctx, 'manage_agents'),
  options: { tones: Object.keys(assistant.TONES), avatar_styles: assistant.AVATAR_STYLES, openai_voices: assistant.OPENAI_VOICES },
  tts_available: !!(process.env.OPENAI_API_KEY || secret('OPENAI_API_KEY')),
}));
router.put('/api/assistant', ({ ctx, body, requestId }) => {
  requirePerm(ctx, 'manage_agents');
  const settings = assistant.saveSettings(ctx.orgId, ctx.userId, body || {});
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'assistant.settings_updated', requestId, metadata: { name: settings.name, tone: settings.tone, voice: settings.voice.engine } });
  return { settings };
}, { bigBody: true });

// Voz neural (OpenAI). A chave nunca vai para o navegador; textos curtos, com limite por usuário.
const ttsHits = new Map();
router.post('/api/tts', async ({ ctx, body, res }) => {
  requirePerm(ctx, 'view');
  const key = process.env.OPENAI_API_KEY || secret('OPENAI_API_KEY');
  if (!key) throw errors.invalid('Voz neural indisponível: configure a chave da OpenAI no servidor.');
  const text = String(body?.text || '').trim();
  if (!text || text.length > 800) throw errors.invalid('Texto para voz deve ter de 1 a 800 caracteres.');
  const t = Date.now(); const hits = (ttsHits.get(ctx.userId) || []).filter((x) => t - x < 60_000);
  if (hits.length >= 20) throw errors.limit('Muitas falas em pouco tempo. Aguarde alguns segundos.');
  hits.push(t); ttsHits.set(ctx.userId, hits);
  const s = assistant.getSettings(ctx.orgId);
  const voice = assistant.OPENAI_VOICES.includes(body?.voice) ? body.voice : s.voice.openai_voice;
  const speed = Math.min(1.6, Math.max(0.6, Number(body?.rate) || s.voice.rate || 1));
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 20000);
  let r;
  try {
    r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST', signal: ac.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.LORLER_TTS_MODEL || 'gpt-4o-mini-tts', voice, input: text, speed, response_format: 'mp3',
        instructions: `Fale em português do Brasil, com naturalidade, tom ${assistant.TONES[s.tone]}.` }),
    });
  } catch { throw errors.invalid('Não consegui gerar a voz agora (tempo esgotado).'); } finally { clearTimeout(timer); }
  if (!r.ok) throw errors.invalid(`Não consegui gerar a voz agora (OpenAI ${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
  return null;
});

// ---------------- WhatsApp ----------------
router.get('/api/whatsapp/me', ({ ctx }) => {
  const r = waApprovals.myLink(ctx);
  const recent = q.all(`SELECT r.code, r.status, r.send_error, r.created_at, p.summary FROM whatsapp_requests r JOIN action_proposals p ON p.id = r.action_proposal_id WHERE r.user_id = ? ORDER BY r.created_at DESC LIMIT 10`, ctx.userId);
  return { ...r, recent, webhook_url: config.publicUrl ? `${config.publicUrl}/api/whatsapp/webhook` : null, can_approve: can(ctx, 'approve') };
});
router.post('/api/whatsapp/link', ({ ctx }) => waApprovals.startLink(ctx));
router.post('/api/whatsapp/pin', ({ ctx, body }) => { requireRecentAuth(ctx.session); return waApprovals.setPin(ctx, String(body.pin || '')); });
router.post('/api/whatsapp/notify', ({ ctx, body }) => waApprovals.setNotify(ctx, !!body.enabled));
router.post('/api/whatsapp/unlink', ({ ctx }) => waApprovals.unlink(ctx));
router.post('/api/whatsapp/test', ({ ctx }) => waApprovals.sendTest(ctx));
router.post('/api/actions/:id/notify-whatsapp', async ({ ctx, params }) => {
  if (!can(ctx, 'approve')) throw errors.forbidden();
  const p = loadOwned('action_proposals', params.id, ctx);
  return waApprovals.notifyApproval(p.id);
});

// Webhook da Meta: verificação (GET) e mensagens recebidas (POST com assinatura X-Hub-Signature-256)
router.get('/api/whatsapp/webhook', ({ url, res }) => {
  const c = wa.waConfig();
  const ok = url.searchParams.get('hub.mode') === 'subscribe' && c.verifyToken && safeEqual(String(url.searchParams.get('hub.verify_token') || ''), c.verifyToken);
  res.writeHead(ok ? 200 : 403, { 'Content-Type': 'text/plain' });
  res.end(ok ? String(url.searchParams.get('hub.challenge') || '') : 'forbidden');
  return null;
}, { public: true });
router.post('/api/whatsapp/webhook', async ({ req, raw, body, requestId }) => {
  if (!wa.verifySignature(raw, req.headers['x-hub-signature-256'])) throw errors.unauth();
  const msgs = wa.extractMessages(body);
  for (const m of msgs.slice(0, 20)) {
    // comandos respondem na hora; a conversa (IA) roda depois de devolver 200 para a Meta (que reenvia se demorarmos)
    const defer = (p) => { const w = Promise.resolve(p).catch((e) => console.error('[whatsapp] conversa', requestId, e.message)); platform.defer?.(w); };
    try { await waApprovals.handleInbound(m, { defer }); } catch (e) { console.error('[whatsapp] falha ao processar mensagem', requestId, e.message); }
  }
  return { ok: true, processed: msgs.length };
}, { public: true, noCsrf: true });

// ---------------- Políticas ----------------
router.get('/api/policies', ({ ctx }) => {
  requirePerm(ctx, 'view');
  return { active: activePolicy(ctx.orgId), history: q.all('SELECT v.id, v.version, v.effective_from, v.created_at, u.display_name AS author FROM policy_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.organization_id = ? ORDER BY version DESC', ctx.orgId), can_edit: can(ctx, 'manage_policies') };
});

router.post('/api/policies/versions', ({ ctx, body, requestId }) => {
  requirePerm(ctx, 'manage_policies');
  requireRecentAuth(ctx.session);
  const cur = activePolicy(ctx.orgId);
  const rules = body.rules;
  if (!rules || typeof rules !== 'object' || !rules.limits || !rules.tools) throw errors.invalid('Regras inválidas: limits e tools são obrigatórios.');
  // Ações fora do MVP não podem ser habilitadas por edição de política
  for (const k of ['payment_or_refund', 'block_customer_or_delete_data', 'production_change_or_access']) rules.tools[k] = { enabled: false, mode: 'deny' };
  for (const [k, v] of Object.entries(rules.tools)) {
    if (!['allow', 'require_approval', 'deny'].includes(v.mode)) throw errors.invalid(`Modo inválido para ${k}.`);
    if (!['create_internal_task', 'publish_instagram_post', 'master_update_settings', 'master_update_plan', 'master_update_product_params', 'master_extend_trial'].includes(k)) v.executor = false;
  }
  const L = rules.limits;
  const bound = (k, lo, hi) => { const n = Number(L[k]); if (!Number.isFinite(n) || n < lo || n > hi) throw errors.invalid(`Limite ${k} fora da faixa (${lo}–${hi}).`); L[k] = n; };
  bound('max_specialists', 1, 3); bound('max_review_rounds', 0, 2); bound('max_model_calls', 3, 30); bound('max_parallel_agents', 1, 3); bound('max_retries', 0, 2);
  bound('analysis_timeout_ms', 60000, 1800000); bound('approval_ttl_hours', 1, 168); bound('max_tokens_per_run', 5000, 1000000); bound('monthly_token_budget', 10000, 100000000);
  const id = uuid();
  insert('policy_versions', { id, organization_id: ctx.orgId, version: cur.version + 1, rules, effective_from: now(), created_by: ctx.userId, created_at: now() });
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'policy.version_created', objectType: 'policy_version', objectId: id, requestId, metadata: { version: cur.version + 1 } });
  return { ok: true, version: cur.version + 1 };
});

// ---------------- Auditoria e consumo ----------------
router.get('/api/audit', ({ ctx, url }) => {
  requirePerm(ctx, 'view_audit');
  const objectId = url.searchParams.get('object_id');
  return q.all(`SELECT a.id, a.actor_type, a.actor_id, a.event_type, a.object_type, a.object_id, a.request_id, a.metadata, a.created_at, u.display_name AS actor_name
    FROM audit_events a LEFT JOIN users u ON u.id = a.actor_id WHERE a.organization_id = ? ${objectId ? 'AND a.object_id = ?' : ''} ORDER BY a.created_at DESC LIMIT 300`, ctx.orgId, ...(objectId ? [objectId] : []))
    .map((r) => ({ ...r, metadata: json(r.metadata, {}) }));
});

router.get('/api/usage', ({ ctx }) => {
  requirePerm(ctx, 'view');
  const byAgent = q.all(`SELECT t.agent_code, COUNT(*) AS calls, SUM(u.input_tokens) AS input_tokens, SUM(u.output_tokens) AS output_tokens, SUM(CAST(u.cost_amount AS REAL)) AS cost
    FROM usage_records u LEFT JOIN agent_tasks t ON t.id = u.agent_task_id WHERE u.organization_id = ? AND u.created_at >= ? GROUP BY t.agent_code`, ctx.orgId, monthStart());
  const byRun = q.all(`SELECT u.run_id, d.question, COUNT(*) AS calls, SUM(u.input_tokens + u.output_tokens) AS tokens, SUM(CAST(u.cost_amount AS REAL)) AS cost
    FROM usage_records u JOIN runs r ON r.id = u.run_id JOIN decisions d ON d.id = r.decision_id WHERE u.organization_id = ? GROUP BY u.run_id ORDER BY MAX(u.created_at) DESC LIMIT 20`, ctx.orgId);
  return { by_agent: byAgent, by_run: byRun };
});

// ---------------- Administração ----------------
router.get('/api/admin/members', ({ ctx }) => {
  requirePerm(ctx, 'manage_members');
  return q.all('SELECT m.id, m.role, m.status, m.created_at, u.email, u.display_name FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? ORDER BY m.created_at', ctx.orgId)
    .map((m) => ({ ...m, products: q.all('SELECT p.code FROM member_product_scopes s JOIN products p ON p.id = s.product_id WHERE s.member_id = ?', m.id).map((r) => r.code) }));
});

router.post('/api/admin/members', ({ ctx, body, requestId }) => {
  requirePerm(ctx, 'manage_members');
  requireRecentAuth(ctx.session);
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw errors.invalid('E-mail inválido.');
  const role = ['owner', 'manager', 'analyst', 'viewer'].includes(body.role) ? body.role : null;
  if (!role) throw errors.invalid('Papel inválido.');
  const productCodes = Array.isArray(body.products) ? body.products.map(String) : [];
  const tempPassword = `${crypto.randomBytes(6).toString('base64url')}${Math.floor(Math.random() * 90 + 10)}`;
  return tx(() => {
    let user = q.get('SELECT * FROM users WHERE email = ?', email);
    let created = false;
    if (!user) {
      user = { id: uuid(), email, display_name: clampText(String(body.name || email.split('@')[0]), 80), password_hash: hashPassword(tempPassword), status: 'active', created_at: now() };
      insert('users', user); created = true;
    }
    if (q.get('SELECT id FROM organization_members WHERE organization_id = ? AND user_id = ?', ctx.orgId, user.id)) throw errors.conflict('Usuário já é membro.');
    const memberId = addMember(ctx.orgId, user.id, role, { allProducts: false });
    for (const code of productCodes) {
      const p = q.get('SELECT id FROM products WHERE organization_id = ? AND code = ?', ctx.orgId, code);
      if (p) insert('member_product_scopes', { id: uuid(), organization_id: ctx.orgId, member_id: memberId, product_id: p.id, permission: 'read_aggregate', source_scope_ref: null });
    }
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'member.added', objectType: 'organization_member', objectId: memberId, requestId, metadata: { role, products: productCodes } });
    return { ok: true, temporary_password: created ? tempPassword : null, note: created ? 'Senha temporária exibida uma única vez. Oriente o usuário a trocá-la no primeiro acesso.' : 'Usuário existente vinculado; senha inalterada.' };
  });
});

router.put('/api/admin/members/:id', ({ ctx, params, body, requestId }) => {
  requirePerm(ctx, 'manage_members');
  requireRecentAuth(ctx.session);
  const m = loadOwned('organization_members', params.id, ctx);
  if (m.user_id === ctx.userId) throw errors.forbidden('Você não pode alterar o próprio papel ou escopo.');
  return tx(() => {
    if (body.role) {
      if (!['owner', 'manager', 'analyst', 'viewer'].includes(body.role)) throw errors.invalid('Papel inválido.');
      q.run('UPDATE organization_members SET role = ? WHERE id = ?', body.role, m.id);
    }
    if (body.status) {
      if (!['active', 'disabled'].includes(body.status)) throw errors.invalid('Status inválido.');
      q.run('UPDATE organization_members SET status = ? WHERE id = ?', body.status, m.id);
      if (body.status === 'disabled') q.run('DELETE FROM sessions WHERE user_id = ?', m.user_id);
    }
    if (Array.isArray(body.products)) {
      q.run('DELETE FROM member_product_scopes WHERE member_id = ?', m.id);
      for (const code of body.products) {
        const p = q.get('SELECT id FROM products WHERE organization_id = ? AND code = ?', ctx.orgId, String(code));
        if (p) insert('member_product_scopes', { id: uuid(), organization_id: ctx.orgId, member_id: m.id, product_id: p.id, permission: 'read_aggregate', source_scope_ref: null });
      }
    }
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'member.updated', objectType: 'organization_member', objectId: m.id, requestId, metadata: { role: body.role, status: body.status, products: body.products } });
    return { ok: true };
  });
});

router.post('/api/admin/pause', ({ ctx, body, requestId }) => {
  requirePerm(ctx, 'pause');
  const paused = body.paused ? 1 : 0;
  q.run('UPDATE organizations SET executions_paused = ? WHERE id = ?', paused, ctx.orgId);
  audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: paused ? 'org.executions_paused' : 'org.executions_resumed', requestId });
  return { ok: true, paused: !!paused };
});

// ---------------- Eventos de integração (HMAC + proteção contra replay) ----------------
router.post('/api/events/:source', ({ params, req, raw, body, requestId }) => {
  const key = secret(config.events.hmacSecretRef);
  if (!key) throw errors.unavailable('Recepção de eventos não configurada.');
  const ts = Number(req.headers['x-lorler-timestamp']);
  const eventId = String(req.headers['x-lorler-event-id'] || '');
  const sig = String(req.headers['x-lorler-signature'] || '');
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > config.events.windowSeconds) throw errors.unauth();
  const expected = crypto.createHmac('sha256', key).update(`${ts}.${eventId}.`).update(raw).digest('hex');
  if (!eventId || !safeEqual(sig, expected)) throw errors.unauth();
  const source = clampText(params.source, 40);
  try { insert('inbound_events', { id: uuid(), source, event_id: eventId, received_at: now() }); } catch { return { ok: true, duplicate: true }; }
  audit({ actorType: 'service', actorId: source, event: 'event.received', requestId, metadata: { type: clampText(String(body.type || ''), 60) } });
  return { ok: true };
}, { public: true, rawBody: true, noCsrf: true });

// ---------------- SSE ----------------
// Fluxo de atividade de toda a organização (o cérebro da visão geral reage às análises em andamento)
const runOrgCache = new Map();
export function handleOrgSse(req, res, ctx) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': conectado\n\n');
  const onEv = (e) => {
    let org = runOrgCache.get(e.runId);
    if (!org) { org = q.get('SELECT organization_id FROM runs WHERE id = ?', e.runId)?.organization_id; if (org) runOrgCache.set(e.runId, org); }
    if (org !== ctx.orgId) return;
    res.write(`data: ${JSON.stringify({ runId: e.runId, type: e.type, status: e.status, from: e.from, to: e.to, msgType: e.msgType, agent: e.agent, state: e.state, kind: e.kind, count: e.count, sources: e.sources, final: e.final })}\n\n`);
  };
  bus.on('any', onEv);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); bus.off('any', onEv); });
}

export function handleSse(req, res, ctx, runId) {
  const run = q.get('SELECT id FROM runs WHERE id = ? AND organization_id = ?', runId, ctx.orgId);
  if (!run) throw errors.notFound();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write(': conectado\n\n');
  const onEv = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  bus.on(`run:${runId}`, onEv);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(ping); bus.off(`run:${runId}`, onEv); });
}

export { validatePasswordStrength };
