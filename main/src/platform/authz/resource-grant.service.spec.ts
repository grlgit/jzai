/**
 * T1.2 单测：ResourceGrantService（mock DbService，断言 SQL 形态与参数语义）。
 * 三路匹配的真实 SQL 语义（含 jz_department_members 间接匹配）需真实 PG 验证，
 * 此处断言 SQL 文本包含三路条件与正确参数绑定。
 */
import { ResourceGrantService } from './resource-grant.service';
import type { InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';

const principal = (over: Partial<InvocationPrincipal> = {}): InvocationPrincipal => ({
  type: 'user' as any, principalId: 'u1', userId: 'u1',
  roleIds: ['user'], departmentIds: ['d1'], permissions: [], scopes: [],
  origin: 'test', issuedAt: Date.now(), ...over,
});

describe('ResourceGrantService', () => {
  let svc: ResourceGrantService;
  let queries: { sql: string; params: any[] }[];
  let rowsToReturn: any[];

  beforeEach(() => {
    queries = [];
    rowsToReturn = [];
    const db: any = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        return { rows: rowsToReturn, rowCount: rowsToReturn.length };
      }),
      transaction: jest.fn(async (fn: any) =>
        fn({ query: async (sql: string, params: any[]) => { queries.push({ sql, params }); return { rows: [] }; } })),
    };
    svc = new ResourceGrantService(db);
  });

  it('setGrant level=none → DELETE；否则 INSERT ... ON CONFLICT DO UPDATE', async () => {
    await svc.setGrant({ resourceType: 'agent', resourceId: 'a1', targetType: 'user', targetId: 'u2', level: 'none' });
    expect(queries[0].sql).toContain('DELETE FROM jz_resource_grants');

    await svc.setGrant({ resourceType: 'agent', resourceId: 'a1', targetType: 'role', targetId: 'ops', level: 'user' }, 'admin1');
    expect(queries[1].sql).toContain('ON CONFLICT');
    expect(queries[1].sql).toContain('DO UPDATE SET level');
    // subId 缺省归一为 ''
    expect(queries[1].params[2]).toBe('');
    expect(queries[1].params[6]).toBe('admin1');
  });

  it('replaceGrants 事务内先整删后插入，跳过 level=none', async () => {
    await svc.replaceGrants('connector', 'erp', [
      { resourceType: 'connector', resourceId: 'erp', targetType: 'user', targetId: 'u2', level: 'user', subId: 'tool_a' },
      { resourceType: 'connector', resourceId: 'erp', targetType: 'role', targetId: 'x', level: 'none' },
    ], 'admin1');
    const sqls = queries.map(q => q.sql);
    expect(sqls[0]).toContain('DELETE FROM jz_resource_grants');
    expect(sqls.filter(s => s.includes('INSERT INTO jz_resource_grants'))).toHaveLength(1); // none 被跳过
    expect(queries[1].params[2]).toBe('tool_a');
  });

  it('hasGrant：无 userId 直接 false 不触发 SQL；subId 参数为 ["", subId]（"全部"覆盖）', async () => {
    expect(await svc.hasGrant('tool', 't1', principal({ userId: undefined }))).toBe(false);
    expect(queries).toHaveLength(0);

    rowsToReturn = [{ '?column?': 1 }];
    expect(await svc.hasGrant('connector', 'erp', principal(), 'tool_a')).toBe(true);
    const q = queries[0];
    // 三路匹配条件齐备
    expect(q.sql).toContain("g.target_type='user'");
    expect(q.sql).toContain("g.target_type='role'");
    expect(q.sql).toContain("g.target_type='department'");
    expect(q.sql).toContain('jz_department_members');
    // 参数：userId / roleIds / sub 集合 / departmentIds
    expect(q.params[2]).toBe('u1');
    expect(q.params[3]).toEqual(['user']);
    expect(q.params[4]).toEqual(['', 'tool_a']);
    expect(q.params[5]).toEqual(['d1']);

    // 不带 subId 时只查 ''
    await svc.hasGrant('connector', 'erp', principal());
    expect(queries[1].params[4]).toEqual(['']);
  });

  it('visibleIds 单 SQL 返回 Set；无 userId 返回空集', async () => {
    expect((await svc.visibleIds('agent', principal({ userId: undefined }))).size).toBe(0);

    rowsToReturn = [{ resource_id: 'a1' }, { resource_id: 'a2' }];
    const ids = await svc.visibleIds('agent', principal());
    expect(queries).toHaveLength(1);
    expect(ids).toEqual(new Set(['a1', 'a2']));
    expect(queries[0].sql).toContain('DISTINCT g.resource_id');
  });

  it('visibleSubIds：含 "" 行返回 null（全部）；否则返回子项集合', async () => {
    rowsToReturn = [{ sub_id: '' }, { sub_id: 'tool_a' }];
    expect(await svc.visibleSubIds('connector', 'erp', principal())).toBeNull();

    rowsToReturn = [{ sub_id: 'tool_a' }, { sub_id: 'tool_b' }];
    expect(await svc.visibleSubIds('connector', 'erp', principal())).toEqual(new Set(['tool_a', 'tool_b']));

    rowsToReturn = [];
    expect((await svc.visibleSubIds('connector', 'erp', principal()))!.size).toBe(0);
  });

  it('removeAllForTarget 按 target 清理（删除级联）', async () => {
    rowsToReturn = [];
    await svc.removeAllForTarget('role', 'ops');
    expect(queries[0].sql).toContain('WHERE target_type=$1 AND target_id=$2');
    expect(queries[0].params).toEqual(['role', 'ops']);
  });

  it('level 过滤：所有判定 SQL 均排除 none', async () => {
    rowsToReturn = [];
    await svc.hasGrant('agent', 'a1', principal());
    await svc.visibleIds('agent', principal());
    await svc.visibleSubIds('connector', 'c1', principal());
    for (const q of queries) expect(q.sql).toContain(`g.level <> 'none'`);
  });
});
