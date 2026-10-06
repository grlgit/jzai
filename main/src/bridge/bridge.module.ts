import { Module } from '@nestjs/common';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { SkillModule } from '../capability/skill/skill.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { UserModule } from '../user/user.module';
import { KnowledgeToolProvider } from '../capability/builtin/knowledge-base.tools';
import { DistillService } from './knowledge/distill/distill.service';
import { DistillValidationService } from './knowledge/distill/distill-validation.service';
import { DistillToolProvider } from './knowledge/distill/distill.tools';
import { DistillController } from './knowledge/distill/distill.controller';
import { DistillGateway } from './knowledge/distill/distill.gateway';


/**
 * BridgeModule — Sub-product bridges (Knowledge/VaultFS, CoWorker).
 */
@Module({
  imports: [KnowledgeModule, SkillModule, ModelRouterModule, UserModule],
  controllers: [DistillController],
  providers: [
    KnowledgeToolProvider,
    DistillService,
    DistillValidationService,
    DistillToolProvider,
    DistillGateway,
  ],
  exports: [KnowledgeToolProvider, DistillToolProvider, DistillService],
})
export class BridgeModule {}
