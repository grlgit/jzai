-- 028: Gateway Health Monitoring
-- 支持Gateway守护增强：崩溃日志、健康监控、状态持久化

-- Gateway崩溃历史表
CREATE TABLE IF NOT EXISTS jz_gateway_crash_history (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联信息
  assignment_id TEXT NOT NULL REFERENCES jz_coworker_assignments(id) ON DELETE CASCADE,
  coworker_id TEXT NOT NULL REFERENCES jz_coworkers(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES jz_users(id) ON DELETE SET NULL,

  -- 崩溃信息
  crash_code INTEGER,
  crash_signal VARCHAR(50),
  crash_reason VARCHAR(100),
    -- 'exit': 进程退出
    -- 'signal': 信号终止
    -- 'error': 错误异常
    -- 'timeout': 超时
    -- 'oom': 内存不足

  -- 状态信息
  was_connected BOOLEAN DEFAULT false,
  active_tasks INTEGER DEFAULT 0,
  uptime_seconds INTEGER,

  -- 错误详情
  error_message TEXT,
  error_stack TEXT,

  -- 时间信息
  crashed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recovered_at TIMESTAMPTZ,
  recovery_duration_ms INTEGER,

  -- 重启信息
  restart_attempted BOOLEAN DEFAULT false,
  restart_success BOOLEAN,
  restart_count_in_window INTEGER DEFAULT 0,

  -- 环境信息
  client_version VARCHAR(50),
  os_platform VARCHAR(50),
  os_arch VARCHAR(50),
  node_version VARCHAR(50),

  -- 元数据
  metadata JSONB DEFAULT '{}'
);

-- Gateway健康状态快照表
CREATE TABLE IF NOT EXISTS jz_gateway_health_snapshots (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 关联信息
  assignment_id TEXT NOT NULL REFERENCES jz_coworker_assignments(id) ON DELETE CASCADE,

  -- 健康指标
  is_connected BOOLEAN DEFAULT false,
  last_heartbeat_at TIMESTAMPTZ,
  heartbeat_interval_ms INTEGER,

  -- 任务指标
  active_tasks INTEGER DEFAULT 0,
  completed_tasks INTEGER DEFAULT 0,
  failed_tasks INTEGER DEFAULT 0,

  -- 资源指标（客户端上报）
  memory_usage_mb NUMERIC(10,2),
  cpu_usage_percent NUMERIC(5,2),

  -- Gateway进程指标
  gateway_uptime_seconds INTEGER,
  gateway_restart_count INTEGER DEFAULT 0,

  -- 同步状态
  sync_status VARCHAR(20),
  last_sync_at TIMESTAMPTZ,
  sync_error_count INTEGER DEFAULT 0,

  -- 时间信息
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- 元数据
  metadata JSONB DEFAULT '{}'
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_gch_assignment ON jz_gateway_crash_history(assignment_id);
CREATE INDEX IF NOT EXISTS idx_gch_coworker ON jz_gateway_crash_history(coworker_id);
CREATE INDEX IF NOT EXISTS idx_gch_user ON jz_gateway_crash_history(user_id);
CREATE INDEX IF NOT EXISTS idx_gch_crashed_at ON jz_gateway_crash_history(crashed_at DESC);
CREATE INDEX IF NOT EXISTS idx_gch_reason ON jz_gateway_crash_history(crash_reason);

CREATE INDEX IF NOT EXISTS idx_ghs_assignment ON jz_gateway_health_snapshots(assignment_id);
CREATE INDEX IF NOT EXISTS idx_ghs_snapshot_at ON jz_gateway_health_snapshots(snapshot_at DESC);
CREATE INDEX IF NOT EXISTS idx_ghs_connected ON jz_gateway_health_snapshots(is_connected);

-- 注释
COMMENT ON TABLE jz_gateway_crash_history IS 'Gateway崩溃历史表：记录CoWorker客户端Gateway进程的崩溃事件，用于诊断和监控';
COMMENT ON TABLE jz_gateway_health_snapshots IS 'Gateway健康状态快照表：定期保存Gateway健康指标，用于趋势分析和问题预防';

COMMENT ON COLUMN jz_gateway_crash_history.crash_reason IS '崩溃原因分类：exit/signal/error/timeout/oom';
COMMENT ON COLUMN jz_gateway_crash_history.restart_count_in_window IS '重启时间窗口内的重启次数，用于判断是否频繁崩溃';
COMMENT ON COLUMN jz_gateway_health_snapshots.memory_usage_mb IS '客户端上报的内存使用量（MB）';
COMMENT ON COLUMN jz_gateway_health_snapshots.cpu_usage_percent IS '客户端上报的CPU使用率（%）';

-- 触发器：自动清理旧数据（保留90天）
CREATE OR REPLACE FUNCTION cleanup_old_gateway_health_data()
RETURNS void AS $$
BEGIN
  DELETE FROM jz_gateway_crash_history WHERE crashed_at < NOW() - INTERVAL '90 days';
  DELETE FROM jz_gateway_health_snapshots WHERE snapshot_at < NOW() - INTERVAL '90 days';
END;
$$ LANGUAGE plpgsql;

-- 定期清理任务（需要在应用层实现定时调用）
COMMENT ON FUNCTION cleanup_old_gateway_health_data() IS '清理90天前的Gateway健康数据';
