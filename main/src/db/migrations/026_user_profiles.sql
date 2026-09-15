-- 026: User Profiles Management (Revised)
-- 扩展现有jz_users表，只添加真正的扩展字段（非重复）
-- 邮箱等信息已在jz_users表中存在

-- 用户扩展信息表（只包含jz_users没有的扩展字段）
CREATE TABLE IF NOT EXISTS jz_user_profiles (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(36) NOT NULL UNIQUE REFERENCES jz_users(id) ON DELETE CASCADE,

  -- 扩展联系信息（jz_users已有email）
  phone VARCHAR(50),

  -- 组织信息（扩展字段）
  department VARCHAR(100),
  position VARCHAR(100),
  manager_id VARCHAR(36) REFERENCES jz_users(id),

  -- 偏好设置（不包括工作目录，主台已处理）
  preferences JSONB DEFAULT '{}',

  -- 版本控制（用于变更检测和增量同步）
  version INTEGER NOT NULL DEFAULT 1,

  -- 首次填写标记
  first_filled_at TIMESTAMPTZ,
  is_first_fill BOOLEAN NOT NULL DEFAULT true,

  -- 时间戳
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_up_user_id ON jz_user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_up_department ON jz_user_profiles(department);
CREATE INDEX IF NOT EXISTS idx_up_updated_at ON jz_user_profiles(updated_at DESC);

-- 用户信息变更历史表（用于审计和追溯）
CREATE TABLE IF NOT EXISTS jz_user_profile_changes (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id VARCHAR(36) NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,
  profile_id VARCHAR(36) REFERENCES jz_user_profiles(id) ON DELETE CASCADE,

  -- 变更信息
  field_name VARCHAR(50) NOT NULL,
  old_value TEXT,
  new_value TEXT,

  -- 变更原因
  change_reason VARCHAR(255),

  -- 时间戳
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 变更触发来源
  change_source VARCHAR(50)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_upc_user_id ON jz_user_profile_changes(user_id);
CREATE INDEX IF NOT EXISTS idx_upc_changed_at ON jz_user_profile_changes(changed_at DESC);

-- 触发器：自动更新 updated_at
CREATE TRIGGER update_up_updated_at
  BEFORE UPDATE ON jz_user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 触发器：记录用户扩展信息变更历史（不包括邮箱，邮箱在jz_users中）
CREATE OR REPLACE FUNCTION log_profile_change()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在首次填写标记为false时记录历史（避免历史表过大）
  IF NEW.is_first_fill = false THEN
    -- 检测电话变更
    IF OLD.phone IS DISTINCT FROM NEW.phone THEN
      INSERT INTO jz_user_profile_changes (user_id, profile_id, field_name, old_value, new_value, change_source)
      VALUES (NEW.user_id, NEW.id, 'phone', OLD.phone, NEW.phone, 'user');
    END IF;

    -- 检测部门变更
    IF OLD.department IS DISTINCT FROM NEW.department THEN
      INSERT INTO jz_user_profile_changes (user_id, profile_id, field_name, old_value, new_value, change_source)
      VALUES (NEW.user_user_id, NEW.id, 'department', OLD.department, NEW.department, 'user');
    END IF;

    -- 检测职位变更
    IF OLD.position IS DISTINCT FROM NEW.position THEN
      INSERT INTO jz_user_profile_changes (user_id, profile_id, field_name, old_value, new_value, change_source)
      VALUES (NEW.user_id, NEW.id, 'position', OLD.position, NEW.position, 'user');
    END IF;
  END IF;

  -- 更新版本号
  NEW.version := OLD.version + 1;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER log_user_profile_change
  BEFORE UPDATE ON jz_user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION log_profile_change();

-- 触发器：首次填写后自动标记
CREATE OR REPLACE FUNCTION mark_first_fill()
RETURNS TRIGGER AS $$
BEGIN
  -- 如果是首次填写且有扩展信息，更新标记
  IF NEW.is_first_fill = true AND (NEW.phone IS NOT NULL OR NEW.department IS NOT NULL) THEN
    UPDATE jz_user_profiles
    SET is_first_fill = false,
        first_filled_at = NOW()
    WHERE id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_mark_first_fill
  AFTER INSERT ON jz_user_profiles
  FOR EACH ROW
  WHEN (NEW.is_first_fill = true)
  EXECUTE FUNCTION mark_first_fill();

-- 为现有用户创建默认扩展profile（不包括email，email已在jz_users中）
INSERT INTO jz_user_profiles (user_id, is_first_fill)
SELECT id, false
FROM jz_users
WHERE NOT EXISTS (SELECT 1 FROM jz_user_profiles WHERE user_id = jz_users.id);

-- 注释
COMMENT ON TABLE jz_user_profiles IS '用户扩展信息表：仅存储jz_users表中没有的扩展字段（电话、部门、职位等）';
COMMENT ON TABLE jz_user_profile_changes IS '用户扩展信息变更历史表：记录扩展字段的变更历史用于审计';
COMMENT ON COLUMN jz_user_profiles.version IS '版本号：每次变更自动递增，用于客户端检测是否需要更新';
COMMENT ON COLUMN jz_user_profiles.is_first_fill IS '首次填写标记：true表示用户还未主动填写扩展信息';
COMMENT ON COLUMN jz_user_profiles.first_filled_at IS '首次填写时间：用户第一次主动填写扩展信息的时间';
