// Motor de políticas determinístico: allow | require_approval | deny. Calculado no servidor, nunca pelo modelo.
import { q, json, now, addMs } from '../db.js';
import { toCents, fromCents } from '../lib/util.js';
import { PERMISSIONS } from '../auth/authz.js';

export function activePolicy(orgId) {
  const p = q.get('SELECT * FROM policy_versions WHERE organization_id = ? AND effective_from <= ? ORDER BY version DESC LIMIT 1', orgId, now());
  return p ? { ...p, rules: json(p.rules, {}) } : null;
}

function knowledgeDiscountRules(orgId, isDemo) {
  // Regras estruturadas de documentos vigentes podem ser MAIS restritivas que a política (nunca mais permissivas).
  const rows = q.all(`SELECT v.content, v.expires_at, d.is_demo FROM knowledge_documents d JOIN knowledge_versions v ON v.id = d.current_version_id
    WHERE d.organization_id = ? AND d.status = 'active' AND (v.expires_at IS NULL OR v.expires_at > ?)`, orgId, now());
  let rules = null;
  for (const r of rows) {
    if (!isDemo && r.is_demo) continue;
    const m = /\[regras estruturadas\]\s*(\{.*\})/s.exec(r.content);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]);
      if (parsed.max_discount_pct != null) rules = parsed;
    } catch { /* ignora */ }
  }
  return rules;
}

function businessSpentThisMonth(orgId, excludeProposalId) {
  const start = new Date(); start.setUTCDate(1); start.setUTCHours(3, 0, 0, 0);
  const rows = q.all(`SELECT parameters FROM action_proposals WHERE organization_id = ? AND id <> ? AND status IN ('approved','executing','executed','uncertain') AND created_at >= ?`, orgId, excludeProposalId || '', start.toISOString());
  let total = 0n;
  for (const r of rows) total += toCents(json(r.parameters, {}).max_amount || '0') || 0n;
  return total;
}

/**
 * @param proposal linha de action_proposals
 * @param opts { stage: 'proposal'|'execution', approval?: linha de approvals }
 */
export function evaluate(proposal, { stage = 'proposal', approval = null } = {}) {
  const checks = [];
  const add = (check, ok, detail, hard = true) => checks.push({ check, ok, detail, hard });
  const orgId = proposal.organization_id;
  const params = json(proposal.parameters, {});
  const policy = activePolicy(orgId);
  const rules = policy?.rules || {};
  const toolRule = rules.tools?.[proposal.tool_code];
  const decision = q.get('SELECT * FROM decisions WHERE id = ? AND organization_id = ?', proposal.decision_id, orgId);

  // Identidade: quem originou a decisão continua membro ativo com permissão
  const member = decision && q.get(`SELECT m.* FROM organization_members m WHERE m.organization_id = ? AND m.user_id = ? AND m.status = 'active'`, orgId, decision.created_by);
  add('identidade', !!member && PERMISSIONS[member.role]?.includes('create_decision'), member ? `Solicitante: papel ${member.role}` : 'Solicitante sem vínculo ativo');

  // Escopo: produto pertence à organização e ao escopo do solicitante
  if (proposal.product_id) {
    const prod = q.get("SELECT id, code FROM products WHERE id = ? AND organization_id = ? AND status = 'active'", proposal.product_id, orgId);
    const scope = member && q.get('SELECT id FROM member_product_scopes WHERE member_id = ? AND product_id = ?', member.id, proposal.product_id);
    add('escopo', !!prod && !!scope, prod ? `Produto ${prod.code} ${scope ? 'autorizado' : 'fora do escopo do solicitante'}` : 'Produto inválido para a organização');
  } else add('escopo', true, 'Ação sem produto específico (organização)');

  // Ferramenta
  if (proposal.tool_code === 'none') {
    add('ferramenta', true, 'Recomendação consultiva — sem ação');
  } else if (!toolRule) add('ferramenta', false, `Nenhuma política ativa para ${proposal.tool_code}`);
  else if (toolRule.mode === 'deny') add('ferramenta', false, `${proposal.tool_code}: execução não permitida (fora do MVP)`);
  else if (!toolRule.enabled) add('ferramenta', false, `${proposal.tool_code}: ferramenta desabilitada na política v${policy.version}`);
  else add('ferramenta', true, `${proposal.tool_code} habilitada (modo ${toolRule.mode})`);

  // Dados: evidências da execução devem existir e não podem estar indisponíveis/desatualizadas para o produto
  const evs = q.all('SELECT quality, fetched_at, source_type, is_demo, product_id FROM evidence_items WHERE run_id = ? AND organization_id = ?', proposal.run_id, orgId);
  const prodEvs = evs.filter((e) => !proposal.product_id || e.product_id === proposal.product_id || e.product_id === null);
  const validityH = rules.data_validity_hours?.integration ?? 48;
  const staleLimit = addMs(-validityH * 3600_000);
  const hasGood = prodEvs.some((e) => (e.source_type === 'integration' || e.source_type === 'demo') && e.quality !== 'unavailable');
  const unavailable = hasGood ? [] : prodEvs.filter((e) => e.source_type !== 'knowledge' && e.quality === 'unavailable');
  const stale = prodEvs.filter((e) => e.source_type === 'integration' && (e.quality === 'stale' || e.fetched_at < staleLimit));
  const hasData = prodEvs.some((e) => e.source_type === 'integration' || e.source_type === 'demo');
  if (proposal.tool_code === 'none') add('dados', true, 'Não aplicável');
  else add('dados', hasData && !unavailable.length && !stale.length,
    !hasData ? 'Sem evidências de dados para o produto da ação' : unavailable.length ? `${unavailable.length} fonte(s) indisponível(is)` : stale.length ? `${stale.length} fonte(s) desatualizada(s) (validade ${validityH}h)` : `${prodEvs.length} evidência(s) válidas${prodEvs.some((e) => e.is_demo) ? ' — DEMONSTRAÇÃO' : ''}`);

  // Limites
  const limitIssues = [];
  if (proposal.tool_code === 'change_price_or_discount') {
    const pol = { ...(rules.discount || {}) };
    const kd = knowledgeDiscountRules(orgId, !!decision?.is_demo);
    if (kd) {
      pol.max_discount_pct = Math.min(pol.max_discount_pct ?? 100, kd.max_discount_pct);
      pol.approval_above_pct = Math.min(pol.approval_above_pct ?? 100, kd.approval_above_pct ?? 100);
      pol.max_duration_months = Math.min(pol.max_duration_months ?? 99, kd.max_duration_months ?? 99);
    }
    const d = Number(params.discount_pct);
    if (!Number.isFinite(d) || d <= 0) limitIssues.push('Percentual de desconto ausente ou inválido');
    else if (d > (pol.max_discount_pct ?? 0)) limitIssues.push(`Desconto ${d}% acima do teto ${pol.max_discount_pct}%`);
    if (params.duration_months != null && Number(params.duration_months) > (pol.max_duration_months ?? 0)) limitIssues.push(`Duração ${params.duration_months} meses acima do máximo ${pol.max_duration_months}`);
  }
  if (proposal.tool_code === 'publish_instagram_post') {
    const cap = String(params.caption || '');
    if (cap.length > 2200) limitIssues.push('Legenda acima de 2.200 caracteres');
    if ((cap.match(/#[\p{L}\p{N}_]+/gu) || []).length > 30) limitIssues.push('Mais de 30 hashtags');
    const day = addMs(-86400_000);
    const posted = q.get("SELECT COUNT(*) AS c FROM action_executions e JOIN action_proposals p ON p.id = e.action_proposal_id WHERE p.organization_id = ? AND p.tool_code = 'publish_instagram_post' AND e.status IN ('succeeded','running','uncertain') AND e.started_at >= ? AND p.id <> ?", orgId, day, proposal.id).c;
    const maxDay = toolRule?.max_posts_per_day ?? 3;
    if (posted >= maxDay) limitIssues.push(`Limite de ${maxDay} publicação(ões) por 24 h atingido`);
    if (decision?.is_demo && toolRule && toolRule.allow_demo_decisions === false) limitIssues.push('Política não permite publicar a partir de análises de demonstração');
  }
  if (proposal.tool_code?.startsWith('master_')) {
    if (decision?.is_demo && toolRule?.allow_demo_decisions !== true) limitIssues.push('Mudanças na Área Master não podem nascer de análise de demonstração (dados fictícios)');
    if (!params.product && proposal.tool_code !== 'master_extend_trial') limitIssues.push('Sistema (produto) da Área Master não informado');
    if (proposal.tool_code === 'master_update_settings') {
      const v = params.values || {};
      if (!Object.keys(v).length) limitIssues.push('Nenhum parâmetro a alterar');
      if (v.grace_days != null && (v.grace_days < 0 || v.grace_days > 60)) limitIssues.push('Carência fora de 0–60 dias');
      if (v.renewal_notice_days != null && (v.renewal_notice_days < 1 || v.renewal_notice_days > 60)) limitIssues.push('Aviso de vencimento fora de 1–60 dias');
      if (v.trial_default != null && !['NONE', '15_DAYS', '30_DAYS', 'UNLIMITED'].includes(v.trial_default)) limitIssues.push('Tipo de teste inválido');
      if (!params.source_evidence) limitIssues.push('Sem evidência atual da configuração da Área Master para registrar o valor anterior');
    }
    if (proposal.tool_code === 'master_update_plan') {
      if (!params.plan_id) limitIssues.push('Plano não identificado nas evidências da Área Master');
      const maxPct = toolRule?.max_price_change_pct ?? 30;
      for (const k of ['monthly_price', 'annual_price']) {
        const a = Number(params.before?.[k]); const b = Number(params.changes?.[k]);
        if (params.changes?.[k] != null && a > 0 && Math.abs(b - a) / a * 100 > maxPct) limitIssues.push(`Variação de ${k} acima de ${maxPct}% (${a} → ${b})`);
        if (params.changes?.[k] != null && (!(b >= 0) || b > 100000)) limitIssues.push(`${k} inválido`);
      }
      if (!Object.keys(params.changes || {}).length) limitIssues.push('Nenhuma alteração no plano');
    }
    if (proposal.tool_code === 'master_extend_trial') {
      const maxD = toolRule?.max_days ?? 60;
      if (!params.tenant_id) limitIssues.push('Empresa não identificada');
      if (!(params.days >= 1 && params.days <= maxD)) limitIssues.push(`Prorrogação deve ter entre 1 e ${maxD} dias`);
    }
    if (proposal.tool_code === 'master_update_product_params' && !Object.keys(params.values || {}).length) limitIssues.push('Nenhum parâmetro a alterar');
  }
  const maxAmount = toCents(params.max_amount ?? '0');
  if (maxAmount === null || maxAmount < 0n) limitIssues.push('Valor máximo inválido');
  add('limites', !limitIssues.length, limitIssues.length ? limitIssues.join('; ') : 'Dentro dos limites configurados');

  // Orçamento empresarial
  const budget = toCents(rules.business_budget?.monthly_limit ?? '0') ?? 0n;
  const spent = businessSpentThisMonth(orgId, proposal.id);
  const need = maxAmount || 0n;
  add('orcamento', need === 0n || spent + need <= budget, need === 0n ? 'Sem gasto empresarial previsto' : `Previsto ${fromCents(need)} BRL; usado no mês ${fromCents(spent)} de ${fromCents(budget)}`);

  // Atualidade
  const sameVersion = policy && proposal.policy_version_id === policy.id;
  const notExpired = !proposal.expires_at || proposal.expires_at > now();
  add('atualidade', sameVersion && notExpired, !sameVersion ? 'Política mudou desde a análise — nova proposta necessária' : !notExpired ? 'Proposta expirada' : `Política v${policy.version} vigente`);

  // Duplicidade
  const exec = q.get("SELECT status FROM action_executions WHERE action_proposal_id = ? AND status IN ('running','succeeded','uncertain')", proposal.id);
  add('duplicidade', !exec || stage === 'execution' && exec.status === 'running', exec ? `Execução já ${exec.status}` : 'Nenhuma execução anterior');

  // Aprovação
  const needsApproval = proposal.tool_code !== 'none' && toolRule?.mode === 'require_approval';
  const approvers = needsApproval ? toolRule.approver_roles || ['owner'] : [];
  let approvalOk = !needsApproval;
  if (needsApproval && stage === 'execution') {
    if (!approval) add('aprovacao', false, 'Aprovação inexistente');
    else {
      const approverMember = q.get(`SELECT role FROM organization_members WHERE organization_id = ? AND user_id = ? AND status = 'active'`, orgId, approval.approver_id);
      const okApproval = approval.result === 'approved' && approval.proposal_version === proposal.version && approval.payload_hash === proposal.payload_hash && approval.expires_at > now() && approverMember && approvers.includes(approverMember.role);
      add('aprovacao', okApproval, okApproval ? `Aprovado por papel ${approverMember.role}` : 'Aprovação não corresponde à proposta, expirou ou o aprovador perdeu o papel');
      approvalOk = okApproval;
    }
  } else if (needsApproval) add('aprovacao', true, `Exige aprovação de: ${approvers.join(', ')}`, false);
  else add('aprovacao', true, 'Não exige aprovação');

  // Conteúdo da publicação: pode ser completado pelo aprovador; obrigatório no momento da execução
  if (proposal.tool_code === 'publish_instagram_post') {
    const missing = [];
    if (!String(params.caption || '').trim()) missing.push('legenda');
    if (!/^https:\/\//.test(String(params.image_url || ''))) missing.push('imagem (URL HTTPS pública)');
    add('conteudo', !missing.length, missing.length ? `Falta: ${missing.join(', ')} — complete antes de aprovar` : 'Legenda e imagem definidas', stage === 'execution');
    if (decision?.is_demo) add('demonstracao', true, 'Conteúdo originado de análise de DEMONSTRAÇÃO — revise o texto antes de publicar', false);
  }

  // Executor (somente no momento da execução)
  if (stage === 'execution' && proposal.tool_code !== 'none') {
    let ok = !!toolRule?.executor; let detail = ok ? 'Executor habilitado' : 'Sem executor habilitado para esta ferramenta no MVP — aplicar pelo fluxo próprio do produto';
    if (ok && proposal.tool_code.startsWith('master_') && !(process.env.LORLER_MASTER_URL && process.env.LORLER_MASTER_USERNAME && process.env.LORLER_SECRET_MASTER_PASSWORD)) { ok = false; detail = 'Área Master não configurada no servidor (LORLER_MASTER_URL, usuário e senha)'; }
    if (ok && proposal.tool_code === 'publish_instagram_post') {
      const acc = q.get("SELECT status, token_expires_at, username FROM social_accounts WHERE organization_id = ? AND provider = 'instagram'", orgId);
      if (!acc || acc.status !== 'connected') { ok = false; detail = 'Conta do Instagram não vinculada (Integrações → Instagram)'; }
      else if (acc.token_expires_at && acc.token_expires_at < now()) { ok = false; detail = 'Token do Instagram expirado — vincule novamente'; }
      else detail = `Publicará em @${acc.username}`;
    }
    add('executor', ok, detail);
  }

  const hardFail = checks.some((c) => c.hard && !c.ok);
  let result;
  if (hardFail) result = 'deny';
  else if (needsApproval && !approvalOk) result = 'require_approval';
  else result = 'allow';
  return { result, required_approvers: approvers, checks, policy_version_id: policy?.id, policy_version: policy?.version };
}
