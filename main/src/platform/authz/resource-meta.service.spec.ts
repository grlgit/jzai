/**
 * T1.1 单测：迁移 046/047 静态验证 + ResourceMetaService 行为（mock DbService）。
 * 真实 PG 集成断言（建表/回填幂等）在部署环境跑迁移后人工验证，见 tasks-p1.md T1.1 测试结果。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ResourceMetaService, ALWAYS_VISIBLE_AGENTS } from './resource-meta.service';

function loadSql(filename: string): string {
  return fs.readFileSync(path.join(__dirname, '../../db/migrations', filename), 'utf-8');
}

describe('迁移 046/047 静态验证', () => {
  it('046 建两表且全部幂等（IF NOT EXISTS）', () => {
    const sql = loadSql('046_resource_grants.sql');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS jz_resource_meta');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS jz_resource_grants');
    // 所有 CREATE 语句都带 IF NOT EXISTS（幂等）
    const creates = sql.match(/CREATE (TABLE|INDEX)/g) || [];
    const idempotent = sql.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) || [];
    expect(creates.length).toBe(idempotent.length);
    // 关键约束
    expect(sql).toMatch(/scope IN \('global','user'\)/);
    expect(sql).toMatch(/default_visibility IN \('none','all'\)/);
    expect(sql).toMatch(/target_type IN \('user','role','department'\)/);
    expect(sql).toMatch(/level IN \('none','user','admin'\)/);
    // sub_id 默认 '' 且入主键（"全部"语义 + per-tool）
    expect(sql).toMatch(/sub_id\s+TEXT NOT NULL DEFAULT ''/);
    expect(sql).toMatch(/PRIMARY KEY \(resource_type, resource_id, sub_id, target_type, target_id\)/);
    // user 类必须有 owner
    expect(sql).toMatch(/scope <> 'user' OR owner_user_id IS NOT NULL/);
  });

  it('047 回填 panel/app 且冲突跳过（幂等）', () => {
    const sql = loadSql('047_resource_meta_backfill.sql');
    expect(sql).toContain("'panel'");
    expect(sql).toContain('FROM jz_panels');
    expect(sql).toContain('FROM jz_installed_apps');
    expect((sql.match(/ON CONFLICT [^;]*DO NOTHING/g) || []).length).toBe(2);
    // 内置 panel 回填 all、APP 面板 none（可见性沿用 jz_app_grants）
    expect(sql).toMatch(/CASE WHEN p\.source_app_id IS NULL THEN 'all' ELSE 'none' END/);
  });

  it('main 智能体在全员可见例外清单中', () => {
    expect(ALWAYS_VISIBLE_AGENTS).toContain('main');
  });
});

describe('ResourceMetaService', () => {
  let svc: ResourceMetaService;
  let queries: { sql: string; params: any[] }[];
  let rowsToReturn: any[];
  let tmpRoot: string;

  const mkDb = () => ({
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      return { rows: rowsToReturn };
    }),
    transaction: jest.fn(async (fn: any) => fn({ query: async (sql: string, params: any[]) => { queries.push({ sql, params }); return { rows: [] }; } })),
  });

  const mkWorkspace = (root: string) => ({
    getAgentsDir: () => path.join(root, 'agents'),
    getConfigDir: () => path.join(root, 'config'),
  });

  beforeEach(() => {
    queries = [];
    rowsToReturn = [];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-test-'));
    svc = new ResourceMetaService(mkDb() as any, mkWorkspace(tmpRoot) as any);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('getMany 空输入不触发 SQL；批量读单条 SQL', async () => {
    expect((await svc.getMany('agent', [])).size).toBe(0);
    expect(queries).toHaveLength(0);

    rowsToReturn = [
      { resource_type: 'agent', resource_id: 'a1', scope: 'global', owner_user_id: null, source_app_id: null, builtin: true, default_visibility: 'all', created_by: null },
      { resource_type: 'agent', resource_id: 'a2', scope: 'user', owner_user_id: 'u1', source_app_id: null, builtin: false, default_visibility: 'none', created_by: 'u1' },
    ];
    const map = await svc.getMany('agent', ['a1', 'a2', 'a3']);
    expect(queries).toHaveLength(1); // 单条批量 SQL，防 N+1
    expect(map.get('a1')?.defaultVisibility).toBe('all');
    expect(map.get('a2')?.ownerUserId).toBe('u1');
    expect(map.has('a3')).toBe(false);
  });

  it('upsert 冲突更新；ensure 冲突跳过', async () => {
    const meta = { resourceType: 'skill' as const, resourceId: 's1', scope: 'user' as const, ownerUserId: 'u1', builtin: false, defaultVisibility: 'none' as const };
    await svc.upsert(meta);
    expect(queries[0].sql).toContain('DO UPDATE SET');
    await svc.ensure(meta);
    expect(queries[1].sql).toContain('DO NOTHING');
  });

  it('remove 在事务内先删 grants 再删 meta', async () => {
    await svc.remove('agent', 'a1');
    expect(queries.map(q => q.sql.match(/DELETE FROM (\S+)/)?.[1])).toEqual(['jz_resource_grants', 'jz_resource_meta']);
  });

  describe('backfillOnBoot（临时目录真实文件扫描）', () => {
    it('agent YAML → global/all，builtin 透传；坏文件跳过', async () => {
      const dir = path.join(tmpRoot, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'main.yaml'), 'id: main\nname: 主智能体\nbuiltin: true\n');
      fs.writeFileSync(path.join(dir, 'custom.yaml'), 'id: custom\nname: 自定义\n');
      fs.writeFileSync(path.join(dir, 'broken.yaml'), '{{{not yaml');
      fs.writeFileSync(path.join(dir, '.hidden.yaml'), 'id: hidden\n');

      await svc.backfillOnBoot();

      const ensures = queries.filter(q => q.sql.includes('DO NOTHING') && q.params[0] === 'agent');
      const ids = ensures.map(q => q.params[1]);
      expect(ids).toEqual(expect.arrayContaining(['main', 'custom']));
      expect(ids).not.toContain('hidden');
      const mainRow = ensures.find(q => q.params[1] === 'main')!;
      // params: [type, id, scope, owner, appId, builtin, visibility, createdBy]
      expect(mainRow.params[2]).toBe('global');
      expect(mainRow.params[5]).toBe(true);
      expect(mainRow.params[6]).toBe('all');
    });

    it('skill 目录（含 SKILL.md 才算）→ global/all', async () => {
      const dir = path.join(tmpRoot, 'config', 'skills');
      fs.mkdirSync(path.join(dir, 'sk-a'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'sk-a', 'SKILL.md'), '# a');
      fs.mkdirSync(path.join(dir, 'not-skill'), { recursive: true }); // 无 SKILL.md

      await svc.backfillOnBoot();

      const ids = queries.filter(q => q.params?.[0] === 'skill').map(q => q.params[1]);
      expect(ids).toEqual(['sk-a']);
    });

    it('connector 无 ACL → all；有 ACL → none 并平移 grants', async () => {
      const dir = path.join(tmpRoot, 'config', 'mcp');
      fs.mkdirSync(path.join(dir, 'open-conn'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'open-conn', 'manifest.yaml'), 'name: open-conn\n');
      fs.mkdirSync(path.join(dir, 'locked-conn'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'locked-conn', 'manifest.yaml'),
        'name: locked-conn\npermissions:\n  allowedRoles: [ops]\n  allowedUsers: [u9]\n');

      await svc.backfillOnBoot();

      const metas = queries.filter(q => q.sql.includes('jz_resource_meta') && q.params?.[0] === 'connector');
      expect(metas.find(q => q.params[1] === 'open-conn')!.params[6]).toBe('all');
      expect(metas.find(q => q.params[1] === 'locked-conn')!.params[6]).toBe('none');
      // ACL 平移：role + user ���一条 grant
      const grants = queries.filter(q => q.sql.includes('INSERT INTO jz_resource_grants'));
      // target_type 内联在 SQL 字面量中，target_id 是第 3 个参数
      const pairs = grants.map(g => [g.sql.includes("'role'") ? 'role' : 'user', g.params[2]]);
      expect(pairs).toEqual(expect.arrayContaining([['role', 'ops'], ['user', 'u9']]));
    });
  });
});
