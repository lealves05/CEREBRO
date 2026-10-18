-- Migration 003 — Aprovações por WhatsApp (WhatsApp Business Cloud API)
-- Reversão: migrations/003_whatsapp.down.sql

CREATE TABLE whatsapp_links (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  wa_id TEXT,                              -- número no formato internacional, só dígitos
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','disabled')),
  link_code_hash TEXT,
  link_code_expires_at TEXT,
  pin_hash TEXT,
  pin_failed INTEGER NOT NULL DEFAULT 0,
  pin_locked_until TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (organization_id, user_id)
);
CREATE UNIQUE INDEX uq_whatsapp_wa ON whatsapp_links(wa_id) WHERE wa_id IS NOT NULL AND status = 'verified';

CREATE TABLE whatsapp_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  action_proposal_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  payload_hash TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('sent','awaiting_pin','approved','rejected','revision','expired','failed','superseded')),
  pending_until TEXT,
  wa_message_id TEXT,
  send_error TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (organization_id, action_proposal_id) REFERENCES action_proposals(organization_id, id)
);
CREATE INDEX idx_wareq_user ON whatsapp_requests(user_id, status);
