import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { WorkspaceModule } from '../../workspace/workspace.module';
import { SkillModule } from '../../capability/skill/skill.module';
import { AppCapabilityModule } from './app-capability.module';
import { AppRegistryService } from './services/app-registry.service';
import { AppSchemaService } from './services/app-schema.service';
import { AppPoolService } from './services/app-pool.service';
import { AppMigrationService } from './services/app-migration.service';
import { AppInstallService } from './services/app-install.service';
import { AppUninstallService } from './services/app-uninstall.service';
import { AppUpgradeService } from './services/app-upgrade.service';
import { AppGrantService } from './services/app-grant.service';
import { AppAssetService } from './services/app-asset.service';
import { AppAuditService } from './services/app-audit.service';
import { AppCredentialService } from './services/app-credential.service';
import { AppStagingService } from './services/app-staging.service';
import { AppInstallOperationService } from './services/app-install-operation.service';
import { AppLogService } from './services/app-log.service';
import { AppPlatformService } from './services/app-platform.service';
import { DevMcpService } from './services/dev-mcp.service';
import { DevMcpController } from './dev-mcp.controller';
import { AppInstanceService } from './services/app-instance.service';
import { AppValidatorService } from './validators/app-validator.service';
import { AppActivationService } from './services/app-activation.service';
import { IsolationService } from './runtime/isolation.service';
import { DynamicModuleLoader } from './runtime/dynamic-module.loader';
import { AppStoreController } from './app-store.controller';

@Module({
  imports: [DbModule, WorkspaceModule, SkillModule, AppCapabilityModule],
  controllers: [AppStoreController, DevMcpController],
  providers: [
    AppRegistryService,
    AppSchemaService,
    AppPoolService,
    AppMigrationService,
    AppValidatorService,
    AppInstallService,
    AppUninstallService,
    AppUpgradeService,
    AppGrantService,
    AppAssetService,
    AppAuditService,
    AppCredentialService,
    AppInstallOperationService,
    AppStagingService,
    AppInstanceService,
    AppActivationService,
    IsolationService,
    DynamicModuleLoader,
    AppLogService,
    AppPlatformService,
    DevMcpService,
  ],
  exports: [
    AppCapabilityModule,
    AppRegistryService,
    AppPoolService,
    AppInstanceService,
    AppGrantService,
    AppCredentialService,
    IsolationService,
    DynamicModuleLoader,
    AppActivationService,
    AppLogService,
    AppPlatformService,
  ],
})
export class AppStoreModule {}
