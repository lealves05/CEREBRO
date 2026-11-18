-- Cérebro — 010: publicação mais prática pelo WhatsApp.
-- PIN confirmado vale 30 minutos: nesse tempo "APROVAR código" aprova direto (sem pedir o PIN de novo).
ALTER TABLE whatsapp_links ADD COLUMN pin_ok_until TEXT;
-- Vídeos da biblioteca já usados em posts (para o rodízio não repetir).
CREATE TABLE IF NOT EXISTS mkt_video_uses (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  file TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS mkt_video_uses_org ON mkt_video_uses (organization_id, file);
