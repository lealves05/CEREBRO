-- 004: conversa por voz/texto com o Cérebro — consumo de tokens da conversa livre (entra no orçamento técnico mensal).
-- O conteúdo da conversa não é gravado; a auditoria registra só a intenção de cada volta.
CREATE TABLE conversation_turns (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_conversation_org ON conversation_turns(organization_id, created_at);
