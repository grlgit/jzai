import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppRegistryService } from './app-registry.service';

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
    const res = await this.db.query(
      `SELECT 1 FROM jz_app_grants
       WHERE app_id=$1 AND target_type='user' AND target_id=$2 AND level != 'none'
       LIMIT 1`,
      [appId, userId],
    );
    return res.rows.length > 0;
  }
}
