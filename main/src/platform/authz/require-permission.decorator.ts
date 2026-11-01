import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'requiredPermissions';

/**
 * 声明端点所需的全局权限（jz_roles.permissions 中的 module:action 串）。
 * 由全局 PermissionsGuard 执行；未标注的端点行为不变（仅 JwtAuthGuard 认证）。
 * 多个权限为 AND 语义。sys:admin 持有者直通。
 */
export const RequirePermission = (...perms: string[]) => SetMetadata(PERMISSIONS_KEY, perms);

/** 管理员专用端点 */
export const RequireAdmin = () => RequirePermission('sys:admin');
