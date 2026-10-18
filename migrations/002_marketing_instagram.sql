-- Migration 002 — Agente de Marketing e vinculação de contas de redes sociais (Instagram)
-- Reversão: migrations/002_marketing_instagram.down.sql

CREATE TABLE social_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL CHECK (provider IN ('instagram')),
  account_id TEXT NOT NULL,
  username TEXT,
  account_type TEXT,
  token_ciphertext TEXT NOT NULL,       -- token criptografado (AES-256-GCM); nunca em texto puro
  token_expires_at TEXT,
  scopes TEXT NOT NULL DEFAULT '[]',
  link_method TEXT NOT NULL CHECK (link_method IN ('oauth','manual_token')),
  status TEXT NOT NULL DEFAULT 'connected' CHECK (status IN ('connected','expired','error','disconnected')),
  connected_by TEXT REFERENCES users(id),
  connected_at TEXT NOT NULL,
  last_checked_at TEXT,
  last_check_result TEXT,
  UNIQUE (organization_id, provider)
);

CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
