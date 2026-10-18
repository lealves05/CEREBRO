-- 005: assistente configurável (nome, avatar, personalidade, voz) e conversa natural pelo WhatsApp.
CREATE TABLE assistant_settings (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
  settings TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
-- Últimas mensagens da conversa pelo WhatsApp (contexto da conversa). Apagadas automaticamente após 24 horas.
-- meta: análise sugerida aguardando o "sim" do usuário ({"analysis_question": "..."}).
CREATE TABLE wa_chat_turns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  text TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_wa_chat_user ON wa_chat_turns(user_id, created_at);
-- Análises abertas pela conversa do WhatsApp: o cérebro avisa por lá quando a recomendação fica pronta.
CREATE TABLE wa_followups (
  decision_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  wa_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT
);
