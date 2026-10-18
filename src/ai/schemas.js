// Esquemas de saída estruturada (compatíveis com "strict" — todos os campos obrigatórios, sem campos extras).
const str = { type: 'string' };
const strArr = { type: 'array', items: str };
const obj = (properties) => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

export const OPINION_SCHEMA = obj({
  schema_version: { type: 'string', enum: ['1.0'] },
  status: { type: 'string', enum: ['ready', 'partial', 'insufficient_data'] },
  summary: str,
  findings: { type: 'array', items: obj({ claim: str, evidence_refs: strArr }) },
  recommendation: str,
  alternatives: strArr,
  assumptions: strArr,
  risks: strArr,
  missing_data: strArr,
  questions_for_agents: { type: 'array', items: obj({ target_agent: { type: 'string', enum: ['coordinator', 'financial', 'commercial', 'operations', 'marketing'] }, question: str }) },
  calculation_requests: { type: 'array', items: obj({ formula: { type: 'string', enum: ['discount_scenario', 'conversion_rate', 'churn_rate', 'contribution', 'capacity_check'] }, inputs_json: str }) },
});

// Parecer do Agente de Marketing: parecer padrão + rascunho de conteúdo
export const MARKETING_SCHEMA = obj({
  ...OPINION_SCHEMA.properties,
  content_draft: obj({
    channel: { type: 'string', enum: ['instagram_feed'] },
    objective: str,
    audience: str,
    caption: str,
    hashtags: strArr,
    call_to_action: str,
    image_brief: str,
    suggested_time: str,
  }),
});

export const PLAN_SCHEMA = obj({
  schema_version: { type: 'string', enum: ['1.0'] },
  objective: str,
  agents: { type: 'array', items: obj({ agent_code: { type: 'string', enum: ['financial', 'commercial', 'operations', 'marketing'] }, question: str }) },
  cross_review: { type: 'array', items: obj({ from_agent: { type: 'string', enum: ['financial', 'commercial', 'operations', 'marketing'] }, to_agent: { type: 'string', enum: ['financial', 'commercial', 'operations', 'marketing'] }, reason: str }) },
  notes: str,
});

export const SYNTHESIS_SCHEMA = obj({
  schema_version: { type: 'string', enum: ['1.0'] },
  status: { type: 'string', enum: ['ready', 'partial', 'insufficient_data'] },
  problem: str,
  diagnosis: str,
  proposal: str,
  alternatives: strArr,
  relevant_data: { type: 'array', items: obj({ claim: str, evidence_refs: strArr }) },
  assumptions: strArr,
  divergences: strArr,
  risks: strArr,
  missing_data: strArr,
  next_steps: strArr,
  approver_hint: str,
  action_proposal: obj({
    tool_code: { type: 'string', enum: ['none', 'create_internal_task', 'change_price_or_discount', 'send_customer_message', 'paid_campaign', 'publish_instagram_post', 'master_update_settings', 'master_update_plan', 'master_update_product_params', 'master_extend_trial'] },
    title: str,
    description: str,
    product_code: str,
    target: str,
    parameters_json: str,
    max_amount: str,
    due_in_days: { type: 'integer' },
  }),
});

export const SCHEMAS = { opinion: OPINION_SCHEMA, marketing_opinion: MARKETING_SCHEMA, plan: PLAN_SCHEMA, synthesis: SYNTHESIS_SCHEMA };

// Validação no backend (independe do provedor declarar suporte a saída estruturada)
export function validateAgainst(schema, value, path = '$') {
  const errs = [];
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${path}: esperado objeto`];
    for (const k of schema.required || []) if (!(k in value)) errs.push(`${path}.${k}: obrigatório`);
    for (const k of Object.keys(value)) if (!schema.properties[k]) errs.push(`${path}.${k}: campo não permitido`);
    for (const [k, s] of Object.entries(schema.properties)) if (k in value) errs.push(...validateAgainst(s, value[k], `${path}.${k}`));
  } else if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: esperado lista`];
    if (value.length > 40) errs.push(`${path}: lista longa demais`);
    value.slice(0, 40).forEach((v, i) => errs.push(...validateAgainst(schema.items, v, `${path}[${i}]`)));
  } else if (t === 'string') {
    if (typeof value !== 'string') return [`${path}: esperado texto`];
    if (value.length > 4000) errs.push(`${path}: texto longo demais`);
    if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: valor fora do permitido`);
  } else if (t === 'integer') {
    if (!Number.isInteger(value)) errs.push(`${path}: esperado inteiro`);
  }
  return errs;
}
