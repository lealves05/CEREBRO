// Instalação inicial da organização LORLER: produtos, agentes (versão 1), ferramentas, política v1,
// integrações pendentes e documentos de DEMONSTRAÇÃO (identificados). Não cria usuário nem senha.
import { q, insert, uuid, now, tx, addMs } from './db.js';
import { sha256 } from './lib/util.js';
import { AGENT_DEFS, TOOL_DEFS, COMMON, ROLE, DEFAULT_POLICY } from './agents/prompts.js';
import { DEMO_DOCUMENTS } from './connectors/demo.js';
import { audit } from './services/audit.js';

export const PRODUCTS = [
  ['ORBI', 'ORBI', 'Gestão para salões, barbearias e negócios de beleza'],
  ['TORVEN', 'TORVEN', 'Gestão para assistência técnica, soldas e serralheria'],
  ['RUSTEN', 'RUSTEN', 'Gestão e PDV para bares e restaurantes'],
  ['APOLVEN', 'APOLVEN', 'Quarto sistema da família LORLER (cadastro opcional)'],
];

export function ensureTools() {
  for (const [code, type, description] of TOOL_DEFS) {
    if (!q.get('SELECT id FROM tools WHERE code = ?', code)) {
      insert('tools', { id: uuid(), code, type, description, input_schema_version: '1.0', enabled: code === 'send_approved_message' ? 0 : 1 });
    }
  }
}

export function createOrganization(name = 'LORLER', { withDemoDocs = true } = {}) {
  return tx(() => {
    ensureTools();
    const orgId = uuid();
    insert('organizations', { id: orgId, name, timezone: 'America/Sao_Paulo', status: 'active', executions_paused: 0, created_at: now() });
    for (const [code, pname, desc] of PRODUCTS) {
      const pid = uuid();
      insert('products', { id: pid, organization_id: orgId, code, name: pname, description: desc, status: 'active' });
      insert('integrations', { id: uuid(), organization_id: orgId, product_id: pid, adapter: `${code.toLowerCase()}-v1`, adapter_version: '1.0', base_url: null, secret_ref: `LORLER_SECRET_${code}`, status: 'pending_setup' });
    }
    for (const def of AGENT_DEFS) {
      const agentId = uuid(); const verId = uuid();
      insert('agents', { id: agentId, organization_id: orgId, code: def.code, name: def.name, description: def.description, enabled: 1, active_version_id: null });
      insert('agent_versions', {
        id: verId, organization_id: orgId, agent_id: agentId, version: 1,
        instructions: `${COMMON}\n\n${ROLE[def.code]}`,
        model_config: { provider: 'default', model: '' },
        limits: { max_calls: def.code === 'coordinator' ? 3 : 3, max_output_tokens: 3000, timeout_ms: 90000 },
        output_schema_version: def.code === 'coordinator' ? 'plan+synthesis/1.0' : def.code === 'marketing' ? 'marketing_opinion/1.0' : 'opinion/1.0',
        accepts_from: def.accepts, created_by: null, created_at: now(),
      });
      q.run('UPDATE agents SET active_version_id = ? WHERE id = ?', verId, agentId);
      for (const t of def.tools) {
        const tool = q.get('SELECT id FROM tools WHERE code = ?', t);
        insert('agent_tool_grants', { id: uuid(), organization_id: orgId, agent_version_id: verId, tool_id: tool.id, scope: 'aggregate', limits: {} });
      }
    }
    insert('policy_versions', { id: uuid(), organization_id: orgId, version: 1, rules: DEFAULT_POLICY, effective_from: now(), created_by: null, created_at: now() });
    if (withDemoDocs) {
      for (const d of DEMO_DOCUMENTS) {
        const docId = uuid(); const verId = uuid();
        const content = d.rules ? `${d.content}\n\n[regras estruturadas] ${JSON.stringify(d.rules)}` : d.content;
        insert('knowledge_documents', { id: docId, organization_id: orgId, product_id: null, title: d.title, classification: 'internal', current_version_id: verId, status: 'active', is_demo: 1, created_at: now() });
        insert('knowledge_versions', { id: verId, organization_id: orgId, document_id: docId, version: 1, content, content_ref: null, checksum: sha256(content), effective_from: now(), expires_at: d.expires_in_days ? addMs(d.expires_in_days * 86400_000) : null, approved_by: null, created_at: now() });
      }
    }
    audit({ orgId, event: 'organization.created', objectType: 'organization', objectId: orgId, metadata: { name } });
    return orgId;
  });
}

// Atualizações para organizações existentes (instalações anteriores): novos agentes e novas regras de política.
export function upgradeOrganization(orgId) {
  tx(() => {
    for (const def of AGENT_DEFS) {
      if (q.get('SELECT id FROM agents WHERE organization_id = ? AND code = ?', orgId, def.code)) continue;
      const agentId = uuid(); const verId = uuid();
      insert('agents', { id: agentId, organization_id: orgId, code: def.code, name: def.name, description: def.description, enabled: 1, active_version_id: null });
      insert('agent_versions', { id: verId, organization_id: orgId, agent_id: agentId, version: 1, instructions: `${COMMON}\n\n${ROLE[def.code]}`, model_config: { provider: 'default', model: '' }, limits: { max_calls: 3, max_output_tokens: 3000, timeout_ms: 90000 }, output_schema_version: def.code === 'marketing' ? 'marketing_opinion/1.0' : 'opinion/1.0', accepts_from: def.accepts, created_by: null, created_at: now() });
      q.run('UPDATE agents SET active_version_id = ? WHERE id = ?', verId, agentId);
      for (const t of def.tools) {
        const tool = q.get('SELECT id FROM tools WHERE code = ?', t);
        if (tool) insert('agent_tool_grants', { id: uuid(), organization_id: orgId, agent_version_id: verId, tool_id: tool.id, scope: 'aggregate', limits: {} });
      }
      audit({ orgId, event: 'agent.installed', objectType: 'agent', objectId: agentId, metadata: { code: def.code } });
    }
    // Concessões de leitura novas para versões ativas (ex.: get_master_overview)
    for (const def of AGENT_DEFS) {
      const ag = q.get('SELECT active_version_id FROM agents WHERE organization_id = ? AND code = ?', orgId, def.code);
      for (const t of def.tools) {
        const tool = q.get('SELECT id, type FROM tools WHERE code = ?', t);
        if (!tool || !ag?.active_version_id || tool.type === 'execution') continue;
        if (!q.get('SELECT id FROM agent_tool_grants WHERE agent_version_id = ? AND tool_id = ?', ag.active_version_id, tool.id)) {
          insert('agent_tool_grants', { id: uuid(), organization_id: orgId, agent_version_id: ag.active_version_id, tool_id: tool.id, scope: 'aggregate', limits: {} });
          audit({ orgId, event: 'agent.grant_added', objectType: 'agent', metadata: { agent: def.code, tool: t } });
        }
      }
    }
    const pol = q.get('SELECT * FROM policy_versions WHERE organization_id = ? ORDER BY version DESC LIMIT 1', orgId);
    const rules = JSON.parse(pol.rules);
    const missing = Object.keys(DEFAULT_POLICY.tools).filter((k) => !rules.tools?.[k]);
    if (missing.length) {
      for (const k of missing) rules.tools[k] = DEFAULT_POLICY.tools[k];
      const id = uuid();
      insert('policy_versions', { id, organization_id: orgId, version: pol.version + 1, rules, effective_from: now(), created_by: null, created_at: now() });
      audit({ orgId, event: 'policy.upgraded', objectType: 'policy_version', objectId: id, metadata: { added_tools: missing } });
    }
  });
}

export function ensureSeed() {
  const org = q.get('SELECT id FROM organizations ORDER BY created_at LIMIT 1');
  if (org) {
    ensureTools();
    for (const o of q.all('SELECT id FROM organizations')) upgradeOrganization(o.id);
    return org.id;
  }
  return createOrganization('LORLER');
}

export function addMember(orgId, userId, role, { allProducts = true } = {}) {
  return tx(() => {
    const id = uuid();
    insert('organization_members', { id, organization_id: orgId, user_id: userId, role, status: 'active', created_at: now() });
    if (allProducts) {
      for (const p of q.all('SELECT id FROM products WHERE organization_id = ?', orgId)) {
        insert('member_product_scopes', { id: uuid(), organization_id: orgId, member_id: id, product_id: p.id, permission: 'read_aggregate', source_scope_ref: null });
      }
    }
    return id;
  });
}
