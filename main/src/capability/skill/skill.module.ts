import { Module } from '@nestjs/common';
import { SkillRegistryService } from './skill-registry.service';
import { SkillDiscoveryService } from './skill-discovery.service';
import { SkillExecutorService } from './skill-executor.service';
import { HarAnalyzerService } from './har-analyzer.service';
import { SkillGeneratorService } from './skill-generator.service';
import { CredentialService } from './credential.service';
import { SkillController } from './skill.controller';
import { ModelRouterModule } from '../../model-router/model-router.module';
import { UserModule } from '../../user/user.module';
import { AppCapabilityModule } from '../../platform/app-store/app-capability.module';

@Module({
  imports: [ModelRouterModule, UserModule, AppCapabilityModule],
  controllers: [SkillController],
  providers: [
    SkillRegistryService, SkillDiscoveryService, SkillExecutorService,
    HarAnalyzerService, SkillGeneratorService, CredentialService,
  ],
  exports: [SkillRegistryService, SkillExecutorService, CredentialService, HarAnalyzerService],
})
export class SkillModule {}
