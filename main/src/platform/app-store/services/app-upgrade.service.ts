import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { AppManifestSchema, AppManifest } from '../validators/manifest.schema';
import { AppValidatorService } from '../validators/app-validator.service';
import { AppRegistryService } from './app-registry.service';
import { AppMigrationService } from './app-migration.service';
import { AppPoolService } from './app-pool.service';
import { AppActivationService } from './app-activation.service';
import { SafeArchiveService } from './safe-archive.service';
import { emitAppUpdated } from '../runtime/app-events';

@Injectable()
export class AppUpgradeService {
  private readonly logger = new Logger(AppUpgradeService.name);

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly archives: SafeArchiveService,
    private readonly validator: AppValidatorService,
    private readonly registry: AppRegistryService,
    private readonly migrations: AppMigrationService,
    private readonly pools: AppPoolService,
    private readonly activation: AppActivationService,
  ) {}

  async upgrade(appId: string, packagePath: string): Promise<void> {
    const existing = await this.registry.findOne(appId);
    if (!existing) throw new NotFoundException(`App ${appId} not found`);

    const extractDir = await this.extractToTemp(packagePath);
    try {
      // Validate new package without treating the currently installed release as another app.
      const ids = await this.registry.getExistingIds();
      ids.appIds.delete(appId);
      ids.shortNames.delete(existing.manifest.shortName);
      ids.nsPrefixes.delete(existing.manifest.nsPrefix);
      const currentSchema = existing.manifest.database?.schemaName;
      if (currentSchema) ids.schemaNames.delete(currentSchema);
      for (const panel of existing.manifest.panels ?? []) ids.panelIds.delete(panel.id);
      for (const provider of existing.manifest?.backend?.toolProviders ?? []) {
        for (const toolId of provider.toolIds ?? []) ids.toolIds.delete(toolId);
      }

      const report = await this.validator.validate(
        extractDir,
        ids.appIds,
        ids.shortNames,
        ids.nsPrefixes,
        ids.schemaNames,
        ids.panelIds,
        ids.toolIds,
      );

      if (!report.passed) {
        throw new BadRequestException(
          `Package validation failed: ${report.criticals.map(c => c.message).join('; ')}`,
        );
      }

      const manifest = AppManifestSchema.parse(
        JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf-8')),
      );

      if (manifest.appId !== appId) {
        throw new BadRequestException(`Cannot change appId during upgrade`);
      }

      // 版本目录 + active 指针（extract_dir）协议：
      // 新包写入独立的 versions/<version> 目录，旧目录全程不动；
      // 激活成功后 updateManifest 才切换指针。任何失败自动回滚旧版本。
      const oldDir = existing.installDir;
      const oldManifest = existing.manifest;
      const newDir = path.join(
        this.workspace.getRoot(), 'app-store', manifest.shortName, 'versions', manifest.version,
      );
      if (fs.existsSync(newDir)) {
        throw new BadRequestException(`Version directory already exists: ${manifest.version}`);
      }

      await this.registry.updateStatus(appId, 'upgrading');

      const migrationBaseline = await this.migrations.getCurrentVersion(appId);
      let migrated = false;

      try {
        // 1. Deactivate old backend (draining + onDeactivate) and remove old workspace artifacts
        await this.activation.deactivateApp(appId, 'upgrade');
        await this.activation.removePanels(appId);
        if (existing.manifest) {
          this.activation.removeAgents(existing.manifest);
          this.activation.removeSkills(existing.manifest);
        }

        // 2. Stage new version into its own immutable directory
        fs.mkdirSync(newDir, { recursive: true });
        fs.cpSync(extractDir, newDir, { recursive: true });

        // 3. Run incremental migrations（三态 journal，可重试不重复）
        if (manifest.database && this.pools.hasPool(appId)) {
          const plan = await this.migrations.plan(appId, manifest, newDir);
          if (plan.toRun.length > 0) {
            await this.migrations.up(appId, plan, newDir);
            migrated = true;
          }
        }

        // 4. Register new panels, agents, skills and load new backend
        await this.activation.activateApp(appId, newDir, manifest);

        // 5. 全部成功后最后切换 active 指针
        await this.registry.updateManifest(appId, manifest, newDir);
        await this.registry.updateStatus(appId, 'active');
        emitAppUpdated(appId, manifest.version);

        // 6. 清理旧版本目录（尽力而为，失败不影响升级结果）
        if (oldDir && oldDir !== newDir && fs.existsSync(oldDir)) {
          try {
            fs.rmSync(oldDir, { recursive: true, force: true });
          } catch (cleanupErr: any) {
            this.logger.warn(`Failed to remove old version directory ${oldDir}: ${cleanupErr.message}`);
          }
        }
        this.logger.log(`App ${appId} upgraded to ${manifest.version}`);
      } catch (err: any) {
        this.logger.error(`Upgrade of ${appId} failed, rolling back: ${err.message}`);
        await this.rollbackUpgrade(appId, oldDir, oldManifest, manifest, newDir, migrationBaseline, migrated);
        throw err;
      }
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  /**
   * 升级失败回滚：迁移回放到基线 → 删除新版本目录 → 重新激活旧版本。
   * 旧版本的 registry 指针（manifest/extract_dir）从未切换，无需恢复 DB 行。
   */
  private async rollbackUpgrade(
    appId: string,
    oldDir: string | undefined,
    oldManifest: AppManifest | undefined,
    newManifest: AppManifest,
    newDir: string,
    migrationBaseline: number,
    migrated: boolean,
  ): Promise<void> {
    try {
      if (migrated) {
        try {
          await this.migrations.down(appId, migrationBaseline, newManifest, newDir);
        } catch (downErr: any) {
          this.logger.error(`Migration rollback failed for ${appId}: ${downErr.message}`);
        }
      }
      fs.rmSync(newDir, { recursive: true, force: true });

      if (oldDir && oldManifest && fs.existsSync(oldDir)) {
        await this.activation.activateApp(appId, oldDir, oldManifest);
        await this.registry.updateStatus(appId, 'active');
        this.logger.log(`Rolled back ${appId} to previous version ${oldManifest.version}`);
      } else {
        await this.registry.updateStatus(appId, 'failed');
      }
    } catch (rollbackErr: any) {
      this.logger.error(`Rollback of ${appId} failed: ${rollbackErr.message}`);
      await this.registry.updateStatus(appId, 'failed');
    }
  }

  private async extractToTemp(packagePath: string): Promise<string> {
    const tempDir = path.join(
      os.tmpdir(),
      `jzapp_upgrade_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    );
    await this.archives.extract(packagePath, tempDir);
    return tempDir;
  }
}
