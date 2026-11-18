-- Cérebro — 009: Mapa da empresa (departamentos, rotinas autônomas e atividade ao vivo).
CREATE TABLE IF NOT EXISTS autopilot_jobs (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  job TEXT NOT NULL,                 -- contatos | caixa | post | sites | risco
  enabled INTEGER NOT NULL DEFAULT 1,
  at_time TEXT,                      -- HH:MM (local); null = de hora em hora
  last_run TEXT,                     -- data local (AAAA-MM-DD) ou hora ISO da última execução
  last_result TEXT,                  -- resumo curto
  state TEXT,                        -- JSON (ex.: sites fora do ar)
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, job)
);
CREATE TABLE IF NOT EXISTS company_activity (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  dept TEXT NOT NULL,                -- crm | tarefas | financeiro | seguranca | traqueamento | educacao | marketing | vault
  agent TEXT NOT NULL,               -- quem fez (ex.: Captador de Leads)
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS company_activity_org ON company_activity (organization_id, created_at DESC);
