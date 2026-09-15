-- 015: CoWorker 能力授权 + 工作空间 + 人格/欢迎字段
-- 主题 E（能力授权 + 工作空间）+ 主题 A（character）+ 主题 C（欢迎消息）

-- === jz_coworkers 扩展 ===

ALTER TABLE jz_coworkers
  ADD COLUMN IF NOT EXISTS character TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS capabilities JSONB DEFAULT '{"mcp":[],"skills":[],"builtin":[]}',
  ADD COLUMN IF NOT EXISTS workspace_config JSONB DEFAULT '{"enabled":true,"localPath":"~/coworker-workspace","containerPath":"/workspace","readonly":false}',
  ADD COLUMN IF NOT EXISTS welcome_examples JSONB DEFAULT '[]';

-- === jz_coworker_assignments 扩展 ===

ALTER TABLE jz_coworker_assignments
  ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ;

-- === jz_coworker_messages 扩展（主题 D + B 共用）===

ALTER TABLE jz_coworker_messages
  ADD COLUMN IF NOT EXISTS session_id TEXT DEFAULT '',
  ADD COLUMN IF NOT EXISTS debug BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_cwm_session
  ON jz_coworker_messages(assignment_id, session_id, created_at);

-- === 旧数据迁移：skills → capabilities.skills ===
-- tools 字段（旧 MCP tool ids，形如 'jianzhi_xxx'）暂保留原样，
-- 后续由 E-3 编辑器升级时统一迁移到 capabilities.mcp。

UPDATE jz_coworkers
SET capabilities = jsonb_set(
  COALESCE(capabilities, '{"mcp":[],"skills":[],"builtin":[]}'::jsonb),
  '{skills}',
  COALESCE(skills, '[]'::jsonb)
)
WHERE COALESCE(jsonb_array_length(COALESCE(skills, '[]'::jsonb)), 0) > 0
  AND (capabilities IS NULL
       OR capabilities = '{"mcp":[],"skills":[],"builtin":[]}'::jsonb);
