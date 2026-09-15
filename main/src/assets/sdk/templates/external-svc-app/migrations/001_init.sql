-- 裸表名即可：search_path 已固定到本应用 schema（app_external_svc）
CREATE TABLE IF NOT EXISTS params (
  id TEXT PRIMARY KEY DEFAULT 'default',
  config JSONB NOT NULL DEFAULT '{}'          -- 锁定规则/滚动周期/优先级等排程参数
);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL,    -- machine/mold/calendar
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  confirmed BOOLEAN NOT NULL DEFAULT FALSE,   -- 只有已确认订单参与排程
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                          -- baseline / scenario
  parent_id TEXT,                              -- scenario 的 baseline jobId
  ops JSONB,                                   -- scenario 的调整操作集
  status TEXT NOT NULL DEFAULT 'pending',      -- pending / running / done / failed
  progress INT NOT NULL DEFAULT 0,
  solution JSONB,                              -- 全量解（面板用）
  metrics JSONB,                               -- 聚合指标（LLM 用）
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS confirm_tokens (
  token TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  impact_hash TEXT NOT NULL,                   -- 落库时校验：方案未被偷换
  expires_at TIMESTAMPTZ NOT NULL
);
