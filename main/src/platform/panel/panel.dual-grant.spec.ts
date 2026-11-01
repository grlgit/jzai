/**
 * T1.10 单测：sidebar 双表 UNION ALL 判定 + app-grant 双写。
 * mock DbService 断言 SQL 形态与参数（真实 PG 语义对拍待部署环境）。
 */
import { PanelService } from './panel.service';
import { AppGrantService } from '../app-store/services/app-grant.service';

function makeDb(calls: Array<{ sql: string; params: any[] }>, responses: any[] = []) {
  let i = 0;
  const db = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const r = responses[i++] ?? { rows: [] };
      return r;
    }),
  } as any;
  return db;
}

describe('T1.10 sidebar 双表判定', () => {
  it('getUserSidebar：SQL 含 UNION ALL 双表（旧 app_grants + 新 resource_grants panel），面板 id 与 permission 双键匹配', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const db = makeDb(calls, [
      { rows: [{ exists: true }] },              // appTableExists
      { rows: [                                  // 面板行：第三方无 grant 被过滤；新表有 grant 的保留
        { id: 'p_legacy', permission: null, isBuiltin: true, defaultOrder: 1, category: 'builtin', visible: true, groupName: '', sortOrder: 1, grantRole: null },
        { id: 'p_new', permission: 'perm_x', isBuiltin: false, defaultOrder: 2, category: 'third_party', sourceAppId: 'app1', visible: true, groupName: '', sortOrder: 2, grantRole: 'user' },
        { id: 'p_denied', permission: 'perm_y', isBuiltin: false, defaultOrder: 3, category: 'third_party', sourceAppId: 'app1', visible: true, groupName: '', sortOrder: 3, grantRole: null },
      ] },
    ]);
    const svc = new PanelService(db, {} as any);
    const items = await svc.getUserSidebar('u1', ['chat:use']);
    const sidebarSql = calls[1].sql;

    // 双表 UNION ALL 形态断言
    expect(sidebarSql).toContain('UNION ALL');
    expect(sidebarSql).toContain("FROM jz_app_grants g");
    expect(sidebarSql).toContain("FROM jz_resource_grants rg");
    expect(sidebarSql).toContain("rg.resource_type = 'panel'");
    expect(sidebarSql).toContain('rg.resource_id = p.id');
    expect(sidebarSql).toContain("(rg.sub_id = '' OR p.permission IS NULL OR rg.sub_id = p.permission)");
    expect(sidebarSql).toContain('jz_department_members');
    // 过滤语义：普通用户第三方面板必须 grantRole 非空
    expect(items.map((i: any) => i.id)).toEqual(['p_legacy', 'p_new']);
  });

  it('admin 不受 grant 限制（第三方无 grant 也可见）', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const db = makeDb(calls, [
      { rows: [{ exists: true }] },
      { rows: [
        { id: 'p_denied', permission: 'perm_y', isBuiltin: false, defaultOrder: 3, category: 'third_party', sourceAppId: 'app1', visible: true, groupName: '', sortOrder: 3, grantRole: null },
      ] },
    ]);
    const svc = new PanelService(db, {} as any);
    const items = await svc.getUserSidebar('admin1', ['sys:admin']);
    expect(items.map((i: any) => i.id)).toEqual(['p_denied']);
  });
});

describe('T1.10 app-grant 双写', () => {
  const registry = { findOne: jest.fn(async () => ({ manifest: { permissions: [{ id: 'perm_x' }] } })) } as any;

  it('用例3：setGrant 后旧表与新表各写一行且语义一致（参数对拍）', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const db = makeDb(calls);
    const svc = new AppGrantService(db, registry);
    await svc.setGrant({ appId: 'app1', permissionId: 'perm_x', targetType: 'user', targetId: 'u1', level: 'user' });

    expect(calls).toHaveLength(2);
    // 旧表
    expect(calls[0].sql).toContain('INSERT INTO jz_app_grants');
    expect(calls[0].params).toEqual(['app1', 'perm_x', 'user', 'u1', 'user']);
    // 新表：resource_type='app'、sub_id=permissionId
    expect(calls[1].sql).toContain('INSERT INTO jz_resource_grants');
    expect(calls[1].sql).toContain("VALUES ('app',$1,$2,$3,$4,$5,NULL)");
    expect(calls[1].params).toEqual(['app1', 'perm_x', 'user', 'u1', 'user']);
  });

  it('level=none 时双删', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    const db = makeDb(calls);
    const svc = new AppGrantService(db, registry);
    await svc.setGrant({ appId: 'app1', permissionId: 'perm_x', targetType: 'role', targetId: 'ops', level: 'none' });
    expect(calls[0].sql).toContain('DELETE FROM jz_app_grants');
    expect(calls[1].sql).toContain('DELETE FROM jz_resource_grants');
    expect(calls[1].params).toEqual(['app1', 'perm_x', 'role', 'ops']);
  });

  it('用例4：AUTHZ_DUAL_WRITE=0 停止双写，旧表语义不变', async () => {
    process.env.AUTHZ_DUAL_WRITE = '0';
    try {
      const calls: Array<{ sql: string; params: any[] }> = [];
      const db = makeDb(calls);
      const svc = new AppGrantService(db, registry);
      await svc.setGrant({ appId: 'app1', permissionId: 'perm_x', targetType: 'user', targetId: 'u1', level: 'admin' });
      expect(calls).toHaveLength(1);
      expect(calls[0].sql).toContain('jz_app_grants');
    } finally {
      delete process.env.AUTHZ_DUAL_WRITE;
    }
  });

  it('双写异常降级 warn，不阻断旧表写入', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    let n = 0;
    const db = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (++n === 2) throw new Error('no such table');
        return { rows: [] };
      }),
      transaction: jest.fn(),
    } as any;
    const svc = new AppGrantService(db, registry);
    await expect(svc.setGrant({ appId: 'app1', permissionId: 'perm_x', targetType: 'user', targetId: 'u1', level: 'user' }))
      .resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('未声明 permission 仍 400（先于双写）', async () => {
    const db = makeDb([]);
    const svc = new AppGrantService(db, registry);
    await expect(svc.setGrant({ appId: 'app1', permissionId: 'undeclared', targetType: 'user', targetId: 'u1', level: 'user' }))
      .rejects.toThrow('not declared');
  });
});
