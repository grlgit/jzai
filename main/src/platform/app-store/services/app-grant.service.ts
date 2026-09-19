import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppRegistryService } from './app-registry.service';
import type { InvocationPrincipal } from '../runtime/invocation-principal';

export type GrantLevel = 'none' | 'user' | 'admin';

export interface AppGrant {
  appId: string;
  permissionId: string;
  targetType: 'user' | 'department' | 'role';
  targetId: string;
  level: GrantLevel;
}

@Injectable()
export class AppGrantService {
  private readonly logger = new Logger(AppGrantService.name);

  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
  ) {}

  async getGrants(appId: string): Promise<AppGrant[]> {
    const res = await this.db.query(
      `SELECT app_id, permission_id, target_type, target_id, level
       FROM jz_app_grants WHERE app_id = $1`,
      [appId],
    );
    return res.rows.map(r => ({
      appId: r.app_id,
      permissionId: r.permission_id,
      targetType: r.target_type,
      targetId: r.target_id,
      level: r.level,
    }));
  }

  async setGrant(grant: AppGrant): Promise<void> {
    const app = await this.registry.findOne(grant.appId);
    if (!app) throw new NotFoundException(`App ${grant.appId} not found`);

    const declared = app.manifest?.permissions?.map(p => p.id) ?? [];
    if (!declared.includes(grant.permissionId)) {
      throw new BadRequestException(`Permission ${grant.permissionId} not declared in manifest`);
    }

    if (grant.level === 'none') {
      await this.db.query(
        `DELETE FROM jz_app_grants
         WHERE app_id=$1 AND permission_id=$2 AND target_type=$3 AND target_id=$4`,
        [grant.appId, grant.permissionId, grant.targetType, grant.targetId],
      );
    } else {
      await this.db.query(
        `INSERT INTO jz_app_grants (app_id, permission_id, target_type, target_id, level)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (app_id, permission_id, target_type, target_id)
         DO UPDATE SET level=$5`,
        [grant.appId, grant.permissionId, grant.targetType, grant.targetId, grant.level],
      );
    }
  }

  async hasPermission(appId: string, permissionId: string, userId: string): Promise<boolean> {
    const res = await this.db.query(
      `SELECT 1 FROM jz_app_grants
       WHERE app_id=$1 AND permission_id=$2 AND target_type='user' AND target_id=$3
         AND level != 'none'
       LIMIT 1`,
      [appId, permissionId, userId],
    );
    return res.rows.length > 0;
  }

  /** True if the user has any non-none grant for the app. */
  async hasAppAccess(appId: string, userId: string): Promise<boolean> {
    return this.hasAppAccessForPrincipal(appId, {
      type: 'user',
      principalId: `user:${userId}`,
      userId,
      roleIds: [],
      departmentIds: [],
      permissions: [],
      scopes: [],
      origin: 'legacy-app-grant',
      issuedAt: Date.now(),
    });
  }

  async hasAppAccessForPrincipal(appId: string, principal: InvocationPrincipal): Promise<boolean> {
    if (!principal.userId) return false;
    const res = await this.db.query(
      `SELECT 1
       FROM jz_app_grants g
       WHERE g.app_id=$1
         AND g.level != 'none'
         AND (
           (g.target_type='user' AND g.target_id=$2)
           OR (g.target_type='role' AND g.target_id = ANY($3::text[]))
           OR (g.target_type='department' AND (
             g.target_id = ANY($4::text[])
             OR g.target_id IN (
               SELECT dm.department_id
               FROM jz_department_members dm
               WHERE dm.user_id=$2
             )
           ))
         )
       LIMIT 1`,
      [appId, principal.userId, [...principal.roleIds], [...principal.departmentIds]],
    );
    return res.rows.length > 0;
  }

  // ── 细粒度权限（PLAT-010）──

  /** manifest 中某 handler（"Class.method"）声明的 required permission，未声明返回 undefined */
  async getRequiredHandlerPermission(appId: string, handler: string): Promise<string | undefined> {
    const app = await this.registry.findOne(appId);
    for (const controller of app?.manifest?.backend?.controllers ?? []) {
      const perm = controller.permissions?.[handler];
      if (perm) return perm;
    }
    return undefined;
  }

  /** manifest 中某 tool 声明的 required permission，未声明返回 undefined */
  async getRequiredToolPermission(appId: string, toolId: string): Promise<string | undefined> {
    const app = await this.registry.findOne(appId);
    for (const tp of app?.manifest?.backend?.toolProviders ?? []) {
      const perm = tp.permissions?.[toolId];
      if (perm) return perm;
    }
    return undefined;
  }

  /**
   * 判定 principal 是否持有某具体 permission。
   * 覆盖 user/role/department 三类 target；无任何匹配授权行时按
   * manifest.permissions[].default 判定（'user' 放行，'admin'/'none'/未设置 fail-closed，
   * sys:admin 由调用方先行直通）。
   */
  async hasPermissionForPrincipal(
    appId: string,
    permissionId: string,
    principal: InvocationPrincipal,
  ): Promise<boolean> {
    if (!principal.userId) return false;
    const res = await this.db.query(
      `SELECT 1
       FROM jz_app_grants g
       WHERE g.app_id=$1
         AND g.permission_id=$2
         AND g.level != 'none'
         AND (
           (g.target_type='user' AND g.target_id=$3)
           OR (g.target_type='role' AND g.target_id = ANY($4::text[]))
           OR (g.target_type='department' AND (
             g.target_id = ANY($5::text[])
             OR g.target_id IN (
               SELECT dm.department_id
               FROM jz_department_members dm
               WHERE dm.user_id=$3
             )
           ))
         )
       LIMIT 1`,
      [appId, permissionId, principal.userId, [...principal.roleIds], [...principal.departmentIds]],
    );
    if (res.rows.length > 0) return true;

    const app = await this.registry.findOne(appId);
    const declared = app?.manifest?.permissions?.find(p => p.id === permissionId);
    return declared?.default === 'user';
  }
}
