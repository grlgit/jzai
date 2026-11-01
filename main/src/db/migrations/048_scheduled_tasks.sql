-- 048: Scheduled tasks (P2 全局定时器, docs/rework-2026H2/design-p2-scheduler.md §3)

CREATE TABLE IF NOT EXISTS jz_scheduled_tasks (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  cron           TEXT NOT NULL,
  timezone       TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  target_type    TEXT NOT NULL CHECK (target_type IN ('agent','skill')),
  target_id      TEXT NOT NULL,
  payload        JSONB NOT NULL DEFAULT '{}',
  run_as_user_id TEXT NOT NULL,
  on_confirm     TEXT NOT NULL DEFAULT 'reject' CHECK (on_confirm IN ('reject','skip_tool')),
  timeout_sec    INTEGER NOT NULL DEFAULT 300,
  max_retries    INTEGER NOT NULL DEFAULT 0,
  created_by TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS jz_scheduled_task_runs (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES jz_scheduled_tasks(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed','timeout','skipped')),
  trigger TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron','manual')),
  output TEXT, error TEXT, duration_ms INTEGER, session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task ON jz_scheduled_task_runs (task_id, started_at DESC);
