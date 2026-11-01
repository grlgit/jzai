/**
 * T1.5 单测：AuthzController 授权编辑边界与分享语义。
 * 用真实 ResourceAccessService（mock 其依赖 meta/grants/db），
 * 使 canGrant 真值表语义在 controller 边界上被断言，而非仅 mock 掉。
 */
import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { AuthzController } from './authz.controller';
import { ResourceAccessService } from './resource-access.service';
import type { ResourceMetaService, ResourceMeta } from './resource-meta.service';
import type { ResourceGrantService } from './resource-grant.service';
import type { DbService } from '../../db/db.service';

const adminReq = { user: { id: 'u_admin', role: { id: 'admin', permissions: ['sys:admin'] } } };
const userReq = (id: string) => ({ user: { id, role: { id: 'user', permissions: ['chat:use'] } } });

function make(metaRow: ResourceMeta | undefined) {
  const meta = { get: jest.fn(async () => metaRow ?? null) } as unknown as ResourceMetaService;
  const grants = {
    listGrants: jest.fn(async () => []),
    replaceGrants: jest.fn(async () => {}),
    setGrant: jest.fn(async () => {}),
    hasGrant: jest.fn(async () => false),
  } as unknown as ResourceGrantService;
  const db = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('jz_users')) return { rows: [{ id: 'u1', name: 'A' }] };
      if (sql.includes('jz_roles')) return { rows: [{ id: 'user', name: 'User' }] };
      return { rows: [{ id: 'd1', name: 'Dept' }] };
    }),
  } as unknown as DbService;
  const access = new ResourceAccessService(meta, grants);
  const ctrl = new AuthzController(meta, grants, access, db);
  return { ctrl, meta, grants, db, access };
}

const globalMeta: ResourceMeta = {
  resourceType: 'agent', resourceId: 'a1', scope: 'global',
  builtin: false, defaultVisibility: 'none',
};
const userMeta = (owner: string): ResourceMeta => ({
  resourceType: 'agent', resourceId: 'u_x_a1', scope: 'user', ownerUserId: owner,
  builtin: false, defaultVisibility: 'none',
});

describe('AuthzController', () => {
  it('用例1：非 admin 对 global 资源 PUT grants → 403；admin → 200', async () => {
    const { ctrl, grants } = make(globalMeta);
    await expect(
      ctrl.putGrants('agent', 'a1', { grants: [] }, userReq('u1')),
    ).rejects.toThrow(ForbiddenException);

    const res = await ctrl.putGrants('agent', 'a1', {
      grants: [{ subId: '', targetType: 'user', targetId: 'u1', level: 'user' }],
    }, adminReq);
    expect(res).toEqual({ success: true, count: 1 });
    expect(grants.replaceGrants).toHaveBeenCalledWith('agent', 'a1', [
      expect.objectContaining({ resourceType: 'agent', resourceId: 'a1', targetId: 'u1' }),
    ], 'u_admin');
  });

  it('用例2：owner POST share → 200，写 user grant；被分享者 canView 变 true', async () => {
    const { ctrl, grants, access } = make(userMeta('u_owner'));
    const res = await ctrl.share('agent', 'u_x_a1', { userIds: ['u_friend'] }, userReq('u_owner'));
    expect(res).toEqual({ success: true, shared: 1 });
    expect(grants.setGrant).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'user', targetId: 'u_friend', level: 'user' }),
      'u_owner',
    );
    // 被分享者经 access.canView 判定可见（fail-closed → grant 命中）
    (grants.hasGrant as jest.Mock).mockResolvedValueOnce(true);
    const p = { type: 'user', principalId: 'user:u_friend', userId: 'u_friend',
      roleIds: ['user'], departmentIds: [], permissions: [], scopes: [], origin: 't', issuedAt: 0 } as any;
    await expect(access.canView('agent', 'u_x_a1', p)).resolves.toBe(true);
  });

  it('用例2补充：非 owner 分享 → 403；global 资源走 share → 400', async () => {
    const { ctrl } = make(userMeta('u_owner'));
    await expect(
      ctrl.share('agent', 'u_x_a1', { userIds: ['x'] }, userReq('u_other')),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      ctrl.share('agent', 'u_x_a1', { userIds: ['x'] }, adminReq), // admin 也不是 owner
    ).rejects.toThrow(ForbiddenException);

    const g = make(globalMeta);
    await expect(
      g.ctrl.share('agent', 'a1', { userIds: ['x'] }, adminReq),
    ).rejects.toThrow(BadRequestException);
  });

  it('用例3：admin 对他人 user 资源 PUT grants → 403（admin 不可授权他人用户类资源）', async () => {
    const { ctrl } = make(userMeta('u_owner'));
    await expect(
      ctrl.putGrants('agent', 'u_x_a1', { grants: [] }, adminReq),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      ctrl.getGrants('agent', 'u_x_a1', adminReq),
    ).rejects.toThrow(ForbiddenException);
    // owner 可读可写
    const ok = make(userMeta('u_owner'));
    await expect(ok.ctrl.getGrants('agent', 'u_x_a1', userReq('u_owner'))).resolves.toBeTruthy();
    await expect(
      ok.ctrl.putGrants('agent', 'u_x_a1', { grants: [] }, userReq('u_owner')),
    ).resolves.toEqual({ success: true, count: 0 });
  });

  it('用例4：PUT 整体替换语义——body 全量透传给 replaceGrants；count 不计 none 行', async () => {
    const { ctrl, grants } = make(globalMeta);
    const res = await ctrl.putGrants('agent', 'a1', {
      grants: [
        { subId: '', targetType: 'role', targetId: 'ops', level: 'user' },
        { subId: 'tool_a', targetType: 'user', targetId: 'u2', level: 'admin' },
        { subId: '', targetType: 'user', targetId: 'u3', level: 'none' },
      ],
    }, adminReq);
    expect(res.count).toBe(2);
    const passed = (grants.replaceGrants as jest.Mock).mock.calls[0][2];
    expect(passed).toHaveLength(3); // none 行也透传，由 service 层跳过（保持替换语义完整）
    expect(passed[0]).toMatchObject({ resourceType: 'agent', resourceId: 'a1' });
  });

  it('subjects：需 canGrant；返回用户/角色/部门三类清单', async () => {
    const { ctrl, db } = make(globalMeta);
    const res = await ctrl.getSubjects('agent', 'a1', adminReq);
    expect(res.users).toHaveLength(1);
    expect(res.roles).toHaveLength(1);
    expect(res.departments).toHaveLength(1);
    const sqls = (db.query as jest.Mock).mock.calls.map(c => c[0]);
    expect(sqls.some(s => s.includes('jz_users') && s.includes("status = 'active'"))).toBe(true);

    await expect(ctrl.getSubjects('agent', 'a1', userReq('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('非法资源类型 → 400', async () => {
    const { ctrl } = make(globalMeta);
    await expect(ctrl.getGrants('hack', 'a1', adminReq)).rejects.toThrow(BadRequestException);
  });
});
