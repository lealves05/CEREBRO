-- Marketing do Cérebro: agenda de posts (Instagram, Facebook, TikTok, LinkedIn), anúncios pagos (pacote pronto /
-- campanha criada PAUSADA) e ações comerciais. Nada sai sem aprovação humana (senha no painel ou PIN no WhatsApp).
CREATE TABLE mkt_campaigns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT 'vendas',
  product_code TEXT,
  offer TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  budget_cents INTEGER NOT NULL DEFAULT 0,
  networks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','ativa','encerrada','cancelada')),
  notes TEXT NOT NULL DEFAULT '',
  wa_code TEXT UNIQUE,
  wa_pin_until TEXT,
  payload_hash TEXT,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mkt_campaigns_org ON mkt_campaigns (organization_id, start_date DESC);

CREATE TABLE mkt_items (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  campaign_id TEXT REFERENCES mkt_campaigns(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('post','anuncio','acao')),
  title TEXT NOT NULL,
  networks TEXT NOT NULL DEFAULT '[]',
  text TEXT NOT NULL DEFAULT '',
  texts TEXT NOT NULL DEFAULT '{}',
  media_url TEXT NOT NULL DEFAULT '',
  media_kind TEXT NOT NULL DEFAULT '' CHECK (media_kind IN ('','imagem','video')),
  format TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho','aguardando_aprovacao','aprovado','na_fila','publicado','parcial','erro','cancelado','concluido')),
  ad TEXT NOT NULL DEFAULT '{}',
  action TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'painel',
  wa_code TEXT UNIQUE,
  wa_pin_until TEXT,
  payload_hash TEXT,
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  queued_at TEXT,
  result TEXT NOT NULL DEFAULT '{}',
  notified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mkt_items_org_when ON mkt_items (organization_id, scheduled_at);
CREATE INDEX idx_mkt_items_status ON mkt_items (status);

CREATE TABLE mkt_media (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at TEXT NOT NULL
);

-- Reunião de marketing (WhatsApp, voz ou painel): o Cérebro conduz as perguntas e monta o plano.
CREATE TABLE mkt_meetings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'whatsapp',
  step TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  campaign_id TEXT REFERENCES mkt_campaigns(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','encerrada','cancelada')),
  log TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_mkt_meetings_user ON mkt_meetings (user_id, status);

-- Agente de suporte no número público da LORLER: quem não é da equipe recebe só respostas técnicas sobre os sistemas.
CREATE TABLE support_agent (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  handoff INTEGER NOT NULL DEFAULT 1,
  owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  hours TEXT NOT NULL DEFAULT '',
  greeting TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE support_chats (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  wa_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_support_chats ON support_chats (organization_id, wa_id, created_at);
