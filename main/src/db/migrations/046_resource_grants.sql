-- P1 权限体系：资源归属元数据 + 通用资源授权（设计见 docs/rework-2026H2/design-p1-authz.md）
-- resource_type: 'agent' | 'skill' | 'connector' | 'tool' | 'panel' | 'app'
-- resource_id:   agent.id / skill.name / mcp server name / tool name / panel.id / appId

CREATE TABLE IF NOT EXISTS jz_resource_meta (
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  scope           TEXT NOT NULL DEFAULT 'global' CHECK (scope IN ('global','user')),
  owner_user_id   TEXT,
  source_app_id   TEXT,
  builtin         BOOLEAN NOT NULL DEFAULT FALSE,
  -- 'all' = 全员可见（存量回填兜底）；'none' = 仅按 grants 判定（新建资源默认 fail-closed）
  default_visibility TEXT NOT NULL DEFAULT 'none' CHECK (default_visibility IN ('none','all')),
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (resource_type, resource_id),
  CONSTRAINT jz_resource_meta_owner_chk CHECK (scope <> 'user' OR owner_user_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_resource_meta_owner
  ON jz_resource_meta (owner_user_id) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_resource_meta_app
  ON jz_resource_meta (source_app_id) WHERE source_app_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS jz_resource_grants (
  resource_type   TEXT NOT NULL,
  resource_id     TEXT NOT NULL,
  -- '' = 整资源（"全部"）；非空 = 连接下的某个工具名（per-tool 授权）
  sub_id          TEXT NOT NULL DEFAULT '',
  target_type     TEXT NOT NULL CHECK (target_type IN ('user','role','department')),
  target_id       TEXT NOT NULL,
  level           TEXT NOT NULL DEFAULT 'user' CHECK (level IN ('none','user','admin')),
  granted_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (resource_type, resource_id, sub_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_resource_grants_lookup
  ON jz_resource_grants (resource_type, target_type, target_id) WHERE level <> 'none';
CREATE INDEX IF NOT EXISTS idx_resource_grants_res
  ON jz_resource_grants (resource_type, resource_id);
