-- JARVIS: cofre de memória em markdown (estilo Obsidian) e rotina do dia por pessoa.
-- O cofre é pessoal (de cada usuário). Pastas: raw (tudo capturado), wiki (conhecimento refinado / "lembre que"), outputs (o que o Cérebro entrega), diario (um arquivo por dia).
CREATE TABLE vault_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  folder TEXT NOT NULL CHECK (folder IN ('raw','wiki','outputs','diario')),
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'conversa',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id, folder, slug)
);
CREATE INDEX idx_vault_owner_updated ON vault_notes (organization_id, user_id, updated_at DESC);

CREATE TABLE jarvis_routine (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  times TEXT NOT NULL DEFAULT '{"manha":"07:00","plano":"09:00","metricas":"14:00","encerrar":"19:00"}',
  whatsapp INTEGER NOT NULL DEFAULT 1,
  voice_reply INTEGER NOT NULL DEFAULT 1,
  awaiting TEXT,
  awaiting_until TEXT,
  last_runs TEXT NOT NULL DEFAULT '{}',
  vault_token_hash TEXT,
  updated_at TEXT NOT NULL
);
