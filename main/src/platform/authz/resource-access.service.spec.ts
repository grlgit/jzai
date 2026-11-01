/**
 * T1.3 单测：ResourceAccessService 判定真值表（设计 §3.3 逐行）+ AUTHZ_ENFORCE 开关 + filterVisible 批量。
 */
import { ForbiddenException } from '@nestjs/common';
import { ResourceAccessService } from './resource-access.service';
import type { ResourceMeta } from './resource-meta.service';
import type { InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';

const P = (over: Partial<InvocationPrincipal> = {}): InvocationPrincipal => ({
  type: 'user' as any, principalId: over.userId ?? 'u1', userId: 'u1',
  roleIds: ['user'], departmentIds: [], permissions: [], scopes: [],
  origin: 'test', issuedAt: Date.now(), ...over,
});
const admin = P({ userId: 'boss', permissions: ['sys:admin'] });

const meta = (over: Partial<ResourceMeta>): ResourceMeta => ({
  resourceType: 'agent', resourceId: 'x', scope: 'global',
  builtin: false, defaultVisibility: 'none', ...over,
});

describe('ResourceAccessService', () => {
  let svc: ResourceAccessService;
  let metas: Map<string, ResourceMeta>;
  let grantedIds: Set<string>;
  let hasGrantResult: boolean;
  let sqlCalls: number;

  beforeEach(() => {
    process.env.AUTHZ_ENFORCE = '1';
    metas = new Map();
    grantedIds = new Set();
    hasGrantResult = false;
    sqlCalls = 0;
    const metaSvc: any = {
      get: async (t: string, id: string) => { sqlCalls++; return metas.get(`${t}:${id}`); },
      getMany: async (t: string, ids: string[]) => {
        sqlCalls++;
        const m = new Map();
        for (const id of ids) { const v = metas.get(`${t}:${id}`); if (v) m.set(id, v); }
        return m;
      },
    };
    const grantSvc: any = {
      hasGrant: async () => { sqlCalls++; return hasGrantResult; },
      visibleIds: async () => { sqlCalls++; return grantedIds; },
    };
    svc = new ResourceAccessService(metaSvc, grantSvc);
  });

  afterAll(() => { delete process.env.AUTHZ_ENFORCE; });

  describe('真值表（设计 §3.3）', () => {
    it('行1 global × admin：可见/可编辑/可授权', async () => {
      metas.set('agent:g1', meta({ resourceId: 'g1' }));
      expect(await svc.canView('agent', 'g1', admin)).toBe(true);
      expect(await svc.canEdit('agent', 'g1', admin)).toBe(true);
      expect(await svc.canGrant('agent', 'g1', admin)).toBe(true);
    });

    it('行2 global × 有grant普通用户：可见/不可编辑/不可授权', async () => {
      metas.set('agent:g1', meta({ resourceId: 'g1' }));
      hasGrantResult = true;
      expect(await svc.canView('agent', 'g1', P())).toBe(true);
      expect(await svc.canEdit('agent', 'g1', P())).toBe(false);
      expect(await svc.canGrant('agent', 'g1', P())).toBe(false);
    });

    it('行3 user类（他人创建）× admin：可见 / 不可编辑 / 不可授权', async () => {
      metas.set('agent:ua', meta({ resourceId: 'ua', scope: 'user', ownerUserId: 'u1' }));
      expect(await svc.canView('agent', 'ua', admin)).toBe(true);     // admin 可见
      expect(await svc.canEdit('agent', 'ua', admin)).toBe(false);    // 不可编辑（需求明确）
      expect(await svc.canGrant('agent', 'ua', admin)).toBe(false);   // 不可授权
    });

    it('行4 user类 × 被分享者：可见/不可编辑', async () => {
      metas.set('agent:ua', meta({ resourceId: 'ua', scope: 'user', ownerUserId: 'owner9' }));
      hasGrantResult = true; // 分享 = user grant
      const viewer = P({ userId: 'u2', principalId: 'u2' });
      expect(await svc.canView('agent', 'ua', viewer)).toBe(true);
      expect(await svc.canEdit('agent', 'ua', viewer)).toBe(false);
    });

    it('行5 user类 × owner：全权', async () => {
      metas.set('skill:mine', meta({ resourceType: 'skill', resourceId: 'mine', scope: 'user', ownerUserId: 'u1' }));
      expect(await svc.canView('skill', 'mine', P())).toBe(true);
      expect(await svc.canEdit('skill', 'mine', P())).toBe(true);
      expect(await svc.canGrant('skill', 'mine', P())).toBe(true); // 分享权
    });

    it('行6 无授权普通用户：global/none 资源不可见（fail-closed）', async () => {
      metas.set('connector:c1', meta({ resourceType: 'connector', resourceId: 'c1' }));
      hasGrantResult = false;
      expect(await svc.canView('connector', 'c1', P())).toBe(false);
    });

    it('行7 default_visibility=all：任意登录用户可见（存量兜底）', async () => {
      metas.set('agent:legacy', meta({ resourceId: 'legacy', defaultVisibility: 'all' }));
      expect(await svc.canView('agent', 'legacy', P())).toBe(true);
    });
  });

  it('main 智能体对无任何授权的用户恒可见（硬例外，无 meta 也可见）', async () => {
    expect(await svc.canView('agent', 'main', P())).toBe(true);
  });

  it('无 meta 行的资源 fail-closed（admin 除外）', async () => {
    expect(await svc.canView('agent', 'ghost', P())).toBe(false);
    expect(await svc.canView('agent', 'ghost', admin)).toBe(true);
  });

  it('system/service/dev-mcp principal 放行；delegated 仍按用户过滤', async () => {
    expect(await svc.canView('connector', 'c1', P({ type: 'system' as any }))).toBe(true);
    expect(await svc.canView('connector', 'c1', P({ type: 'service' as any }))).toBe(true);
    expect(await svc.canView('connector', 'c1', P({ origin: 'scheduler' }))).toBe(true);
    metas.set('connector:c1', meta({ resourceType: 'connector', resourceId: 'c1' }));
    expect(await svc.canView('connector', 'c1', P({ type: 'delegated' as any }))).toBe(false);
  });

  it('AUTHZ_ENFORCE=0：canView 恒 true，canEdit 回落 admin 判定', async () => {
    process.env.AUTHZ_ENFORCE = '0';
    expect(await svc.canView('agent', 'anything', P())).toBe(true);
    expect(await svc.canEdit('agent', 'anything', P())).toBe(false);
    expect(await svc.canEdit('agent', 'anything', admin)).toBe(true);
    process.env.AUTHZ_ENFORCE = '1';
  });

  it('filterVisible：批量路径常数次查询；混合场景过滤正确', async () => {
    metas.set('agent:main', meta({ resourceId: 'main', builtin: true, defaultVisibility: 'all' }));
    metas.set('agent:legacy', meta({ resourceId: 'legacy', defaultVisibility: 'all' }));
    metas.set('agent:granted', meta({ resourceId: 'granted' }));
    metas.set('agent:mine', meta({ resourceId: 'mine', scope: 'user', ownerUserId: 'u1' }));
    metas.set('agent:others', meta({ resourceId: 'others', scope: 'user', ownerUserId: 'u9' }));
    // ghost 无 meta
    grantedIds = new Set(['granted']);

    const items = ['main', 'legacy', 'granted', 'mine', 'others', 'ghost'].map(id => ({ id }));
    sqlCalls = 0;
    const visible = await svc.filterVisible('agent', items, x => x.id, P());
    expect(visible.map(x => x.id)).toEqual(['main', 'legacy', 'granted', 'mine']);
    expect(sqlCalls).toBe(2); // getMany + visibleIds，与条目数无关（防 N+1）

    // admin 直通不触发查询
    sqlCalls = 0;
    const all = await svc.filterVisible('agent', items, x => x.id, admin);
    expect(all).toHaveLength(6);
    expect(sqlCalls).toBe(0);
  });

  it('assertCanEdit 拒绝时抛 ForbiddenException', async () => {
    metas.set('agent:g1', meta({ resourceId: 'g1' }));
    await expect(svc.assertCanEdit('agent', 'g1', P())).rejects.toThrow(ForbiddenException);
    await expect(svc.assertCanEdit('agent', 'g1', admin)).resolves.toBeUndefined();
  });
});
