-- 004: Message display configuration tables

-- Global message display settings
CREATE TABLE IF NOT EXISTS jz_message_display_global (
  key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT TRUE
);
INSERT INTO jz_message_display_global (key, enabled) VALUES
  ('toolProcess', true), ('toolResult', true), ('sourceRef', true)
ON CONFLICT (key) DO NOTHING;

-- Per-user message display settings (optionally per agent)
CREATE TABLE IF NOT EXISTS jz_message_display_user (
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT '_all',
  key TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (user_id, agent_id, key)
);
