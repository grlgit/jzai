-- Migration 031: App Store infrastructure tables
-- jz_installed_apps, jz_app_migrations, jz_app_grants, jz_app_audit_log, jz_credentials

CREATE TABLE IF NOT EXISTS jz_credentials (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope       TEXT NOT NULL,
  key         TEXT NOT NULL,
  value_enc   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (scope, key)
);

CREATE INDEX IF NOT EXISTS idx_jz_credentials_scope_key ON jz_credentials (scope, key);

CREATE TABLE IF NOT EXISTS jz_installed_apps (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id        TEXT NOT NULL UNIQUE,
  short_name    TEXT NOT NULL UNIQUE,
  ns_prefix     TEXT NOT NULL UNIQUE,
  version       TEXT NOT NULL,
  name          JSONB NOT NULL DEFAULT '{}',
  manifest      JSONB NOT NULL,
  config        JSONB NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'installing'
                  CHECK (status IN ('installing','active','failed','uninstalling','uninstalled','upgrading')),
  install_dir   TEXT,
  extract_dir   TEXT,
  installed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_installed_apps_status ON jz_installed_apps (status);

-- Migration tracking per installed app
CREATE TABLE IF NOT EXISTS jz_app_migrations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id       TEXT NOT NULL REFERENCES jz_installed_apps(app_id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  checksum     TEXT NOT NULL,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, version)
);

-- Drop old jz_app_grants schema (pre-031: user_id/role columns) to allow recreation with new schema
DROP TABLE IF EXISTS jz_app_grants CASCADE;

-- Fine-grained permission grants for installed apps
CREATE TABLE IF NOT EXISTS jz_app_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id         TEXT NOT NULL REFERENCES jz_installed_apps(app_id) ON DELETE CASCADE,
  permission_id  TEXT NOT NULL,
  target_type    TEXT NOT NULL CHECK (target_type IN ('user','department','role')),
  target_id      TEXT NOT NULL,
  level          TEXT NOT NULL CHECK (level IN ('none','user','admin')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, permission_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_app_grants_lookup
  ON jz_app_grants (app_id, permission_id, target_type, target_id);

-- Audit log for install/uninstall/upgrade/grant actions
CREATE TABLE IF NOT EXISTS jz_app_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor_id    TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_audit_app_id ON jz_app_audit_log (app_id, created_at DESC);
