/**
 * T1.6 单测：智能体注册表与 controller 权限改造（修 V1/V2）。
 * 真实 AgentRegistryService（临时目录）+ 真实 ResourceAccessService（内存 meta/grants mock）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AgentRegistryService } from './agent-registry.service';
import { AgentRegistryController } from './agent-registry.controller';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';
import type { ResourceMetaService, ResourceMeta } from '../../platform/authz/resource-meta.service';
import type { ResourceGrantService } from '../../platform/authz/resource-grant.service';
import { IS_PUBLIC_KEY } from '../../platform/auth/public.decorator';

const userReq = (id: string) => ({ user: { id, role: { id: 'user', permissions: ['chat:use'] } } });
const adminReq = { user: { id: 'admin1', role: { id: 'admin', permissions: ['sys:admin'] } } };

function makeCtx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  // 预置 main（内置硬例外）与一个存量 agent
  fs.writeFileSync(path.join(dir, 'main.yaml'), 'agent:\n  id: main\n  name: Main\n  builtin: true\n');
  const workspace = { getAgentsDir: () => dir } as any;

  const store = new Map<string, ResourceMeta>();
  const meta = {
    get: async (t: string, id: string) => store.get(`${t}:${id}`),
    getMany: async (t: string, ids: string[]) =>
      new Map(ids.filter(id => store.has(`${t}:${id}`)).map(id => [id, store.get(`${t}:${id}`)!])),
    upsert: async (m: ResourceMeta) => { store.set(`${m.resourceType}:${m.resourceId}`, m); },
    ensure: async (m: ResourceMeta) => { const k = `${m.resourceType}:${m.resourceId}`; if (!store.has(k)) store.set(k, m); },
    remove: jest.fn(async (t: string, id: string) => { store.delete(`${t}:${id}`); }),
  } as unknown as ResourceMetaService;

  const grantRows: Array<{ id: string; targetId: string }> = [];
  const grants = {
    hasGrant: jest.fn(async (t: string, id: string, p: any) =>
      grantRows.some(g => g.id === id && g.targetId === p.userId)),
    visibleIds: jest.fn(async (t: string, p: any) =>
      new Set(grantRows.filter(g => g.targetId === p.userId).map(g => g.id))),
    visibleSubIds: jest.fn(async () => new Set<string>()),
  } as unknown as ResourceGrantService;

  const access = new ResourceAccessService(meta, grants);
  const registry = new AgentRegistryService(workspace, meta, access);
  const controller = new AgentRegistryController(
    registry,
    { getAvailableToolCatalog: () => [], getBuiltinToolsByCategory: () => [] } as any,
    { getSourceMap: async () => new Map() } as any,
    access,
  );
  return { dir, meta, grants, grantRows, access, registry, controller, store };
}

const NEW_AGENT = { id: 'helper', name: 'Helper', icon: '🤖', description: '', modelLevel: 'default' as const, soul: '', tools: [] };

describe('T1.6 AgentRegistry 权限改造', () => {
  it('用例1：普通用户建 agent → u_{uid}_ 前缀、meta scope=user、仅自己与 admin 可见', async () => {
    const { controller, store } = makeCtx();
    const res = await controller.create({ ...NEW_AGENT } as any, userReq('alice'));
    expect(res.success).toBe(true);
    expect(res.id).toBe('u_alice_helper');
    expect(store.get('agent:u_alice_helper')).toMatchObject({
      scope: 'user', ownerUserId: 'alice', defaultVisibility: 'none',
    });

    const aliceList = await controller.list(userReq('alice'));
    expect(aliceList.map((a: any) => a.id)).toContain('u_alice_helper');
    const aliceRow = aliceList.find((a: any) => a.id === 'u_alice_helper');
    expect(aliceRow).toMatchObject({ scope: 'user', ownerUserId: 'alice', canEdit: true });

    const bobList = await controller.list(userReq('bob'));
    expect(bobList.map((a: any) => a.id)).not.toContain('u_alice_helper');

    const adminList = await controller.list(adminReq);
    expect(adminList.map((a: any) => a.id)).toContain('u_alice_helper');
    // admin 对他人 user 类资源 canEdit=false（真值表）
    expect(adminList.find((a: any) => a.id === 'u_alice_helper')!.canEdit).toBe(false);
  });

  it('用例2：admin 建 agent → scope=global、未授权用户不可见；main 始终在普通用户列表', async () => {
    const { controller, store } = makeCtx();
    const res = await controller.create({ ...NEW_AGENT, id: 'ops-bot' } as any, adminReq);
    expect(res.id).toBe('ops-bot'); // admin 不加前缀
    expect(store.get('agent:ops-bot')).toMatchObject({ scope: 'global', defaultVisibility: 'none' });

    const bobList = await controller.list(userReq('bob'));
    const ids = bobList.map((a: any) => a.id);
    expect(ids).not.toContain('ops-bot');
    expect(ids).toContain('main'); // 硬例外（main 无 meta 也可见）
  });

  it('用例3：同名创建 → 409，且不覆盖既有 YAML', async () => {
    const { controller, dir } = makeCtx();
    await controller.create({ ...NEW_AGENT } as any, userReq('alice'));
    const file = path.join(dir, 'u_alice_helper.yaml');
    const before = fs.readFileSync(file, 'utf-8');
    await expect(controller.create({ ...NEW_AGENT } as any, userReq('alice')))
      .rejects.toThrow(ConflictException);
    expect(fs.readFileSync(file, 'utf-8')).toBe(before);
    // 普通用户请求内置 id（如 main）也被前缀化，不会撞上内置 YAML
    const res = await controller.create({ ...NEW_AGENT, id: 'main' } as any, userReq('alice'));
    expect(res.id).toBe('u_alice_main');
  });

  it('用例4：普通用户 PUT/DELETE 他人 agent → 403；owner → 200；admin 对 user 类 → 403', async () => {
    const { controller, meta } = makeCtx();
    const { id } = await controller.create({ ...NEW_AGENT } as any, userReq('alice'));

    await expect(controller.update(id, { description: 'x' }, userReq('bob'))).rejects.toThrow(ForbiddenException);
    await expect(controller.remove(id, userReq('bob'))).rejects.toThrow(ForbiddenException);
    await expect(controller.update(id, { description: 'x' }, adminReq)).rejects.toThrow(ForbiddenException);
    await expect(controller.remove(id, adminReq)).rejects.toThrow(ForbiddenException);

    await expect(controller.update(id, { description: 'x' }, userReq('alice'))).resolves.toEqual({ success: true });
    await expect(controller.remove(id, userReq('alice'))).resolves.toEqual({ success: true });
    expect((meta.remove as jest.Mock)).toHaveBeenCalledWith('agent', id);
  });

  it('用例5：list/available-tools/tool-catalog 已无 @Public 元数据（V1 修复，未登录由 JwtAuthGuard 挡 401）', () => {
    const r = new Reflector();
    for (const m of ['list', 'availableTools', 'toolCatalog'] as const) {
      expect(r.get(IS_PUBLIC_KEY, AgentRegistryController.prototype[m])).toBeUndefined();
    }
  });

  it('用例6：ui_control 委派候选过滤已接入 filterVisible（静态断言）', () => {
    const src = fs.readFileSync(path.join(__dirname, 'dynamic-agent.service.ts'), 'utf-8');
    const block = src.match(/if \(def\.tools\.includes\('ui_control'\)\) \{([\s\S]*?)\n    \}/);
    expect(block).toBeTruthy();
    expect(block![1]).toContain('filterVisible');
    expect(block![1]).toContain("filterVisible('agent'");
  });

  it('delete 连带清理 meta/grants（meta.remove 内部事务删两表）', async () => {
    const { registry, meta } = makeCtx();
    await registry.save({ ...NEW_AGENT, id: 'tmp1', builtin: false } as any,
      { permissions: ['sys:admin'], userId: 'admin1' } as any);
    expect(await registry.delete('tmp1')).toBe(true);
    expect((meta.remove as jest.Mock)).toHaveBeenCalledWith('agent', 'tmp1');
    // builtin 不可删
    expect(await registry.delete('main')).toBe(false);
  });
});
