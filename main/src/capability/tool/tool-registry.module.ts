import { Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { ToolRegistryController } from './tool-registry.controller';
import { AppCapabilityModule } from '../../platform/app-store/app-capability.module';
import { AuthzModule } from '../../platform/authz/authz.module';
import { AppStoreModule } from '../../platform/app-store/app-store.module';

@Module({
  imports: [AppCapabilityModule, AuthzModule, AppStoreModule],
  controllers: [ToolRegistryController],
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolRegistryModule {}
