import { Module } from '@nestjs/common';
import { KbModule } from './knowledge/kb.module';
import { McpToolsModule } from './knowledge/mcp-tools.module';
import { SkillModule } from '../capability/skill/skill.module';
import { ModelRouterModule } from '../model-router/model-router.module';
import { UserModule } from '../user/user.module';
import { KnowledgeToolProvider } from './knowledge/knowledge.tools';
import { DistillService } from './knowledge/distill/distill.service';
import { DistillValidationService } from './knowledge/distill/distill-validation.service';
import { DistillToolProvider } from './knowledge/distill/distill.tools';
import { DistillController } from './knowledge/distill/distill.controller';
import { DistillGateway } from './knowledge/distill/distill.gateway';


/**
 * BridgeModule — Sub-product bridges (Knowledge/VaultFS, CoWorker).
 */
@Module({
  imports: [KbModule, McpToolsModule, SkillModule, ModelRouterModule, UserModule],
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
