-- Migration 038: exact APP connection bindings and delegated invocation audit

CREATE TABLE IF NOT EXISTS jz_app_service_principals (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id      TEXT NOT NULL REFERENCES jz_installed_apps(app_id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  scopes      TEXT[] NOT NULL DEFAULT '{}',
  created_by  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, name)
);

CREATE TABLE IF NOT EXISTS jz_app_delegations (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_principal_id  UUID NOT NULL REFERENCES jz_app_service_principals(id) ON DELETE CASCADE,
  delegated_by_user_id  TEXT NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,
  scopes                TEXT[] NOT NULL DEFAULT '{}',
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS jz_app_connection_bindings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id                TEXT NOT NULL REFERENCES jz_installed_apps(app_id) ON DELETE CASCADE,
  connection_name       TEXT NOT NULL,
  tool_name             TEXT NOT NULL,
  input_schema_digest   TEXT NOT NULL,
  config                JSONB NOT NULL DEFAULT '{}',
  service_principal_id  UUID REFERENCES jz_app_service_principals(id) ON DELETE SET NULL,
  enabled               BOOLEAN NOT NULL DEFAULT TRUE,
  created_by            TEXT NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_id, connection_name, tool_name)
);

CREATE TABLE IF NOT EXISTS jz_app_connection_binding_grants (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id   UUID NOT NULL REFERENCES jz_app_connection_bindings(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('user','department','role')),
  target_id    TEXT NOT NULL,
  effect       TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (binding_id, target_type, target_id)
);

CREATE TABLE IF NOT EXISTS jz_app_connection_invocation_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          TEXT NOT NULL,
  binding_id      UUID NOT NULL,
  principal_id    TEXT NOT NULL,
  user_id         TEXT,
  connection_name TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  request_id      UUID NOT NULL,
  duration_ms     INTEGER NOT NULL CHECK (duration_ms >= 0),
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','denied','error')),
  error_code      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_connection_bindings_app
  ON jz_app_connection_bindings (app_id, enabled);
CREATE INDEX IF NOT EXISTS idx_app_binding_grants_lookup
  ON jz_app_connection_binding_grants (binding_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_app_connection_audit_app
  ON jz_app_connection_invocation_audit (app_id, created_at DESC);
