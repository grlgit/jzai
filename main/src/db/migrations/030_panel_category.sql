-- 030: Panel Category & App Grants (L1)
-- 为面板分类、扩展包授权、面板消息处理器注册、审计日志奠基。
-- L1 独立可发布：不依赖 031_app_store.sql（L3）。

-- 1) jz_panels 扩展列
ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'builtin';
ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS source_app_id TEXT;
ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS agent_id TEXT;
ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS uninstallable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS entry_component TEXT;
ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS name_i18n JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'jz_panels_category_chk'
  ) THEN
    ALTER TABLE jz_panels ADD CONSTRAINT jz_panels_category_chk
      CHECK (category IN ('system','builtin','third_party'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_jz_panels_source_app ON jz_panels(source_app_id);

-- 2) 扩展包授权表（L1 建最小版；L3 的 031 追加 jz_installed_apps 外键）
CREATE TABLE IF NOT EXISTS jz_app_grants (
  id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  app_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'user',
  granted_by TEXT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(app_id, user_id),
  CONSTRAINT jz_app_grants_role_chk CHECK (role IN ('user','admin'))
);
CREATE INDEX IF NOT EXISTS idx_jz_app_grants_user ON jz_app_grants(user_id);

-- 3) 面板消息处理器注册表（L1 建，L2 使用，内置 validator 亦可登记）
CREATE TABLE IF NOT EXISTS jz_panel_message_handlers (
  panel_id         TEXT PRIMARY KEY,
  app_id           TEXT,
  validator_path   TEXT NOT NULL,
  validator_export TEXT NOT NULL DEFAULT 'default',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4) 审计日志（轻量版，L1 起记录授权变更）
CREATE TABLE IF NOT EXISTS jz_app_audit_log (
  id         BIGSERIAL PRIMARY KEY,
  app_id     TEXT,
  action     TEXT NOT NULL,
  actor_id   TEXT,
  detail     JSONB NOT NULL DEFAULT '{}',
  success    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_jz_app_audit_app ON jz_app_audit_log(app_id, created_at DESC);

-- 5) 现有面板分类回填
UPDATE jz_panels SET category = 'system',  uninstallable = FALSE WHERE id IN ('agents', 'cfg');
UPDATE jz_panels SET category = 'builtin', uninstallable = FALSE
  WHERE id IN ('kb', 'cw', 'dashboard', 'skills', 'connectors', 'dimensionTuner', 'users');

-- agent_id 回填
UPDATE jz_panels SET agent_id = 'skill_master'          WHERE id = 'skills';
UPDATE jz_panels SET agent_id = 'connector_master'      WHERE id = 'connectors';
UPDATE jz_panels SET agent_id = 'data_master'           WHERE id = 'dashboard';
UPDATE jz_panels SET agent_id = 'dimension_classifier'  WHERE id = 'dimensionTuner';

-- 6) dimensionTuner 不再通过平台角色权限控制；作为 builtin 面板时 permission 保持 NULL
--    后续迁移 033 会移除该 builtin 面板，转由第三方 app 包提供并走 jz_app_grants 授权
