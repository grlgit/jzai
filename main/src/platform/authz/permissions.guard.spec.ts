/**
 * T1.4 单测：PermissionsGuard 零破坏引入 + 装饰器语义。
 */
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { RequirePermission, RequireAdmin, PERMISSIONS_KEY } from './require-permission.decorator';

function ctx(opts: { required?: string[]; userPerms?: string[]; type?: string }) {
  const reflector = {
    getAllAndOverride: jest.fn(() => opts.required),
  } as unknown as Reflector;
  const context: any = {
    getHandler: () => ({}),
    getClass: () => ({}),
    getType: () => opts.type ?? 'http',
    switchToHttp: () => ({
      getRequest: () => ({ user: opts.userPerms ? { role: { permissions: opts.userPerms } } : undefined }),
    }),
  };
  return { guard: new PermissionsGuard(reflector), context };
}

describe('PermissionsGuard', () => {
  it('无装饰器端点放行（零破坏引入）', () => {
    const { guard, context } = ctx({ required: undefined, userPerms: [] });
    expect(guard.canActivate(context)).toBe(true);
    const empty = ctx({ required: [], userPerms: [] });
    expect(empty.guard.canActivate(empty.context)).toBe(true);
  });

  it('@RequireAdmin：普通用户 403、admin 放行', () => {
    const denied = ctx({ required: ['sys:admin'], userPerms: ['chat:use'] });
    expect(() => denied.guard.canActivate(denied.context)).toThrow(ForbiddenException);
    const ok = ctx({ required: ['sys:admin'], userPerms: ['sys:admin'] });
    expect(ok.guard.canActivate(ok.context)).toBe(true);
  });

  it('@RequirePermission 指定权限：持有者放行（非 admin）；sys:admin 直通任意要求', () => {
    const ok = ctx({ required: ['kb:write'], userPerms: ['kb:write', 'chat:use'] });
    expect(ok.guard.canActivate(ok.context)).toBe(true);
    const adminBypass = ctx({ required: ['kb:write', 'cfg:users'], userPerms: ['sys:admin'] });
    expect(adminBypass.guard.canActivate(adminBypass.context)).toBe(true);
  });

  it('多权限 AND 语义：缺任一则 403 且报缺失项', () => {
    const { guard, context } = ctx({ required: ['kb:write', 'cfg:users'], userPerms: ['kb:write'] });
    try {
      guard.canActivate(context);
      fail('should throw');
    } catch (e: any) {
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.message).toContain('cfg:users');
    }
  });

  it('request.user 缺失（异常态）：有要求的端点 403', () => {
    const { guard, context } = ctx({ required: ['kb:write'], userPerms: undefined });
    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('WS 上下文放行（权限由 gateway 自行校验）', () => {
    const { guard, context } = ctx({ required: ['sys:admin'], userPerms: [], type: 'ws' });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('装饰器元数据正确', () => {
    class T {
      @RequirePermission('a:b', 'c:d') m1() {}
      @RequireAdmin() m2() {}
    }
    const r = new Reflector();
    expect(r.get(PERMISSIONS_KEY, T.prototype.m1)).toEqual(['a:b', 'c:d']);
    expect(r.get(PERMISSIONS_KEY, T.prototype.m2)).toEqual(['sys:admin']);
  });
});
