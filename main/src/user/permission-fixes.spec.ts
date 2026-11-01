/**
 * 角色权限问题清单修复（2026-10-26）：
 * 1. 非管理员首次登录自助改密不再被 cfg:users 拦截；/api/auth/me 返回 passwordChanged（刷新不跳过强制改密）
 * 2/3. 一级菜单 nav:* 权限可单独授予/收回（技能/连接/智能体/应用/数据仪表/设置）
 */
import { UserController } from './user.controller';
import { UserService, ALL_PERMISSIONS, Permission } from './user.service';
import { PanelService } from '../platform/panel/panel.service';
import * as fs from 'fs';
import * as path from 'path';

// ---- Issue 1：自助改密 ----

function makeController(opts: { meUserId?: string | null }) {
  const userService = {
    verifyTokenFull: jest.fn(async () =>
      opts.meUserId ? ({ id: opts.meUserId } as any) : null),
    hasPermission: jest.fn(() => false), // 无 cfg:users
    updateUser: jest.fn(async (id: string, body: any) => ({ id, body })),
  } as unknown as UserService;
  const ctrl = new UserController(userService, {} as any);
  const req = { headers: { authorization: 'Bearer fake' }, ip: '127.0.0.1' };
  return { ctrl, req, userService };
}

describe('Issue 1: 非管理员首次登录自助改密', () => {
  it('本人 + 仅 password → 放行（无需 cfg:users）', async () => {
    const { ctrl, req, userService } = makeController({ meUserId: 'u1' });
    const out = await ctrl.updateUser(req, 'u1', { password: 'NewPass123' });
    expect(userService.updateUser).toHaveBeenCalledWith('u1', { password: 'NewPass123' });
    expect((out as any).id).toBe('u1');
  });

  it('本人但带其他字段（如 roleId）→ 403（防自助提权）', async () => {
    const { ctrl, req } = makeController({ meUserId: 'u1' });
    await expect(ctrl.updateUser(req, 'u1', { password: 'NewPass123', roleId: 'admin' })).rejects.toThrow('权限不足');
  });

  it('他人改密 → 403', async () => {
    const { ctrl, req } = makeController({ meUserId: 'u1' });
    await expect(ctrl.updateUser(req, 'u2', { password: 'x' })).rejects.toThrow('权限不足');
  });

  it('mapUser 携带 passwordChanged（/api/auth/me 刷新不跳过强制改密）', async () => {
    const svc = Object.create(UserService.prototype) as any;
    svc.getRole = jest.fn(async () => ({ id: 'user', name: '普通用户', permissions: [], isSystem: true }));
    const u = await svc['mapUser']({ id: 'u1', name: 'A', username: 'a', email: 'a@x', role_id: 'user', status: 'active', password_changed: false });
    expect(u.passwordChanged).toBe(false);
    const u2 = await svc['mapUser']({ id: 'u2', name: 'B', username: 'b', email: 'b@x', role_id: 'user', status: 'active', password_changed: true });
    expect(u2.passwordChanged).toBe(true);
  });
});

// ---- Issue 2/3：菜单权限 ----

describe('Issue 2/3: 一级菜单导航权限', () => {
  it('ALL_PERMISSIONS 含全部 nav:* 项', () => {
    for (const p of ['nav:skills', 'nav:connectors', 'nav:agents', 'nav:apps', 'nav:dashboard', 'nav:settings']) {
      expect(ALL_PERMISSIONS).toContain(p);
    }
  });

  it('内置面板权限映射（静态断言）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../platform/panel/panel.service.ts'), 'utf-8');
    expect(src).toContain("id: 'skills'");
    expect(src).toMatch(/id: 'skills'[\s\S]*?permission: 'nav:skills'/);
    expect(src).toMatch(/id: 'connectors'[\s\S]*?permission: 'nav:connectors'/);
    expect(src).toMatch(/id: 'agents'[\s\S]*?permission: 'nav:agents'/);
    expect(src).toMatch(/id: 'apps'[\s\S]*?permission: 'nav:apps'/);
    expect(src).toMatch(/id: 'dashboard'[\s\S]*?permission: 'nav:dashboard'/);
    expect(src).toMatch(/id: 'cfg'[\s\S]*?permission: 'nav:settings'/);
  });

  it('侧栏过滤：有 nav:skills 的非管理员可见技能，无 nav:settings 不可见设置', async () => {
    const db: any = {
      query: jest.fn(async (sql: string) => {
        if (sql.includes('to_regclass')) return { rows: [{ tbl: null }] };
        if (sql.includes('jz_panels')) {
          return {
            rows: [
              { id: 'skills', name: '技能', icon: '', permission: 'nav:skills', isBuiltin: false, category: 'builtin', sourceAppId: null, agentId: null, uninstallable: false, nameI18n: null, visible: true, groupName: '', sortOrder: 5, customName: null, customIcon: null, grantRole: null },
              { id: 'cfg', name: '设置', icon: '', permission: 'nav:settings', isBuiltin: true, category: 'system', sourceAppId: null, agentId: null, uninstallable: false, nameI18n: null, visible: true, groupName: '', sortOrder: 9, customName: null, customIcon: null, grantRole: null },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const svc = new PanelService(db);
    const items = await svc.getUserSidebar('u1', ['nav:skills']);
    const ids = items.map(i => i.id);
    expect(ids).toContain('skills');
    expect(ids).not.toContain('cfg');
  });

  it('迁移 051 回填存量角色（SQL 断言）', () => {
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations/051_nav_permissions.sql'), 'utf-8');
    for (const p of ['nav:settings', 'nav:apps', 'nav:dashboard']) {
      expect(sql).toContain(`array_append(permissions, '${p}')`);
    }
    // 不回填技能/连接/智能体（维持仅管理员可见现状）
    expect(sql).not.toContain("array_append(permissions, 'nav:skills')");
  });
});
