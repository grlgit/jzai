import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from './require-permission.decorator';

/**
 * 全局权限守卫：只对标注了 @RequirePermission/@RequireAdmin 的端点生效，
 * 未标注端点直接放行（零破坏引入，存量端点逐个加注解渐进加固）。
 * 依赖 JwtAuthGuard 先行挂载 request.user（APP_GUARD 注册顺序保证）。
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    // WebSocket 权限由各 gateway 自行校验（与 JwtAuthGuard 约定一致）
    if (context.getType<string>() === 'ws') return true;

    const request = context.switchToHttp().getRequest();
    const perms: string[] = request.user?.role?.permissions || [];

    // sys:admin 直通；否则 AND 语义逐项校验
    if (perms.includes('sys:admin')) return true;
    const missing = required.filter(p => !perms.includes(p));
    if (missing.length > 0) {
      throw new ForbiddenException(`缺少权限: ${missing.join(', ')}`);
    }
    return true;
  }
}
