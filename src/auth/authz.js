// Autorização derivada da sessão + cadastro de membros. Nada vindo do cliente ou do modelo concede acesso.
import { q } from '../db.js';
import { errors } from '../lib/util.js';

export const PERMISSIONS = {
  owner: ['view', 'create_decision', 'approve', 'manage_agents', 'manage_policies', 'manage_members', 'manage_integrations', 'manage_knowledge', 'view_audit', 'pause'],
  manager: ['view', 'create_decision', 'approve', 'manage_knowledge'],
  analyst: ['view', 'create_decision'],
  viewer: ['view'],
};

export function buildContext(session, requestedOrgId) {
  const memberships = q.all(
    `SELECT m.*, o.name AS org_name, o.timezone, o.executions_paused FROM organization_members m
     JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ? AND m.status = 'active' AND o.status <> 'disabled' ORDER BY m.created_at`,
    session.user_id,
  );
  if (!memberships.length) throw errors.forbidden('Seu usuário não possui vínculo ativo com nenhuma organização.');
  let m = memberships[0];
  if (requestedOrgId) {
    m = memberships.find((x) => x.organization_id === requestedOrgId);
    if (!m) throw errors.notFound(); // não revela existência de outras organizações
  }
  const productIds = q.all(
    'SELECT DISTINCT product_id FROM member_product_scopes WHERE member_id = ? AND organization_id = ?',
    m.id, m.organization_id,
  ).map((r) => r.product_id);
  return {
    userId: session.user_id,
    email: session.email,
    name: session.display_name,
    orgId: m.organization_id,
    orgName: m.org_name,
    timezone: m.timezone,
    paused: !!m.executions_paused,
    memberId: m.id,
    role: m.role,
    productIds: new Set(productIds),
    memberships: memberships.map((x) => ({ orgId: x.organization_id, name: x.org_name, role: x.role })),
    session,
  };
}

export function can(ctx, perm) { return (PERMISSIONS[ctx.role] || []).includes(perm); }

export function requirePerm(ctx, perm) {
  if (!can(ctx, perm)) throw errors.forbidden();
}

export function requireProducts(ctx, productIds) {
  for (const id of productIds) {
    const p = q.get("SELECT id FROM products WHERE id = ? AND organization_id = ? AND status = 'active'", id, ctx.orgId);
    if (!p) throw errors.invalid('Produto inexistente ou inativo nesta organização.');
    if (!ctx.productIds.has(id)) throw errors.forbidden('Você não possui escopo sobre um dos produtos selecionados.');
  }
}

// Carrega objeto garantindo que pertence à organização da sessão.
export function loadOwned(table, id, ctx) {
  const allowed = new Set(['decisions', 'runs', 'action_proposals', 'agents', 'integrations', 'knowledge_documents', 'products', 'organization_members']);
  if (!allowed.has(table)) throw new Error('tabela não permitida');
  const row = q.get(`SELECT * FROM ${table} WHERE id = ? AND organization_id = ?`, String(id || ''), ctx.orgId);
  if (!row) throw errors.notFound();
  return row;
}
