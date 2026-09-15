-- OEM 插件：第三方系统接入见智数据仪表（W1 骨架）
-- 接入方凭据
CREATE TABLE IF NOT EXISTS jz_oem_apps (
  id              TEXT PRIMARY KEY,
  app_id          TEXT UNIQUE NOT NULL,                 -- 公开标识，可进前端 URL
  app_secret_hash TEXT NOT NULL,                        -- bcrypt(app_secret)
  name            TEXT NOT NULL,                         -- 接入方名称
  bearer_user_id  TEXT NOT NULL REFERENCES jz_users(id),-- 承载用户（权限/数据可见范围）
  scope           JSONB NOT NULL DEFAULT '["chat:use","dash:view"]',
  mcp_bindings    JSONB NOT NULL DEFAULT '[]',           -- [{ mcp_name, label, schema_hint, readonly, is_default }]
  branding        JSONB NOT NULL DEFAULT '{}',           -- { primary, logo, brandName, hideJianzhiMark, ... }
  allowed_origins JSONB NOT NULL DEFAULT '[]',           -- iframe 父域白名单
  cache_policy    TEXT NOT NULL DEFAULT 'on',            -- on | off
  rate_limit      JSONB NOT NULL DEFAULT '{}',           -- { tokenPerMin, msgPerMin }
  status          TEXT NOT NULL DEFAULT 'active',        -- active | suspended
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- external_uid ↔ 见智影子用户映射
CREATE TABLE IF NOT EXISTS jz_oem_shadow_users (
  id            TEXT PRIMARY KEY,
  app_id        TEXT NOT NULL REFERENCES jz_oem_apps(app_id) ON DELETE CASCADE,
  external_uid  TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES jz_users(id),   -- 见智内部影子用户
  external_name TEXT,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, external_uid)
);
CREATE INDEX IF NOT EXISTS idx_oem_shadow_app ON jz_oem_shadow_users(app_id);

-- jz_users 增列：标记影子用户
ALTER TABLE jz_users ADD COLUMN IF NOT EXISTS is_oem_shadow BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jz_users ADD COLUMN IF NOT EXISTS oem_app_id TEXT;

-- 用量埋点（预留计费）
CREATE TABLE IF NOT EXISTS jz_oem_usage (
  id           BIGSERIAL PRIMARY KEY,
  app_id       TEXT NOT NULL,
  external_uid TEXT,
  metric       TEXT NOT NULL,        -- token_issue | chat_msg | widget_refresh | mcp_query
  qty          INTEGER NOT NULL DEFAULT 1,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_oem_usage_app_ts ON jz_oem_usage(app_id, ts);
