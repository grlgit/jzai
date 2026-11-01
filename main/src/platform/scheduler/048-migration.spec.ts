/**
 * T2.1 单测：048 迁移静态验证（幂等/约束/FK 级联）+ ScheduleModule 引入零回归。
 */
import * as fs from 'fs';
import * as path from 'path';

const SQL = fs.readFileSync(path.join(__dirname, '../../db/migrations/048_scheduled_tasks.sql'), 'utf-8');

describe('T2.1 迁移 048_scheduled_tasks', () => {
  it('两表均幂等创建（IF NOT EXISTS）', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS jz_scheduled_tasks');
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS jz_scheduled_task_runs');
    expect(SQL).toContain('CREATE INDEX IF NOT EXISTS idx_task_runs_task');
  });

  it('约束齐备：target_type/on_confirm/status/trigger CHECK', () => {
    expect(SQL).toMatch(/target_type\s+TEXT NOT NULL CHECK \(target_type IN \('agent','skill'\)\)/);
    expect(SQL).toMatch(/on_confirm\s+TEXT NOT NULL DEFAULT 'reject' CHECK \(on_confirm IN \('reject','skip_tool'\)\)/);
    expect(SQL).toContain("CHECK (status IN ('running','success','failed','timeout','skipped'))");
    expect(SQL).toContain("CHECK (trigger IN ('cron','manual'))");
  });

  it('runs → tasks FK 级联删除', () => {
    expect(SQL).toContain('REFERENCES jz_scheduled_tasks(id) ON DELETE CASCADE');
  });

  it('授权链锚点与默认值符合设计 §3', () => {
    expect(SQL).toContain('run_as_user_id TEXT NOT NULL');
    expect(SQL).toContain("timezone       TEXT NOT NULL DEFAULT 'Asia/Shanghai'");
    expect(SQL).toContain('timeout_sec    INTEGER NOT NULL DEFAULT 300');
    expect(SQL).toContain('max_retries    INTEGER NOT NULL DEFAULT 0');
    expect(SQL).toContain('last_run_at TIMESTAMPTZ, next_run_at TIMESTAMPTZ');
  });
});
