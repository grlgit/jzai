/**
 * T1.7 单测：技能 owner 编辑语义 + 凭证越权修复（V5 安全回归）。
 * 真实 SkillRegistryService（临时目录）+ 真实 ResourceAccessService（内存 meta/grants mock）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SkillRegistryService } from './skill-registry.service';
import { SkillController } from './skill.controller';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';
import type { ResourceMetaService, ResourceMeta } from '../../platform/authz/resource-meta.service';
import type { ResourceGrantService } from '../../platform/authz/resource-grant.service';

const userReq = (id: string) => ({ user: { id, role: { id: 'user', permissions: ['chat:use'] } } });
const adminReq = { user: { id: 'admin1', role: { id: 'admin', permissions: ['sys:admin'] } } };

function makeCtx() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const skillsDir = path.join(cfgDir, 'skills');
  // 预置一个存量 global 技能（回填语义：default_visibility=all）
  fs.mkdirSync(path.join(skillsDir, 'legacy-tool'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'legacy-tool', 'SKILL.md'),
    '---\nname: legacy-tool\ndescription: legacy\n---\n\nbody\n');
  const workspace = { getConfigDir: () => cfgDir } as any;

  const store = new Map<string, ResourceMeta>();
  store.set('skill:legacy-tool', {
    resourceType: 'skill', resourceId: 'legacy-tool', scope: 'global',
    builtin: false, defaultVisibility: 'all',
  });
  const meta = {
    get: async (t: string, id: string) => store.get(`${t}:${id}`),
    getMany: async (t: string, ids: string[]) =>
      new Map(ids.filter(id => store.has(`${t}:${id}`)).map(id => [id, store.get(`${t}:${id}`)!])),
    upsert: async (m: ResourceMeta) => { store.set(`${m.resourceType}:${m.resourceId}`, m); },
    remove: jest.fn(async (t: string, id: string) => { store.delete(`${t}:${id}`); }),
  } as unknown as ResourceMetaService;

  const grantRows: Array<{ id: string; targetId: string }> = [];
  const grants = {
    hasGrant: jest.fn(async (t: string, id: string, p: any) =>
      grantRows.some(g => g.id === id && g.targetId === p.userId)),
    visibleIds: jest.fn(async (t: string, p: any) =>
      new Set(grantRows.filter(g => g.targetId === p.userId).map(g => g.id))),
  } as unknown as ResourceGrantService;

  const access = new ResourceAccessService(meta, grants);
  const registry = new SkillRegistryService(workspace, meta, access);
  const credentials = {
    listUserSystems: jest.fn((uid: string) => [`systems-of-${uid}`]),
    saveUserCredentials: jest.fn(),
    deleteUserCredentials: jest.fn(),
    listGlobalSystems: jest.fn(() => ['g1']),
    saveGlobalCredentials: jest.fn(),
    deleteGlobalCredentials: jest.fn(),
  } as any;
  const executor = { test: jest.fn(() => ({ ok: true })), execute: jest.fn(() => ({ ok: true })) } as any;
  const userService = {
    hasPermission: jest.fn((token: string, perm: string) => token === 'admin-token'),
  } as any;
  const controller = new SkillController(
    registry, {} as any, executor, {} as any, credentials, userService,
    { getSourceMap: async () => new Map() } as any, access,
  );
  return { registry, controller, store, grantRows, credentials, executor, userService, access };
}

async function createUserSkill(ctx: ReturnType<typeof makeCtx>, name: string, userId: string) {
  // 模拟 generate/discover 路径：allocate + save(actor)
  const p = { permissions: [], userId, roleIds: [], departmentIds: [], scopes: [], type: 'user', principalId: `user:${userId}`, origin: 't', issuedAt: 0 } as any;
  const allocated = ctx.registry.allocateSkillName(name, p);
  await ctx.registry.save({
    name: allocated, description: 'd', instructions: 'i', dirName: allocated,
    hasHandler: false, hasReferences: false, hasAssets: false,
  }, undefined, p);
  return allocated;
}

describe('T1.7 Skill 权限改造', () => {
  it('用例1：普通用户建技能 → u- 前缀 user 类，owner 全属性可编辑（instructions/scripts 均 200）', async () => {
    const ctx = makeCtx();
    const name = await createUserSkill(ctx, 'order-entry', 'alice');
    expect(name).toBe('u-alice-order-entry');
    expect(ctx.store.get(`skill:${name}`)).toMatchObject({ scope: 'user', ownerUserId: 'alice' });

    await expect(ctx.controller.saveInstructions(name, { content: 'x' }, userReq('alice')))
      .resolves.toEqual({ success: true });
    await expect(ctx.controller.saveScript(name, 'handler.ts', { content: 'x' }, userReq('alice')))
      .resolves.toEqual({ success: true });
  });

  it('用例2：非 owner 改技能 403；admin 改 user 类 403；admin 改 global 200', async () => {
    const ctx = makeCtx();
    const name = await createUserSkill(ctx, 'order-entry', 'alice');
    await expect(ctx.controller.saveInstructions(name, { content: 'x' }, userReq('bob')))
      .rejects.toThrow(ForbiddenException);
    await expect(ctx.controller.saveInstructions(name, { content: 'x' }, adminReq))
      .rejects.toThrow(ForbiddenException);
    await expect(ctx.controller.deleteSkill(name, adminReq)).rejects.toThrow(ForbiddenException);

    // global 技能（存量 visibility=all）：普通用户可见不可编辑，admin 可编辑
    await expect(ctx.controller.saveInstructions('legacy-tool', { content: 'x' }, userReq('bob')))
      .rejects.toThrow(ForbiddenException);
    await expect(ctx.controller.saveInstructions('legacy-tool', { content: 'x' }, adminReq))
      .resolves.toEqual({ success: true });
  });

  it('用例3【安全回归 V5】：body 塞 userId=B → 凭证写入 A 名下；list 返回 A 自己的', async () => {
    const ctx = makeCtx();
    ctx.controller.saveCredentials(
      { userId: 'bob', systemName: 'erp', credentials: { u: 'x' } }, userReq('alice'));
    expect(ctx.credentials.saveUserCredentials).toHaveBeenCalledWith('alice', 'erp', { u: 'x' });
    expect(ctx.credentials.saveUserCredentials).not.toHaveBeenCalledWith('bob', expect.anything(), expect.anything());

    const list = ctx.controller.listCredentials(userReq('alice'));
    expect(ctx.credentials.listUserSystems).toHaveBeenCalledWith('alice');
    expect(list).toEqual(['systems-of-alice']);

    ctx.controller.deleteCredentials('erp', userReq('alice'));
    expect(ctx.credentials.deleteUserCredentials).toHaveBeenCalledWith('alice', 'erp');
  });

  it('用例4：global 凭证三端点仍仅 admin', () => {
    const ctx = makeCtx();
    const userAuth = 'Bearer user-token';
    const adminAuth = 'Bearer admin-token';
    expect(() => ctx.controller.listGlobalCredentials(userAuth)).toThrow(ForbiddenException);
    expect(() => ctx.controller.saveGlobalCredentials(userAuth, { systemName: 's', credentials: {} })).toThrow(ForbiddenException);
    expect(() => ctx.controller.deleteGlobalCredentials(userAuth, 's')).toThrow(ForbiddenException);
    expect(ctx.controller.listGlobalCredentials(adminAuth)).toEqual(['g1']);
  });

  it('用例5：无 canView 的技能 execute/test → 403；有 grant → 放行', async () => {
    const ctx = makeCtx();
    const name = await createUserSkill(ctx, 'order-entry', 'alice');
    await expect(ctx.controller.executeSkill(name, {}, userReq('bob'))).rejects.toThrow(ForbiddenException);
    await expect(ctx.controller.testSkill(name, userReq('bob'))).rejects.toThrow(ForbiddenException);

    ctx.grantRows.push({ id: name, targetId: 'bob' });
    await expect(ctx.controller.executeSkill(name, {}, userReq('bob'))).resolves.toEqual({ ok: true });
    // owner 始终可用
    await expect(ctx.controller.testSkill(name, userReq('alice'))).resolves.toEqual({ ok: true });
  });

  it('列表按 principal 过滤并注解 canEdit；技能名冲突 → 409', async () => {
    const ctx = makeCtx();
    const name = await createUserSkill(ctx, 'order-entry', 'alice');

    const aliceList = await ctx.controller.listSkills(userReq('alice'));
    const row = aliceList.find((s: any) => s.name === name);
    expect(row).toMatchObject({ scope: 'user', ownerUserId: 'alice', canEdit: true });

    const bobList = await ctx.controller.listSkills(userReq('bob'));
    expect(bobList.map((s: any) => s.name)).not.toContain(name);
    expect(bobList.map((s: any) => s.name)).toContain('legacy-tool'); // visibility=all 存量可见

    // 同名冲突 409（alice 再建同名）
    const p = { permissions: [], userId: 'alice', roleIds: [], departmentIds: [], scopes: [], type: 'user', principalId: 'user:alice', origin: 't', issuedAt: 0 } as any;
    expect(() => ctx.registry.allocateSkillName('order-entry', p)).toThrow(/已被占用/);
  });

  it('assertSkillEditable 对不存在技能 → 404', async () => {
    const ctx = makeCtx();
    await expect(ctx.controller.saveInstructions('ghost', { content: 'x' }, adminReq))
      .rejects.toThrow(NotFoundException);
  });
});
