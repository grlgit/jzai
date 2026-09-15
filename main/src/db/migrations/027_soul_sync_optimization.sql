-- 027: Soul Sync Optimization
-- 实现Soul同步优化：乐观锁、推送去重、健康检查

-- 为CoWorker表添加版本控制字段
ALTER TABLE jz_coworkers
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- 为CoWorker分配表添加同步状态字段
ALTER TABLE jz_coworker_assignments
  ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20) DEFAULT 'idle',
    -- idle: 空闲，无同步任务
    -- pushing: 正在推送配置
    -- syncing: 正在同步Soul
    -- failed: 同步失败
  ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT,
  ADD COLUMN IF NOT EXISTS sync_retry_count INTEGER DEFAULT 0;

-- 索引优化
CREATE INDEX IF NOT EXISTS idx_cw_version ON jz_coworkers(version);
CREATE INDEX IF NOT EXISTS idx_cwa_sync_status ON jz_coworker_assignments(sync_status);
CREATE INDEX IF NOT EXISTS idx_cwa_last_sync ON jz_coworker_assignments(last_sync_at DESC);

-- Soul同步历史表（用于审计和调试）
CREATE TABLE IF NOT EXISTS jz_soul_sync_history (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),
  coworker_id TEXT NOT NULL REFERENCES jz_coworkers(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL REFERENCES jz_coworker_assignments(id) ON DELETE CASCADE,

  -- 同步信息
  old_soul TEXT,
  new_soul TEXT,

  -- 版本信息
  old_version INTEGER,
  new_version INTEGER,

  -- 同步状态
  sync_status VARCHAR(20) NOT NULL,
    -- pushing: 推送中
    -- success: 成功
    -- failed: 失败
    -- timeout: 超时

  -- 错误信息
  error_message TEXT,
  error_code VARCHAR(50),

  -- 时间记录
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,

  -- 同步触发来源
  trigger_source VARCHAR(50),
    -- 'admin': 管理员修改
    -- 'gateway': Gateway重载
    -- 'health_check': 健康检查修复
    -- 'manual': 手动触发
  triggered_by TEXT REFERENCES jz_users(id)
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_ssh_coworker ON jz_soul_sync_history(coworker_id);
CREATE INDEX IF NOT EXISTS idx_ssh_assignment ON jz_soul_sync_history(assignment_id);
CREATE INDEX IF NOT EXISTS idx_ssh_started_at ON jz_soul_sync_history(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_ssh_status ON jz_soul_sync_history(sync_status);

-- 触发器：更新CoWorker的updated_at时自动递增version
CREATE OR REPLACE FUNCTION increment_coworker_version()
RETURNS TRIGGER AS $$
BEGIN
  -- 只在soul、tools、skills、mcp_servers等关键字段变更时递增版本
  IF (OLD.soul IS DISTINCT FROM NEW.soul) OR
     (OLD.tools IS DISTINCT FROM NEW.tools) OR
     (OLD.skills IS DISTINCT FROM NEW.skills) OR
     (OLD.mcp_servers IS DISTINCT FROM NEW.mcp_servers) OR
     (OLD.model_level IS DISTINCT FROM NEW.model_level) OR
     (OLD.config_overrides IS DISTINCT FROM NEW.config_overrides) THEN
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER increment_version_on_coworker_update
  BEFORE UPDATE ON jz_coworkers
  FOR EACH ROW
  WHEN (OLD.version IS NOT NULL)
  EXECUTE FUNCTION increment_coworker_version();

-- 注释
COMMENT ON COLUMN jz_coworkers.version IS '版本号：soul、tools等关键字段变更时自动递增，用于乐观锁';
COMMENT ON COLUMN jz_coworker_assignments.sync_status IS '同步状态：idle/pushing/syncing/failed';
COMMENT ON TABLE jz_soul_sync_history IS 'Soul同步历史表：记录Soul同步的详细历史，用于审计和调试';
