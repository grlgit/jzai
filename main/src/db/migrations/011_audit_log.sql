CREATE TABLE IF NOT EXISTS jz_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     TEXT,
  user_name   TEXT,
  action      TEXT NOT NULL,
  resource    TEXT,
  resource_id TEXT,
  detail      JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_user ON jz_audit_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON jz_audit_log (action, created_at DESC);
