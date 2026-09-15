-- Migration 037: App capability origin mapping
-- Records which tools / skills / agents were registered by which installed app,
-- so list APIs can tag entries with their source app.

CREATE TABLE IF NOT EXISTS jz_app_capabilities (
  app_id      TEXT NOT NULL REFERENCES jz_installed_apps(app_id) ON DELETE CASCADE,
  cap_type    TEXT NOT NULL CHECK (cap_type IN ('tool','skill','agent')),
  cap_name    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (app_id, cap_type, cap_name)
);

CREATE INDEX IF NOT EXISTS idx_app_capabilities_lookup ON jz_app_capabilities (cap_type, cap_name);
