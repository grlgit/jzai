import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import type { InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import type { ResourceType } from './resource-meta.service';

export type GrantTargetType = 'user' | 'role' | 'department';
export type GrantLevel = 'none' | 'user' | 'admin';

export interface ResourceGrant {
  resourceType: ResourceType;
  resourceId: string;
  /** '' = 整资源（"全部"）；非空 = 连接下的某工具名 */
  subId?: string;
  targetType: GrantTargetType;
  targetId: string;
  level: GrantLevel;
  grantedBy?: string;
}

/**
 * 通用资源授权（jz_resource_grants）。
 * 三路匹配语义与 AppGrantService.hasPermissionForPrincipal 对齐：
 * user 直授 / role 匹配 / department（直接或经 jz_department_members 间接）。
 */
@Injectable()
export class ResourceGrantService {
  private readonly logger = new Logger(ResourceGrantService.name);

  constructor(private readonly db: DbService) {}

  async listGrants(t: ResourceType, id: string): Promise<ResourceGrant[]> {
    const res = await this.db.query(
      `SELECT * FROM jz_resource_grants WHERE resource_type=$1 AND resource_id=$2 ORDER BY sub_id, target_type, target_id`,
      [t, id],
    );
    return res.rows.map(r => this.rowToGrant(r));
  }

  async setGrant(g: ResourceGrant, actorId?: string): Promise<void> {
    const subId = g.subId ?? '';
    if (g.level === 'none') {
      await this.db.query(
        `DELETE FROM jz_resource_grants
         WHERE resource_type=$1 AND resource_id=$2 AND sub_id=$3 AND target_type=$4 AND target_id=$5`,
        [g.resourceType, g.resourceId, subId, g.targetType, g.targetId],
      );
    } else {
      await this.db.query(
        `INSERT INTO jz_resource_grants (resource_type, resource_id, sub_id, target_type, target_id, level, granted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (resource_type, resource_id, sub_id, target_type, target_id) DO UPDATE SET level=$6, granted_by=$7`,
        [g.resourceType, g.resourceId, subId, g.targetType, g.targetId, g.level, actorId ?? g.grantedBy ?? null],
      );
    }
  }

  /** 事务内整体替换某资源的全部授权（授权编辑器的保存语义） */
  async replaceGrants(t: ResourceType, id: string, grants: ResourceGrant[], actorId?: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(
        `DELETE FROM jz_resource_grants WHERE resource_type=$1 AND resource_id=$2`, [t, id]);
      for (const g of grants) {
        if (g.level === 'none') continue;
        await client.query(
          `INSERT INTO jz_resource_grants (resource_type, resource_id, sub_id, target_type, target_id, level, granted_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
          [t, id, g.subId ?? '', g.targetType, g.targetId, g.level, actorId ?? null],
        );
      }
    });
  }

  async removeAllFor(t: ResourceType, id: string): Promise<void> {
    await this.db.query(
      `DELETE FROM jz_resource_grants WHERE resource_type=$1 AND resource_id=$2`, [t, id]);
  }

  /** 用户/角色/部门删除时的级联清理 */
  async removeAllForTarget(targetType: GrantTargetType, targetId: string): Promise<void> {
    const res = await this.db.query(
      `DELETE FROM jz_resource_grants WHERE target_type=$1 AND target_id=$2`, [targetType, targetId]);
    if (res.rowCount) this.logger.log(`Removed ${res.rowCount} grants for deleted ${targetType} ${targetId}`);
  }

  /**
   * principal 对某资源（可选 subId）是否有授权。
   * subId 匹配语义：sub_id IN ('', $subId)——'' 的"全部"授权覆盖任意子项。
   */
  async hasGrant(t: ResourceType, id: string, p: InvocationPrincipal, subId?: string): Promise<boolean> {
    if (!p.userId) return false;
    const res = await this.db.query(
      `SELECT 1 FROM jz_resource_grants g
       WHERE g.resource_type=$1 AND g.resource_id=$2 AND g.level <> 'none'
         AND g.sub_id = ANY($5::text[])
         AND ( (g.target_type='user' AND g.target_id=$3)
            OR (g.target_type='role' AND g.target_id = ANY($4::text[]))
            OR (g.target_type='department' AND (
                 g.target_id = ANY($6::text[])
                 OR g.target_id IN (SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id=$3))) )
       LIMIT 1`,
      [t, id, p.userId, [...p.roleIds], subId ? ['', subId] : [''], [...p.departmentIds]],
    );
    return res.rows.length > 0;
  }

  /** principal 可见的资源 id 全集（单 SQL，列表过滤用） */
  async visibleIds(t: ResourceType, p: InvocationPrincipal): Promise<Set<string>> {
    if (!p.userId) return new Set();
    const res = await this.db.query(
      `SELECT DISTINCT g.resource_id FROM jz_resource_grants g
       WHERE g.resource_type=$1 AND g.level <> 'none'
         AND ( (g.target_type='user' AND g.target_id=$2)
            OR (g.target_type='role' AND g.target_id = ANY($3::text[]))
            OR (g.target_type='department' AND (
                 g.target_id = ANY($4::text[])
                 OR g.target_id IN (SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id=$2))) )`,
      [t, p.userId, [...p.roleIds], [...p.departmentIds]],
    );
    return new Set(res.rows.map(r => r.resource_id));
  }

  /**
   * principal 在某资源下可见的子项集合。
   * 返回 null = 持有 sub_id='' 的"全部"授权（调用方不过滤）；返回 Set = 仅这些子项可用。
   */
  async visibleSubIds(t: ResourceType, id: string, p: InvocationPrincipal): Promise<Set<string> | null> {
    if (!p.userId) return new Set();
    const res = await this.db.query(
      `SELECT DISTINCT g.sub_id FROM jz_resource_grants g
       WHERE g.resource_type=$1 AND g.resource_id=$2 AND g.level <> 'none'
         AND ( (g.target_type='user' AND g.target_id=$3)
            OR (g.target_type='role' AND g.target_id = ANY($4::text[]))
            OR (g.target_type='department' AND (
                 g.target_id = ANY($5::text[])
                 OR g.target_id IN (SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id=$3))) )`,
      [t, id, p.userId, [...p.roleIds], [...p.departmentIds]],
    );
    const subs = new Set<string>(res.rows.map(r => r.sub_id));
    if (subs.has('')) return null; // "全部"授权
    return subs;
  }

  private rowToGrant(r: any): ResourceGrant {
    return {
      resourceType: r.resource_type, resourceId: r.resource_id, subId: r.sub_id,
      targetType: r.target_type, targetId: r.target_id, level: r.level,
      grantedBy: r.granted_by ?? undefined,
    };
  }
}
