import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { AppRegistryService } from './app-registry.service';
import { AppSchemaService } from './app-schema.service';
import { AppMigrationService } from './app-migration.service';
import { AppPoolService } from './app-pool.service';
import { AppActivationService } from './app-activation.service';
import { AppCapabilityService } from './app-capability.service';
import { AppCredentialService } from './app-credential.service';

@Injectable()
export class AppUninstallService {
  private readonly logger = new Logger(AppUninstallService.name);

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly registry: AppRegistryService,
    private readonly schema: AppSchemaService,
    private readonly migrations: AppMigrationService,
    private readonly pools: AppPoolService,
    private readonly activation: AppActivationService,
    private readonly capabilities: AppCapabilityService,
    private readonly credentials: AppCredentialService,
  ) {}

  async uninstall(appId: string, opts: { purgeData?: boolean } = {}): Promise<void> {
    const record = await this.registry.findOne(appId);
    if (!record) throw new NotFoundException(`App ${appId} not found`);

    await this.registry.updateStatus(appId, 'uninstalling');

    try {
      // 1. Deactivate backend and unregister tools
      await this.activation.deactivateApp(appId, 'uninstall');

      // 2. Remove panels and configuration artifacts
      await this.activation.removePanels(appId);
      const artifactWarnings = record.manifest
        ? [
          ...this.activation.removeAgents(record.manifest),
          ...this.activation.removeSkills(record.manifest),
        ]
        : [];
      this.activation.reloadRegistries();

      // 2.5 Remove capability origin mapping (badges disappear regardless of purge)
      await this.capabilities.removeForApp(appId);

      // 3. Destroy connection pool first (no new queries after this)
      if (this.pools.hasPool(appId)) {
        await this.pools.destroyPool(appId);
      }

      // 4. Optionally roll back all migrations (purge app DB objects)
      if (opts.purgeData && record.manifest?.database) {
        try {
          await this.migrations.dropAll(appId);
        } catch (err) {
          this.logger.warn(`Failed to drop migrations for ${appId}: ${err.message}`);
        }
        try {
          await this.schema.dropSchemaAndRole(record.manifest);
        } catch (err) {
          this.logger.warn(`Failed to drop schema for ${appId}: ${err.message}`);
        }
      }

      // 5. Delete install directory
      if (record.installDir && fs.existsSync(record.installDir)) {
        fs.rmSync(record.installDir, { recursive: true, force: true });
      }

      // 6. Preserve recovery metadata unless all app data was explicitly purged
      if (opts.purgeData) {
        // 彻底删除：连同 credential store 中的 APP secret 一并清除
        await this.credentials.deleteAllSecrets(appId);
        await this.registry.delete(appId);
      } else {
        await this.registry.updateStatus(appId, 'uninstalled');
      }
      if (artifactWarnings.length > 0) {
        this.logger.warn(`App ${appId} uninstalled with ${artifactWarnings.length} configuration artifact(s) remaining: ${artifactWarnings.join('; ')}`);
      } else {
        this.logger.log(`App ${appId} uninstalled`);
      }
    } catch (err) {
      await this.registry.updateStatus(appId, 'failed');
      throw err;
    }
  }
}
