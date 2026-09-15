/**
 * 迁移 030 单测：验证 SQL 文件的结构和内容是否符合规范。
 * 使用静态分析方式，不依赖数据库驱动。
 *
 * 对于需要真实 PG 的断言（实际列存在、权限拒绝），
 * 见集成测（需 TEST_DATABASE_URL 环境变量）。
 */

import * as fs from 'fs';
import * as path from 'path';

function loadSql(filename: string): string {
  return fs.readFileSync(
    path.join(__dirname, '..', filename),
    'utf-8',
  );
}

describe('迁移 030：静态内容验证', () => {
  let sql: string;

  beforeAll(() => {
    sql = loadSql('030_panel_category.sql');
  });

  it('文件存在且非空', () => {
    expect(sql.length).toBeGreaterThan(100);
  });

  it('包含 jz_panels 的 ADD COLUMN 语句（6列）', () => {
    const cols = ['category', 'source_app_id', 'agent_id', 'uninstallable', 'entry_component', 'name_i18n'];
    for (const col of cols) {
      expect(sql).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS ${col}`, 'i'));
    }
  });

  it('包含 jz_panels category CHECK 约束', () => {
    expect(sql).toMatch(/jz_panels_category_chk/);
    expect(sql).toMatch(/system.*builtin.*third_party/s);
  });

  it('包含 jz_app_grants 表创建', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS jz_app_grants/i);
    expect(sql).toMatch(/jz_app_grants_role_chk/i);
    expect(sql).toMatch(/user.*admin/s);
  });

  it('包含 jz_panel_message_handlers 表创建', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS jz_panel_message_handlers/i);
    expect(sql).toMatch(/validator_path/i);
  });

  it('包含 jz_app_audit_log 表创建', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS jz_app_audit_log/i);
    expect(sql).toMatch(/BIGSERIAL/i);
  });

  it('包含 system 类别回填（agents 和 cfg）', () => {
    expect(sql).toMatch(/category\s*=\s*'system'.*agents.*cfg/s);
  });

  it('包含 builtin 类别回填（含 dimensionTuner）', () => {
    expect(sql).toMatch(/category\s*=\s*'builtin'/i);
    expect(sql).toMatch(/dimensionTuner/);
  });

  it('包含 agent_id 回填（4 个面板）', () => {
    expect(sql).toMatch(/skill_master/);
    expect(sql).toMatch(/connector_master/);
    expect(sql).toMatch(/data_master/);
    expect(sql).toMatch(/dimension_classifier/);
  });

  it('dimensionTuner 不再设置平台权限 dt:use', () => {
    expect(sql).not.toMatch(/permission\s*=\s*'dt:use'/i);
  });
});
