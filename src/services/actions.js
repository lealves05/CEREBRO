// Propostas de ação, aprovações e executor (separado das ferramentas de análise).
import { q, insert, uuid, now, addMs, tx, json } from '../db.js';
import { canonicalJson, sha256, errors, toCents, fromCents, clampText } from '../lib/util.js';
import { evaluate, activePolicy } from './policy.js';
import { audit } from './audit.js';
import { can } from '../auth/authz.js';
import { emit } from '../orchestrator/events.js';
import { publishImage, findPublished, validatePost } from '../connectors/instagram.js';
import { applyAction as masterApply, isApplied as masterIsApplied } from '../connectors/master.js';

const EXEC_TOOLS = ['create_internal_task', 'change_price_or_discount', 'send_customer_message', 'paid_campaign', 'publish_instagram_post', 'master_update_settings', 'master_update_plan', 'master_update_product_params', 'master_extend_trial'];
export const MASTER_TOOLS = ['master_update_settings', 'master_update_plan', 'master_update_product_params', 'master_extend_trial'];

// Normaliza mudanças da Área Master. Os valores "antes" vêm das evidências coletadas pelo servidor, nunca do modelo.
export function normalizeMaster(tool, src, runId) {
  const product = String(src.product || src.product_code || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 30);
  const cfgRow = q.all("SELECT payload_ref FROM evidence_items WHERE run_id = ? AND payload_ref LIKE '%\"kind\":\"master_config\"%'", runId).map((r) => json(r.payload_ref, {})).find((x) => x.product === product);
  const out = { product };
  if (tool === 'master_update_settings') {
    const allowed = ['trial_default', 'grace_days', 'renewal_notice_days', 'signup_enabled', 'support_contact', 'support_whatsapp', 'support_email', 'support_hours', 'support_message'];
    out.values = Object.fromEntries(Object.entries(src.values || {}).filter(([k]) => allowed.includes(k)).slice(0, 9));
    out.before = Object.fromEntries(Object.keys(out.values).map((k) => [k, cfgRow?.settings?.[k] ?? null]));
  } else if (tool === 'master_update_plan') {
    const fields = ['name', 'description', 'monthly_price', 'annual_price', 'max_users', 'active'];
    const plan = cfgRow?.plans?.find((x) => x.id === src.plan_id || (src.plan_code && x.code === String(src.plan_code).toUpperCase()));
    out.plan_id = plan?.id || String(src.plan_id || '');
    out.plan_name = plan?.name || null;
    out.changes = Object.fromEntries(Object.entries(src.changes || {}).filter(([k]) => fields.includes(k)).map(([k, v]) => [k, ['monthly_price', 'annual_price', 'max_users'].includes(k) ? (v == null ? null : Number(v)) : v]));
    out.before = plan ? Object.fromEntries(Object.keys(out.changes).map((k) => [k, ['monthly_price', 'annual_price', 'max_users'].includes(k) ? (plan[k] == null ? null : Number(plan[k])) : plan[k] ?? null])) : {};
  } else if (tool === 'master_update_product_params') {
    out.values = Object.fromEntries(Object.entries(src.values || {}).slice(0, 20));
    out.before = Object.fromEntries(Object.keys(out.values).map((k) => [k, cfgRow?.params?.[k] ?? null]));
  } else if (tool === 'master_extend_trial') {
    out.tenant_id = String(src.tenant_id || '').slice(0, 60);
    out.tenant_name = clampText(String(src.tenant_name || ''), 120);
    out.days = Math.max(0, Math.min(365, parseInt(src.days, 10) || 0));
  }
  out.source_evidence = cfgRow ? 'master_config' : null;
  return out;
}

// Normaliza o conteúdo de um post do Instagram. A legenda final (com hashtags) é exatamente o que será publicado.
export function normalizeInstagram(src = {}) {
  const tags = (Array.isArray(src.hashtags) ? src.hashtags : String(src.hashtags || '').split(/[\s,]+/))
    .map((h) => String(h).replace(/^#/, '').replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean).slice(0, 30);
  const body = String(src.caption_body ?? src.caption ?? '').replace(/(\s#[\p{L}\p{N}_]+)+\s*$/u, '').trim().slice(0, 2000);
  const caption = [body, tags.map((t) => `#${t}`).join(' ')].filter(Boolean).join('\n\n').slice(0, 2200);
  return {
    caption_body: body, hashtags: tags, caption,
    image_url: String(src.image_url || '').trim().slice(0, 1000),
    image_brief: clampText(String(src.image_brief || ''), 800),
    suggested_time: clampText(String(src.suggested_time || ''), 120),
    call_to_action: clampText(String(src.call_to_action || ''), 200),
  };
}

export function canonicalPayload(p) {
  return {
    organization_id: p.organization_id,
    decision_id: p.decision_id,
    run_id: p.run_id,
    version: p.version,
    tool_code: p.tool_code,
    product_id: p.product_id || null,
    target: p.target,
    parameters: typeof p.parameters === 'string' ? json(p.parameters, {}) : p.parameters,
    policy_version_id: p.policy_version_id,
    expires_at: p.expires_at || null,
  };
}
export const payloadHash = (p) => sha256(canonicalJson(canonicalPayload(p)));

// Cria proposta a partir da intenção registrada pelo coordenador. O modelo não define status, aprovação nem hash.
export function createProposal({ run, decision, intent }) {
  const orgId = run.organization_id;
  const policy = activePolicy(orgId);
  const tool = EXEC_TOOLS.includes(intent?.tool_code) ? intent.tool_code : 'none';
  let product = null;
  if (intent?.product_code) product = q.get('SELECT id, code FROM products WHERE organization_id = ? AND code = ?', orgId, String(intent.product_code).toUpperCase());
  let extra = {};
  try { extra = intent?.parameters_json ? JSON.parse(intent.parameters_json) : {}; } catch { extra = { invalid_parameters: true }; }
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) extra = {};
  const maxAmount = toCents(intent?.max_amount || '0');
  const ttlH = policy.rules.limits?.approval_ttl_hours ?? 24;
  const prev = q.get('SELECT MAX(version) AS v FROM action_proposals WHERE decision_id = ?', decision.id);
  const parameters = {
    title: clampText(intent?.title || 'Recomendação consultiva', 200),
    description: clampText(intent?.description || '', 2000),
    ...Object.fromEntries(Object.entries(extra).slice(0, 20).map(([k, v]) => [clampText(k, 40), typeof v === 'object' || typeof v === 'number' || typeof v === 'boolean' ? v : clampText(String(v), 400)])),
    max_amount: fromCents(maxAmount === null || maxAmount < 0n ? 0n : maxAmount),
    currency: 'BRL',
    due_in_days: Number.isInteger(intent?.due_in_days) ? Math.min(Math.max(intent.due_in_days, 1), 180) : 14,
  };
  if (tool === 'publish_instagram_post') Object.assign(parameters, normalizeInstagram(extra));
  if (MASTER_TOOLS.includes(tool)) { for (const k of Object.keys(extra)) delete parameters[k]; Object.assign(parameters, normalizeMaster(tool, extra, run.id)); }
  return persistProposal({ run, decision, tool, productId: product?.id || null, target: intent?.target, parameters, ttlH, policy });
}

function persistProposal({ run, decision, tool, productId, target, parameters, ttlH, policy, actor = { type: 'agent', id: 'coordinator' } }) {
  const orgId = run.organization_id;
  const prev = q.get('SELECT MAX(version) AS v FROM action_proposals WHERE decision_id = ?', decision.id);
  const row = {
    id: uuid(), organization_id: orgId, run_id: run.id, decision_id: decision.id,
    version: (prev?.v || 0) + 1, supersedes_id: null, tool_code: tool, product_id: productId,
    target: clampText(target || '—', 300), parameters, summary: parameters.title,
    payload_hash: '', policy_version_id: policy.id, status: 'draft',
    expires_at: tool === 'none' ? null : addMs(ttlH * 3600_000), created_at: now(),
  };
  if (prev?.v) {
    const last = q.get('SELECT id FROM action_proposals WHERE decision_id = ? ORDER BY version DESC LIMIT 1', decision.id);
    row.supersedes_id = last?.id || null;
    // Propostas anteriores ainda pendentes deixam de valer
    q.run("UPDATE action_proposals SET status = 'expired' WHERE decision_id = ? AND status IN ('awaiting_approval','draft')", decision.id);
  }
  row.payload_hash = payloadHash(row);
  insert('action_proposals', row);
  const ev = evaluate({ ...row, parameters: JSON.stringify(row.parameters) }, { stage: 'proposal' });
  insert('policy_evaluations', { id: uuid(), organization_id: orgId, action_proposal_id: row.id, policy_version_id: policy.id, stage: 'proposal', result: ev.result, required_approvers: ev.required_approvers, checks: ev.checks, evaluated_at: now() });
  const status = tool === 'none' ? 'advisory' : ev.result === 'deny' ? 'denied' : ev.result === 'require_approval' ? 'awaiting_approval' : 'approved';
  q.run('UPDATE action_proposals SET status = ? WHERE id = ?', status, row.id);
  audit({ orgId, actorType: actor.type, actorId: actor.id, event: 'proposal.created', objectType: 'action_proposal', objectId: row.id, metadata: { tool, policy_result: ev.result, version: row.version } });
  if (status === 'awaiting_approval') {
    insert('outbox_events', { id: uuid(), organization_id: orgId, event_key: `approval-needed:${row.id}`, type: 'approval.requested', payload: { proposal_id: row.id, decision_id: decision.id }, status: 'pending', attempts: 0, next_attempt_at: now(), created_at: now() });
  }
  return { proposal: { ...row, status }, evaluation: ev };
}

function loadProposal(ctx, id) {
  const p = q.get('SELECT * FROM action_proposals WHERE id = ? AND organization_id = ?', String(id || ''), ctx.orgId);
  if (!p) throw errors.notFound();
  return p;
}

function expireIfNeeded(p) {
  if (p.status === 'awaiting_approval' && p.expires_at && p.expires_at <= now()) {
    q.run("UPDATE action_proposals SET status = 'expired' WHERE id = ? AND status = 'awaiting_approval'", p.id);
    throw errors.conflict('Proposta expirada. Gere uma nova execução da análise.');
  }
}

function decideCommon(ctx, id, body) {
  if (!can(ctx, 'approve')) throw errors.forbidden('Seu papel não permite aprovar, rejeitar ou revisar propostas.');
  const p = loadProposal(ctx, id);
  expireIfNeeded(p);
  if (p.status !== 'awaiting_approval') throw errors.conflict(`Proposta não está aguardando aprovação (status: ${p.status}).`);
  if (Number(body?.proposal_version) !== p.version) throw errors.conflict('Versão da proposta divergente. Recarregue a tela.');
  if (String(body?.payload_hash || '') !== p.payload_hash) throw errors.conflict('Hash da proposta divergente. A proposta exibida não corresponde à registrada.');
  if (payloadHash(p) !== p.payload_hash) throw errors.conflict('Integridade da proposta violada. Ação bloqueada.');
  const ev = q.get("SELECT required_approvers FROM policy_evaluations WHERE action_proposal_id = ? AND stage = 'proposal' ORDER BY evaluated_at DESC LIMIT 1", p.id);
  const roles = json(ev?.required_approvers, ['owner']);
  if (!roles.includes(ctx.role)) throw errors.forbidden(`Esta proposta exige aprovação de: ${roles.join(', ')}.`);
  return p;
}

export async function approve(ctx, id, body, requestId) {
  const result = tx(() => {
    const p = decideCommon(ctx, id, body);
    if (p.tool_code === 'publish_instagram_post') {
      const errs = validatePost(json(p.parameters, {}));
      if (errs.length) throw errors.conflict(`Complete o conteúdo antes de aprovar: ${errs.join('; ')}.`);
    }
    const approvalId = uuid();
    try {
      insert('approvals', { id: approvalId, organization_id: ctx.orgId, action_proposal_id: p.id, proposal_version: p.version, payload_hash: p.payload_hash, approver_id: ctx.userId, result: 'approved', comment: clampText(body?.comment || '', 1000), expires_at: p.expires_at || addMs(86400_000), decided_at: now() });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw errors.conflict('Esta proposta já recebeu uma decisão.');
      throw e;
    }
    const upd = q.run("UPDATE action_proposals SET status = 'approved' WHERE id = ? AND status = 'awaiting_approval'", p.id);
    if (upd.changes !== 1) throw errors.conflict('Transição de estado concorrente detectada.');
    q.run("UPDATE decisions SET status = 'approved' WHERE id = ?", p.decision_id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'proposal.approved', objectType: 'action_proposal', objectId: p.id, requestId, metadata: { version: p.version } });
    return { proposalId: p.id, approvalId };
  });
  const exec = await execute(result.proposalId, ctx.orgId, requestId);
  return { ...result, execution: exec };
}

// Edição humana do conteúdo de um post (legenda, hashtags, imagem): gera NOVA versão da proposta,
// com novo hash e nova avaliação de política. A aprovação anterior nunca é reaproveitada.
export function reviseContent(ctx, id, body, requestId) {
  if (!can(ctx, 'approve')) throw errors.forbidden();
  return tx(() => {
    const p = loadProposal(ctx, id);
    if (p.tool_code !== 'publish_instagram_post') throw errors.invalid('Somente propostas de publicação podem ter o conteúdo editado.');
    if (!['awaiting_approval', 'failed'].includes(p.status)) throw errors.conflict(`Proposta não pode ser editada (status: ${p.status}).`);
    if (Number(body?.proposal_version) !== p.version) throw errors.conflict('Versão divergente. Recarregue a tela.');
    const old = json(p.parameters, {});
    const content = normalizeInstagram({
      caption_body: body.caption_body ?? old.caption_body,
      hashtags: body.hashtags ?? old.hashtags,
      image_url: body.image_url ?? old.image_url,
      image_brief: old.image_brief, suggested_time: body.suggested_time ?? old.suggested_time, call_to_action: old.call_to_action,
    });
    if (content.image_url) { try { if (new URL(content.image_url).protocol !== 'https:') throw new Error(); } catch { throw errors.invalid('A imagem deve ser uma URL pública HTTPS.'); } }
    const policy = activePolicy(ctx.orgId);
    const run = q.get('SELECT * FROM runs WHERE id = ?', p.run_id);
    const decision = q.get('SELECT * FROM decisions WHERE id = ?', p.decision_id);
    if (p.status === 'failed') q.run("UPDATE action_proposals SET status = 'expired' WHERE id = ?", p.id);
    const r = persistProposal({ run, decision, tool: p.tool_code, productId: p.product_id, target: p.target, parameters: { ...old, ...content, edited_by_human: true }, ttlH: policy.rules.limits?.approval_ttl_hours ?? 24, policy, actor: { type: 'user', id: ctx.userId } });
    q.run("UPDATE decisions SET status = ? WHERE id = ?", r.proposal.status === 'awaiting_approval' ? 'awaiting_approval' : decision.status, decision.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'proposal.content_revised', objectType: 'action_proposal', objectId: r.proposal.id, requestId, metadata: { from_version: p.version, to_version: r.proposal.version } });
    return { proposal_id: r.proposal.id, version: r.proposal.version, status: r.proposal.status, payload_hash: r.proposal.payload_hash };
  });
}

export function reject(ctx, id, body, requestId) {
  return tx(() => {
    const p = decideCommon(ctx, id, body);
    insert('approvals', { id: uuid(), organization_id: ctx.orgId, action_proposal_id: p.id, proposal_version: p.version, payload_hash: p.payload_hash, approver_id: ctx.userId, result: 'rejected', comment: clampText(body?.comment || '', 1000), expires_at: p.expires_at || now(), decided_at: now() });
    q.run("UPDATE action_proposals SET status = 'rejected' WHERE id = ?", p.id);
    q.run("UPDATE decisions SET status = 'rejected' WHERE id = ?", p.decision_id);
    insert('agent_messages', { id: uuid(), organization_id: ctx.orgId, run_id: p.run_id, round: 99, sender_agent_id: null, recipient_agent_id: null, sender_code: 'approver', recipient_code: 'coordinator', reply_to_id: null, type: 'task', content: { text: `Proposta v${p.version} rejeitada pelo aprovador.${body?.comment ? ` Motivo: ${clampText(body.comment, 500)}` : ''}` }, created_at: now() });
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'proposal.rejected', objectType: 'action_proposal', objectId: p.id, requestId });
    emit(p.run_id, { type: 'proposal', status: 'rejected' });
    return { ok: true };
  });
}

export function requestRevision(ctx, id, body, requestId) {
  return tx(() => {
    const p = decideCommon(ctx, id, body);
    insert('approvals', { id: uuid(), organization_id: ctx.orgId, action_proposal_id: p.id, proposal_version: p.version, payload_hash: p.payload_hash, approver_id: ctx.userId, result: 'revision_requested', comment: clampText(body?.comment || '', 1000), expires_at: p.expires_at || now(), decided_at: now() });
    q.run("UPDATE action_proposals SET status = 'revision_requested' WHERE id = ?", p.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'proposal.revision_requested', objectType: 'action_proposal', objectId: p.id, requestId });
    return { decisionId: p.decision_id, comment: clampText(body?.comment || '', 1000) };
  });
}

export function revoke(ctx, id, requestId) {
  if (!can(ctx, 'approve')) throw errors.forbidden();
  return tx(() => {
    const p = loadProposal(ctx, id);
    const exec = q.get("SELECT status FROM action_executions WHERE action_proposal_id = ? AND status IN ('running','succeeded','uncertain')", p.id);
    if (exec) throw errors.conflict(`Não é possível revogar: execução ${exec.status}.`);
    if (p.status !== 'approved') throw errors.conflict('Somente propostas aprovadas e não executadas podem ser revogadas.');
    insert('approvals', { id: uuid(), organization_id: ctx.orgId, action_proposal_id: p.id, proposal_version: p.version, payload_hash: p.payload_hash, approver_id: ctx.userId, result: 'revoked', comment: null, expires_at: now(), decided_at: now() });
    q.run("UPDATE action_proposals SET status = 'canceled' WHERE id = ?", p.id);
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'proposal.revoked', objectType: 'action_proposal', objectId: p.id, requestId });
    return { ok: true };
  });
}

// ---------------- Executor ----------------
export const idempotencyKey = (p) => `exec:${p.id}:v${p.version}:${p.payload_hash.slice(0, 16)}`;

// Pontos de injeção para testes (simular timeout externo)
export const executorHooks = { beforeEffect: null };

export async function execute(proposalId, orgId, requestId = null) {
  const p = q.get('SELECT * FROM action_proposals WHERE id = ? AND organization_id = ?', proposalId, orgId);
  if (!p) throw errors.notFound();
  const org = q.get('SELECT executions_paused FROM organizations WHERE id = ?', orgId);
  if (org?.executions_paused) return { status: 'blocked', reason: 'Execuções pausadas pelo administrador.' };
  const key = idempotencyKey(p);

  // Adquire a execução (chave única impede concorrência e duplicidade)
  let execId;
  const acquired = tx(() => {
    const existing = q.get('SELECT * FROM action_executions WHERE idempotency_key = ?', key);
    if (existing) return { existing };
    const approval = q.get("SELECT * FROM approvals WHERE action_proposal_id = ? AND result = 'approved' ORDER BY decided_at DESC LIMIT 1", p.id);
    const ev = evaluate(p, { stage: 'execution', approval });
    insert('policy_evaluations', { id: uuid(), organization_id: orgId, action_proposal_id: p.id, policy_version_id: ev.policy_version_id || p.policy_version_id, stage: 'execution', result: ev.result, required_approvers: ev.required_approvers, checks: ev.checks, evaluated_at: now() });
    if (ev.result !== 'allow') {
      const failed = ev.checks.filter((c) => c.hard && !c.ok).map((c) => `${c.check}: ${c.detail}`);
      audit({ orgId, actorType: 'system', actorId: 'executor', event: 'execution.blocked', objectType: 'action_proposal', objectId: p.id, requestId, metadata: { reasons: failed } });
      return { blocked: failed.length ? failed : ['Aprovação pendente'] };
    }
    execId = uuid();
    insert('action_executions', { id: execId, organization_id: orgId, action_proposal_id: p.id, idempotency_key: key, status: 'running', external_ref: null, attempts: 1, result: null, started_at: now(), finished_at: null });
    q.run("UPDATE action_proposals SET status = 'executing' WHERE id = ?", p.id);
    q.run("UPDATE decisions SET status = 'executing' WHERE id = ?", p.decision_id);
    return { ok: true };
  });
  if (acquired.existing) return { status: acquired.existing.status, idempotent: true, execution_id: acquired.existing.id };
  if (acquired.blocked) return { status: 'blocked', reasons: acquired.blocked };

  try {
    if (executorHooks.beforeEffect) executorHooks.beforeEffect(p);
    const params = json(p.parameters, {});
    let externalRef = null; let resultData = null;
    if (MASTER_TOOLS.includes(p.tool_code)) {
      const approval = q.get("SELECT u.display_name FROM approvals a JOIN users u ON u.id = a.approver_id WHERE a.action_proposal_id = ? AND a.result = 'approved' ORDER BY a.decided_at DESC LIMIT 1", p.id);
      const r = await masterApply(p.tool_code, params, { reason: `Central de Decisões LORLER · decisão ${p.decision_id.slice(0, 8)} v${p.version} · aprovado por ${approval?.display_name || 'política'}` });
      externalRef = `master:${p.tool_code}:${params.product || params.tenant_id || ''}`; resultData = r;
    } else if (p.tool_code === 'publish_instagram_post') {
      const r = await publishImage(orgId, { caption: params.caption, image_url: params.image_url });
      externalRef = r.media_id; resultData = r;
    } else if (p.tool_code === 'create_internal_task') {
      const existingTask = q.get('SELECT id FROM internal_tasks WHERE business_ref = ?', key);
      externalRef = existingTask?.id || uuid();
      if (!existingTask) {
        insert('internal_tasks', { id: externalRef, organization_id: orgId, business_ref: key, title: params.title, description: [params.description, ...(Array.isArray(params.checklist) ? params.checklist.map((c) => `• ${c}`) : [])].filter(Boolean).join('\n'), product_id: p.product_id, owner_hint: params.owner || null, due_date: addMs((params.due_in_days || 14) * 86400_000).slice(0, 10), status: 'open', created_at: now() });
      }
    } else {
      throw Object.assign(new Error('Ferramenta sem executor habilitado'), { permanent: true });
    }
    tx(() => {
      q.run("UPDATE action_executions SET status = 'succeeded', external_ref = ?, result = ?, finished_at = ? WHERE id = ?", externalRef, JSON.stringify(resultData || { internal_task_id: externalRef }), now(), execId);
      q.run("UPDATE action_proposals SET status = 'executed' WHERE id = ?", p.id);
      q.run("UPDATE decisions SET status = 'completed' WHERE id = ?", p.decision_id);
      audit({ orgId, actorType: 'system', actorId: 'executor', event: 'execution.succeeded', objectType: 'action_execution', objectId: execId, requestId, metadata: { external_ref: externalRef, tool: p.tool_code } });
    });
    emit(p.run_id, { type: 'execution', status: 'succeeded' });
    return { status: 'succeeded', execution_id: execId, external_ref: externalRef };
  } catch (e) {
    const uncertain = e.uncertain === true;
    const status = uncertain ? 'uncertain' : 'failed';
    tx(() => {
      q.run('UPDATE action_executions SET status = ?, result = ?, finished_at = ? WHERE id = ?', status, JSON.stringify({ error: clampText(e.message, 300) }), now(), execId);
      q.run('UPDATE action_proposals SET status = ? WHERE id = ?', status, p.id);
      q.run('UPDATE decisions SET status = ? WHERE id = ?', uncertain ? 'executing' : 'failed', p.decision_id);
      audit({ orgId, actorType: 'system', actorId: 'executor', event: `execution.${status}`, objectType: 'action_execution', objectId: execId, requestId, metadata: { error: clampText(e.message, 300) } });
    });
    emit(p.run_id, { type: 'execution', status });
    return { status, execution_id: execId, error: e.message };
  }
}

// Conciliação de resultado incerto: consulta o destino pela referência de negócio antes de qualquer nova tentativa.
export async function reconcile(ctx, proposalId, requestId) {
  if (!can(ctx, 'approve')) throw errors.forbidden();
  const p = loadProposal(ctx, proposalId);
  const exec = q.get("SELECT * FROM action_executions WHERE action_proposal_id = ? AND status = 'uncertain'", p.id);
  if (!exec) throw errors.conflict('Não há execução incerta para conciliar.');
  let task;
  if (MASTER_TOOLS.includes(p.tool_code)) {
    const ok = await masterIsApplied(p.tool_code, json(p.parameters, {}));
    task = ok ? { id: `master:${p.tool_code}` } : null;
  } else if (p.tool_code === 'publish_instagram_post') {
    const found = await findPublished(ctx.orgId, json(p.parameters, {}).caption, exec.started_at);
    task = found ? { id: found.id } : null;
    if (found) q.run('UPDATE action_executions SET result = ? WHERE id = ?', JSON.stringify({ media_id: found.id, permalink: found.permalink, reconciled: true }), exec.id);
  } else task = q.get('SELECT id FROM internal_tasks WHERE business_ref = ?', exec.idempotency_key);
  tx(() => {
    if (task) {
      q.run("UPDATE action_executions SET status = 'succeeded', external_ref = ?, finished_at = ? WHERE id = ?", task.id, now(), exec.id);
      q.run("UPDATE action_proposals SET status = 'executed' WHERE id = ?", p.id);
      q.run("UPDATE decisions SET status = 'completed' WHERE id = ?", p.decision_id);
    } else {
      q.run("UPDATE action_executions SET status = 'failed', finished_at = ? WHERE id = ?", now(), exec.id);
      q.run("UPDATE action_proposals SET status = 'failed' WHERE id = ?", p.id);
      q.run("UPDATE decisions SET status = 'failed' WHERE id = ?", p.decision_id);
    }
    audit({ orgId: ctx.orgId, actorType: 'user', actorId: ctx.userId, event: 'execution.reconciled', objectType: 'action_execution', objectId: exec.id, requestId, metadata: { found: !!task } });
  });
  return { status: task ? 'succeeded' : 'failed', found: !!task };
}
