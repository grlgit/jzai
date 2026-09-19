-- 039_app_migration_journal_status.sql
-- PLAT-009：迁移日志三态（applying/applied），支持进程中断后的恢复判定。
-- applying = 迁移 SQL 已开始执行但事务结果未知；applied = SQL 与日志均已提交。

ALTER TABLE jz_app_migrations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'applied';

-- 历史记录均为已成功写入日志的迁移，保持默认 applied 即可。
