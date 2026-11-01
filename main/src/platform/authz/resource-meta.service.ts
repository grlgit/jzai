import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { DbService } from '../../db/db.service';
import { WorkspaceService } from '../../workspace/workspace.service';

export type ResourceType = 'agent' | 'skill' | 'connector' | 'tool' | 'panel' | 'app';
export type ResourceScope = 'global' | 'user';

export interface ResourceMeta {
  resourceType: ResourceType;
  resourceId: string;
  scope: ResourceScope;
  ownerUserId?: string;
  sourceAppId?: string;
  builtin: boolean;
  /** 'all' = 全员可见（存量回填兜底）；'none' = 仅按 grants 判定 */
  defaultVisibility: 'none' | 'all';
  createdBy?: string;
}

/** 需求明确的全员可见例外：主智能体 */
export const ALWAYS_VISIBLE_AGENTS: readonly string[] = ['main'];

/**
 * 资源归属元数据（jz_resource_meta）。
 * 文件（YAML/SKILL.md/mcp manifest）仍是能力定义真源；本表只回答"谁的、全局还是用户类"。
 *
 * backfillOnBoot 直接扫描文件系统目录回填存量资源——刻意不依赖各能力注册表服务，
 * 保持 authz 模块零反向依赖（防循环依赖），且回填时机早于注册表加载也无妨（幂等 upsert）。
 */
@Injectable()
export class ResourceMetaService implements OnModuleInit {
  private readonly logger = new Logger(ResourceMetaService.name);

  constructor(
    private readonly db: DbService,
    private readonly workspace: WorkspaceService,
  ) {}

  async onModuleInit() {
    try {
      await this.backfillOnBoot();
    } catch (err: any) {
      // 回填失败不阻断启动：default_visibility 缺失时 ResourceAccessService 对 admin 仍放行，可事后补
      this.logger.error(`Resource meta backfill failed: ${err.message}`);
    }
  }

  async get(t: ResourceType, id: string): Promise<ResourceMeta | undefined> {
    const res = await this.db.query(
      `SELECT * FROM jz_resource_meta WHERE resource_type=$1 AND resource_id=$2`,
      [t, id],
    );
    return res.rows[0] ? this.rowToMeta(res.rows[0]) : undefined;
  }

  /** 批量读（列表过滤用，防 N+1） */
  async getMany(t: ResourceType, ids: string[]): Promise<Map<string, ResourceMeta>> {
    if (ids.length === 0) return new Map();
    const res = await this.db.query(
      `SELECT * FROM jz_resource_meta WHERE resource_type=$1 AND resource_id = ANY($2::text[])`,
      [t, ids],
    );
    const map = new Map<string, ResourceMeta>();
    for (const row of res.rows) map.set(row.resource_id, this.rowToMeta(row));
    return map;
  }

  async upsert(meta: ResourceMeta): Promise<void> {
    await this.db.query(
      `INSERT INTO jz_resource_meta
         (resource_type, resource_id, scope, owner_user_id, source_app_id, builtin, default_visibility, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (resource_type, resource_id) DO UPDATE SET
         scope=$3, owner_user_id=$4, source_app_id=$5, builtin=$6, default_visibility=$7, updated_at=NOW()`,
      [meta.resourceType, meta.resourceId, meta.scope, meta.ownerUserId ?? null,
       meta.sourceAppId ?? null, meta.builtin, meta.defaultVisibility, meta.createdBy ?? null],
    );
  }

  /** 新建时若已有 meta 则保留（回填与重复创建场景）；无则写入 */
  async ensure(meta: ResourceMeta): Promise<void> {
    await this.db.query(
      `INSERT INTO jz_resource_meta
         (resource_type, resource_id, scope, owner_user_id, source_app_id, builtin, default_visibility, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (resource_type, resource_id) DO NOTHING`,
      [meta.resourceType, meta.resourceId, meta.scope, meta.ownerUserId ?? null,
       meta.sourceAppId ?? null, meta.builtin, meta.defaultVisibility, meta.createdBy ?? null],
    );
  }

  /** 删除 meta 并连带清理该资源的全部授权 */
  async remove(t: ResourceType, id: string): Promise<void> {
    await this.db.transaction(async (client) => {
      await client.query(`DELETE FROM jz_resource_grants WHERE resource_type=$1 AND resource_id=$2`, [t, id]);
      await client.query(`DELETE FROM jz_resource_meta WHERE resource_type=$1 AND resource_id=$2`, [t, id]);
    });
  }

  async listByOwner(t: ResourceType, userId: string): Promise<ResourceMeta[]> {
    const res = await this.db.query(
      `SELECT * FROM jz_resource_meta WHERE resource_type=$1 AND owner_user_id=$2`,
      [t, userId],
    );
    return res.rows.map(r => this.rowToMeta(r));
  }

  /**
   * 存量文件系资源回填（幂等）。兼容性闸门：存量一律 default_visibility='all'，
   * 升级后可见性与升级前等价；有 permissions 的 connector 平移为 'none' + grants。
   */
  async backfillOnBoot(): Promise<void> {
    let count = 0;
    count += await this.backfillAgents();
    count += await this.backfillSkills();
    count += await this.backfillConnectors('mcp', 'connector');
    count += await this.backfillConnectors('tools', 'tool');
    if (count > 0) this.logger.log(`Resource meta backfilled: ${count} new entries`);
  }

  private async backfillAgents(): Promise<number> {
    const dir = this.workspace.getAgentsDir();
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(yaml|yml)$/.test(f) || f.startsWith('.')) continue;
      try {
        const def: any = yaml.load(fs.readFileSync(path.join(dir, f), 'utf-8'));
        if (!def?.id) continue;
        await this.ensure({
          resourceType: 'agent', resourceId: def.id, scope: 'global',
          builtin: def.builtin ?? false, defaultVisibility: 'all',
        });
        n++;
      } catch { /* 坏文件跳过，注册表加载时自会报 */ }
    }
    return n;
  }

  private async backfillSkills(): Promise<number> {
    const dir = path.join(this.workspace.getConfigDir(), 'skills');
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      if (!fs.existsSync(path.join(dir, d.name, 'SKILL.md'))) continue;
      await this.ensure({
        resourceType: 'skill', resourceId: d.name, scope: 'global',
        builtin: false, defaultVisibility: 'all',
      });
      n++;
    }
    return n;
  }

  /** mcp（connector）与 tools（tool）同构：{configDir}/{sub}/{dirName}/manifest|tool.yaml */
  private async backfillConnectors(sub: 'mcp' | 'tools', type: 'connector' | 'tool'): Promise<number> {
    const dir = path.join(this.workspace.getConfigDir(), sub);
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('.')) continue;
      const manifestPath = ['manifest.yaml', 'tool.yaml', 'manifest.yml']
        .map(f => path.join(dir, d.name, f)).find(p => fs.existsSync(p));
      if (!manifestPath) continue;
      try {
        const m: any = yaml.load(fs.readFileSync(manifestPath, 'utf-8'));
        const id = m?.name || d.name;
        const perms = m?.permissions || {};
        const hasAcl = (perms.allowedRoles?.length || 0) + (perms.allowedUsers?.length || 0) > 0;
        await this.ensure({
          resourceType: type, resourceId: id, scope: 'global',
          builtin: false, defaultVisibility: hasAcl ? 'none' : 'all',
        });
        // 平移既有 ACL 为 grants（仅首次回填时写入；ensure 的 DO NOTHING 保证已有 meta 不重复平移）
        if (hasAcl) {
          const fresh = await this.db.query(
            `SELECT 1 FROM jz_resource_grants WHERE resource_type=$1 AND resource_id=$2 LIMIT 1`, [type, id]);
          if (fresh.rows.length === 0) {
            for (const r of perms.allowedRoles || []) {
              await this.db.query(
                `INSERT INTO jz_resource_grants (resource_type, resource_id, sub_id, target_type, target_id, level, granted_by)
                 VALUES ($1,$2,'','role',$3,'user','backfill') ON CONFLICT DO NOTHING`, [type, id, r]);
            }
            for (const u of perms.allowedUsers || []) {
              await this.db.query(
                `INSERT INTO jz_resource_grants (resource_type, resource_id, sub_id, target_type, target_id, level, granted_by)
                 VALUES ($1,$2,'','user',$3,'user','backfill') ON CONFLICT DO NOTHING`, [type, id, u]);
            }
          }
        }
        n++;
      } catch { /* skip */ }
    }
    return n;
  }

  private rowToMeta(r: any): ResourceMeta {
    return {
      resourceType: r.resource_type, resourceId: r.resource_id,
      scope: r.scope, ownerUserId: r.owner_user_id ?? undefined,
      sourceAppId: r.source_app_id ?? undefined, builtin: r.builtin,
      defaultVisibility: r.default_visibility, createdBy: r.created_by ?? undefined,
    };
  }
}
