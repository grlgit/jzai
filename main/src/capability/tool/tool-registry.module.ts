import { Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { ToolRegistryController } from './tool-registry.controller';
import { AppCapabilityModule } from '../../platform/app-store/app-capability.module';

@Module({
  imports: [AppCapabilityModule],
  controllers: [ToolRegistryController],
  providers: [ToolRegistryService],
  exports: [ToolRegistryService],
})
export class ToolRegistryModule {}
