import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import { DbService } from '../../../db/db.service';
import { AppManifest } from '../validators/manifest.schema';
import { AppPoolService } from './app-pool.service';
import { Pool as PgPool } from 'pg';

export interface MigrationRecord {
  version: number;
  checksum: string;
  appliedAt: Date;
}

export interface MigrationPlan {
  toRun: Array<{ version: number; file: string; checksum: string }>;
  irreversibleVersions: number[];
}

/**
 * Manages per-app database migrations.
 * Runs each migration using the app's own connection (role-restricted),
 * so schema isolation is enforced by PostgreSQL, not by text analysis.
 */
@Injectable()
export class AppMigrationService {
  private readonly logger = new Logger(AppMigrationService.name);

  constructor(
    private readonly db: DbService,
    private readonly poolService: AppPoolService,
  ) {}

  /** Compute delta between already-applied migrations and the manifest */
  async plan(appId: string, manifest: AppManifest, extractDir: string): Promise<MigrationPlan> {
    const entries = manifest.migrations ?? [];
    if (entries.length === 0) return { toRun: [], irreversibleVersions: [] };

    const applied = await this.getApplied(appId);
    const appliedMap = new Map(applied.map(r => [r.version, r.checksum]));

    const toRun: MigrationPlan['toRun'] = [];
    const irreversibleVersions: number[] = [];

    for (const entry of entries) {
      const filePath = path.join(extractDir, entry.file);
      const checksum = this.hashFile(filePath);

      if (appliedMap.has(entry.version)) {
        // Verify checksum of already-applied migrations
        if (appliedMap.get(entry.version) !== checksum) {
          throw new Error(
            `Checksum mismatch for migration version ${entry.version} of app "${appId}". ` +
            `The migration file has been modified after it was applied. This is not allowed.`,
          );
        }
        continue; // already applied
      }

      toRun.push({ version: entry.version, file: entry.file, checksum });
      if (!entry.down) {
        irreversibleVersions.push(entry.version);
      }
    }

    return { toRun, irreversibleVersions };
  }

  /**
   * Execute pending migrations. 状态协议（PLAT-009）：
   * 1. 平台连接先写 journal 行 status='applying'；
   * 2. APP 角色事务执行迁移 SQL；
   * 3. 平台连接置 status='applied'。
   * 进程在 1~3 之间中断会留下 'applying' 行；下次执行时对该版本重放 SQL
   * （迁移 SQL 必须幂等，如使用 IF NOT EXISTS）再置 applied。
   */
  async up(appId: string, plan: MigrationPlan, extractDir: string): Promise<void> {
    if (plan.toRun.length === 0) return;

    const interrupted = new Set(await this.getInterruptedVersions(appId));

    for (const entry of plan.toRun) {
      if (!interrupted.has(entry.version)) {
        await this.db.query(
          `INSERT INTO jz_app_migrations (app_id, version, checksum, status)
           VALUES ($1, $2, $3, 'applying')
           ON CONFLICT (app_id, version) DO NOTHING`,
          [appId, entry.version, entry.checksum],
        );
      } else {
        this.logger.warn(`App ${appId}: replaying interrupted migration v${entry.version} (requires idempotent SQL)`);
      }

      const filePath = path.join(extractDir, entry.file);
      const sql = fs.readFileSync(filePath, 'utf-8');
      await this.poolService.transaction(appId, async client => {
        await client.query(sql);
      });

      await this.db.query(
        `UPDATE jz_app_migrations SET status='applied', checksum=$3, applied_at=NOW()
         WHERE app_id=$1 AND version=$2`,
        [appId, entry.version, entry.checksum],
      );
      this.logger.log(`App ${appId}: applied migration v${entry.version}`);
    }
  }

  /** 当前已应用的最高迁移版本（升级回滚基线） */
  async getCurrentVersion(appId: string): Promise<number> {
    const applied = await this.getApplied(appId);
    return applied.reduce((max, r) => Math.max(max, r.version), 0);
  }

  /** Rollback migrations down to `toVersion` (exclusive) using declared down files */
  async down(appId: string, toVersion: number, manifest: AppManifest, extractDir: string): Promise<void> {
    const applied = await this.getApplied(appId);
    const toRollback = applied
      .filter(r => r.version > toVersion)
      .sort((a, b) => b.version - a.version); // reverse order

    const entries = manifest.migrations ?? [];

    // 逐个回滚：先执行 down SQL，再删 journal 行。
    // 进程在两者之间中断时 journal 行保留，重试会重放 down SQL（须幂等）。
    for (const record of toRollback) {
      const entry = entries.find(e => e.version === record.version);
      if (!entry?.down) {
        throw new Error(
          `Migration version ${record.version} of app "${appId}" has no down file declared. Cannot rollback.`,
        );
      }
      const downPath = path.join(extractDir, entry.down);
      const sql = fs.readFileSync(downPath, 'utf-8');
      await this.poolService.transaction(appId, async client => {
        await client.query(sql);
      });
      await this.db.query(
        `DELETE FROM jz_app_migrations WHERE app_id = $1 AND version = $2`,
        [appId, record.version],
      );
      this.logger.log(`App ${appId}: rolled back migration v${record.version}`);
    }
  }

  /** Drop all migration records for an app (called after schema drop) */
  async dropAll(appId: string): Promise<void> {
    await this.db.query(`DELETE FROM jz_app_migrations WHERE app_id = $1`, [appId]);
  }

  private async getApplied(appId: string): Promise<MigrationRecord[]> {
    const { rows } = await this.db.query(
      `SELECT version, checksum, applied_at as "appliedAt" FROM jz_app_migrations
       WHERE app_id = $1 AND status = 'applied' ORDER BY version`,
      [appId],
    );
    return rows;
  }

  private async getInterruptedVersions(appId: string): Promise<number[]> {
    const { rows } = await this.db.query(
      `SELECT version FROM jz_app_migrations WHERE app_id = $1 AND status = 'applying'`,
      [appId],
    );
    return rows.map((r: { version: number }) => r.version);
  }

  private hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }
}
