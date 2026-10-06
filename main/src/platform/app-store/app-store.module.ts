import { Module } from '@nestjs/common';
import { DbModule } from '../../db/db.module';
import { WorkspaceModule } from '../../workspace/workspace.module';
import { SkillModule } from '../../capability/skill/skill.module';
import { McpRegistryModule } from '../../capability/mcp/mcp-registry.module';
import { KnowledgeModule } from '../../knowledge/knowledge.module';
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
import { AppLicenseService } from './services/app-license.service';
import { PackageSignatureService } from './services/package-signature.service';
import { BuiltinAppSeedService } from './services/builtin-app-seed.service';
import { SafeArchiveService } from './services/safe-archive.service';
import { AppInstallOperationService } from './services/app-install-operation.service';
import { AppLogService } from './services/app-log.service';
import { AppPlatformService } from './services/app-platform.service';
import { AppConnectionBindingService } from './services/app-connection-binding.service';
import { AppServicePrincipalService } from './services/app-service-principal.service';
import { DevMcpService } from './services/dev-mcp.service';
import { DevMcpController } from './dev-mcp.controller';
import { AppInstanceService } from './services/app-instance.service';
import { AppValidatorService } from './validators/app-validator.service';
import { AppActivationService } from './services/app-activation.service';
import { IsolationService } from './runtime/isolation.service';
import { DynamicModuleLoader } from './runtime/dynamic-module.loader';
import { CompanionServiceManager } from './runtime/companion-service.manager';
import { InvocationContextFactory } from './runtime/invocation-context.factory';
import { AppStoreController } from './app-store.controller';
import { AppKbProxyController } from './app-kb-proxy.controller';
import { AppConnectionBindingController } from './app-connection-binding.controller';
import { AppServicePrincipalController } from './app-service-principal.controller';

@Module({
  imports: [DbModule, WorkspaceModule, SkillModule, McpRegistryModule, AppCapabilityModule, KnowledgeModule],
  controllers: [
    AppStoreController,
    AppKbProxyController,
    AppConnectionBindingController,
    AppServicePrincipalController,
    DevMcpController,
  ],
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
    SafeArchiveService,
    AppStagingService,
    AppLicenseService,
    PackageSignatureService,
    BuiltinAppSeedService,
    AppInstanceService,
    AppActivationService,
    IsolationService,
    DynamicModuleLoader,
    CompanionServiceManager,
    InvocationContextFactory,
    AppLogService,
    AppPlatformService,
    AppServicePrincipalService,
    AppConnectionBindingService,
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
    CompanionServiceManager,
    AppActivationService,
    AppLogService,
    AppPlatformService,
    AppConnectionBindingService,
    AppLicenseService,
    PackageSignatureService,
  ],
})
export class AppStoreModule {}
