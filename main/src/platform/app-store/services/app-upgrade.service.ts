import { Injectable, Logger, BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import extractZip from 'extract-zip';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { AppManifestSchema } from '../validators/manifest.schema';
import { AppValidatorService } from '../validators/app-validator.service';
import { AppRegistryService } from './app-registry.service';
import { AppMigrationService } from './app-migration.service';
import { AppPoolService } from './app-pool.service';
import { AppActivationService } from './app-activation.service';
import { emitAppUpdated } from '../runtime/app-events';

@Injectable()
export class AppUpgradeService {
  private readonly logger = new Logger(AppUpgradeService.name);

  constructor(
    private readonly workspace: WorkspaceService,
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
      // Validate new package (allow same appId, skip uniqueness for this app's own ids)
      const ids = await this.registry.getExistingIds();
      // Remove current app's ids from uniqueness sets so it doesn't conflict with itself
      ids.appIds.delete(appId);
      ids.shortNames.delete(existing.manifest?.shortName);
      ids.nsPrefixes.delete(existing.manifest?.nsPrefix);

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

      await this.registry.updateStatus(appId, 'upgrading');

      try {
        // 1. Deactivate old backend and remove old workspace artifacts
        this.activation.deactivateApp(appId);
        await this.activation.removePanels(appId);
        if (existing.manifest) {
          this.activation.removeAgents(existing.manifest);
          this.activation.removeSkills(existing.manifest);
        }

        // 2. Swap install directory
        const installDir = path.join(this.workspace.getRoot(), 'app-store', manifest.shortName);
        fs.mkdirSync(installDir, { recursive: true });
        fs.cpSync(extractDir, installDir, { recursive: true });

        // 3. Run incremental migrations
        if (manifest.database && this.pools.hasPool(appId)) {
          const plan = await this.migrations.plan(appId, manifest, installDir);
          if (plan.toRun.length > 0) {
            await this.migrations.up(appId, plan, installDir);
          }
        }

        await this.registry.updateManifest(appId, manifest, installDir);

        // 4. Register new panels, agents, skills and reload backend
        await this.activation.activateApp(appId, installDir, manifest);

        await this.registry.updateStatus(appId, 'active');
        emitAppUpdated(appId, manifest.version);
        this.logger.log(`App ${appId} upgraded to ${manifest.version}`);
      } catch (err) {
        await this.registry.updateStatus(appId, 'failed');
        throw err;
      }
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  private async extractToTemp(packagePath: string): Promise<string> {
    const tempDir = path.join(
      os.tmpdir(),
      `jzapp_upgrade_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    );
    fs.mkdirSync(tempDir, { recursive: true });
    await extractZip(packagePath, { dir: tempDir });
    return tempDir;
  }
}
