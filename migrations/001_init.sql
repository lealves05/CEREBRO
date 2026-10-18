-- Central de Decisões LORLER — migration 001 (estrutura inicial)
-- Banco local: SQLite (node:sqlite). Datas em UTC (ISO-8601). Valores monetários em TEXT decimal com moeda explícita.
-- Reversão: ver migrations/001_init.down.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,               -- hash SHA-256 do token (o token em si nunca é gravado)
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_reauth_at TEXT NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disabled')),
  executions_paused INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE organization_members (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner','manager','analyst','viewer')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id),
  UNIQUE (organization_id, id)
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE member_product_scopes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read_aggregate','read_customer')),
  source_scope_ref TEXT,
  UNIQUE (member_id, product_id, permission),
  FOREIGN KEY (organization_id, member_id) REFERENCES organization_members(organization_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  active_version_id TEXT,
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TABLE agent_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  instructions TEXT NOT NULL,
  model_config TEXT NOT NULL,          -- JSON {provider, model}
  limits TEXT NOT NULL,                -- JSON {max_calls, max_output_tokens, timeout_ms}
  output_schema_version TEXT NOT NULL,
  accepts_from TEXT NOT NULL DEFAULT '[]', -- JSON: códigos dos agentes de quem recebe pareceres
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, version),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, agent_id) REFERENCES agents(organization_id, id)
);

CREATE TABLE tools (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('read','calc','orchestration','proposal','execution')),
  description TEXT NOT NULL,
  input_schema_version TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE agent_tool_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  agent_version_id TEXT NOT NULL,
  tool_id TEXT NOT NULL REFERENCES tools(id),
  scope TEXT NOT NULL DEFAULT 'aggregate',
  limits TEXT NOT NULL DEFAULT '{}',
  UNIQUE (agent_version_id, tool_id),
  FOREIGN KEY (organization_id, agent_version_id) REFERENCES agent_versions(organization_id, id)
);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL DEFAULT '1.0',
  base_url TEXT,
  secret_ref TEXT,                      -- nome da variável de ambiente; nunca o valor
  read_scopes TEXT NOT NULL DEFAULT '["aggregate"]',
  status TEXT NOT NULL DEFAULT 'pending_setup'
    CHECK (status IN ('pending_setup','testing','connected','degraded','disabled','error')),
  last_checked_at TEXT,
  last_check_result TEXT,
  UNIQUE (organization_id, product_id),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, product_id) REFERENCES products(organization_id, id)
);

CREATE TABLE knowledge_documents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  product_id TEXT,
  title TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'internal' CHECK (classification IN ('public','internal','restricted')),
  current_version_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','archived')),
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id)
);

CREATE TABLE knowledge_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_ref TEXT,
  checksum TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  expires_at TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (document_id, version),
  FOREIGN KEY (organization_id, document_id) REFERENCES knowledge_documents(organization_id, id)
);

CREATE TABLE policy_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  version INTEGER NOT NULL,
  rules TEXT NOT NULL,                  -- JSON
  effective_from TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, version),
  UNIQUE (organization_id, id)
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  question TEXT NOT NULL,
  scope TEXT NOT NULL,                  -- JSON {product_ids, period, decision_type, constraints}
  status TEXT NOT NULL,
  current_run_id TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id)
);
CREATE INDEX idx_decisions_org_status ON decisions(organization_id, status, created_at);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  config_snapshot TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  limits TEXT NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  model_calls INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, decision_id) REFERENCES decisions(organization_id, id),
  FOREIGN KEY (organization_id, policy_version_id) REFERENCES policy_versions(organization_id, id)
);
CREATE INDEX idx_runs_status ON runs(status, queued_at);
CREATE INDEX idx_runs_org ON runs(organization_id, status);

CREATE TABLE run_steps (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  attempt INTEGER NOT NULL DEFAULT 1,
  input_hash TEXT,
  result_ref TEXT,                      -- JSON do resultado persistido
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, step_key),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id)
);

CREATE TABLE agent_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_version_id TEXT NOT NULL,
  agent_code TEXT NOT NULL,
  round INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('plan','opinion','challenge','revision','synthesis','review')),
  question TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','running','done','failed','invalid')),
  output TEXT,
  validation_notes TEXT,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id),
  FOREIGN KEY (organization_id, agent_version_id) REFERENCES agent_versions(organization_id, id)
);
CREATE INDEX idx_tasks_run ON agent_tasks(run_id, round);

CREATE TABLE agent_messages (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  sender_agent_id TEXT,
  recipient_agent_id TEXT,
  sender_code TEXT NOT NULL,
  recipient_code TEXT NOT NULL,
  reply_to_id TEXT,
  type TEXT NOT NULL CHECK (type IN ('task','opinion','question','challenge','revision','synthesis')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id)
);
CREATE INDEX idx_messages_run ON agent_messages(run_id, created_at);

CREATE TABLE evidence_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  ref_code TEXT NOT NULL,               -- referência curta exibida aos agentes (ex.: EV-1)
  product_id TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('integration','knowledge','calculation','demo')),
  source_ref TEXT NOT NULL,
  source_version TEXT,
  quality TEXT NOT NULL CHECK (quality IN ('complete','partial','stale','unavailable')),
  observed_at TEXT,
  fetched_at TEXT NOT NULL,
  checksum TEXT NOT NULL,
  payload_ref TEXT NOT NULL,            -- JSON
  is_demo INTEGER NOT NULL DEFAULT 0,
  UNIQUE (run_id, ref_code),
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id)
);

CREATE TABLE task_evidence_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  claim_ref TEXT NOT NULL,
  FOREIGN KEY (organization_id, task_id) REFERENCES agent_tasks(organization_id, id),
  FOREIGN KEY (organization_id, evidence_id) REFERENCES evidence_items(organization_id, id)
);

CREATE TABLE action_proposals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  supersedes_id TEXT,
  tool_code TEXT NOT NULL,
  product_id TEXT,
  target TEXT NOT NULL,
  parameters TEXT NOT NULL,             -- JSON canônico
  summary TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','denied','awaiting_approval','approved','rejected','revision_requested','executing','executed','failed','uncertain','canceled','expired','advisory')),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, id),
  FOREIGN KEY (organization_id, run_id) REFERENCES runs(organization_id, id),
  FOREIGN KEY (organization_id, decision_id) REFERENCES decisions(organization_id, id)
);

CREATE TABLE policy_evaluations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  action_proposal_id TEXT NOT NULL,
  policy_version_id TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('proposal','execution')),
  result TEXT NOT NULL CHECK (result IN ('allow','require_approval','deny')),
  required_approvers TEXT NOT NULL DEFAULT '[]',
  checks TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, action_proposal_id) REFERENCES action_proposals(organization_id, id)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  action_proposal_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  approver_id TEXT NOT NULL REFERENCES users(id),
  result TEXT NOT NULL CHECK (result IN ('approved','rejected','revision_requested','revoked')),
  comment TEXT,
  expires_at TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  FOREIGN KEY (organization_id, action_proposal_id) REFERENCES action_proposals(organization_id, id)
);
-- Uma única decisão final (aprovar/rejeitar/revisar) por proposta+versão
CREATE UNIQUE INDEX uq_approval_final ON approvals(action_proposal_id, proposal_version) WHERE result <> 'revoked';

CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  action_proposal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','uncertain','canceled')),
  external_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (organization_id, action_proposal_id) REFERENCES action_proposals(organization_id, id)
);

CREATE TABLE internal_tasks (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  business_ref TEXT NOT NULL UNIQUE,    -- referência de negócio para conciliação/idempotência
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  product_id TEXT,
  owner_hint TEXT,
  due_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','canceled')),
  created_at TEXT NOT NULL
);

CREATE TABLE usage_records (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  agent_task_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_request_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_amount TEXT,                     -- NULL quando não há tabela de preço configurada
  currency TEXT,
  pricing_version TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_usage_org ON usage_records(organization_id, created_at);

CREATE TABLE budget_reservations (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('technical_tokens','technical_money','business')),
  reserved_amount TEXT NOT NULL,
  actual_amount TEXT NOT NULL DEFAULT '0',
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','settled','released','expired')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_budget_org ON budget_reservations(organization_id, type, status);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','agent','system','service')),
  actor_id TEXT,
  event_type TEXT NOT NULL,
  object_type TEXT,
  object_id TEXT,
  request_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_org ON audit_events(organization_id, created_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events é somente inclusão'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit_events é somente inclusão'); END;

CREATE TABLE outbox_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  event_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE inbound_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (source, event_id)
);
