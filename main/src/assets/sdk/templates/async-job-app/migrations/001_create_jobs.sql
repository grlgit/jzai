-- 裸表名即可：search_path 已固定到本应用 schema
CREATE TABLE IF NOT EXISTS aj_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,                          -- 任务类型，如 monthly-report
  status TEXT NOT NULL DEFAULT 'pending',      -- pending / running / done / failed
  progress INT NOT NULL DEFAULT 0,             -- 0-100
  result JSONB,                                -- 完成后的结果（或失败原因 { error }）
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
