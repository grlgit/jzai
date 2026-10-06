import { Module } from '@nestjs/common';
import { CoWorkerController } from './coworker.controller';
import { CoWorkerGateway } from './coworker.gateway';
import { CoWorkerService } from './coworker.service';
import { CoWorkerConfigService } from './coworker-config.service';
import { CoWorkerProxyService } from './coworker-proxy.service';
import { CoWorkerBuildService } from './coworker-build.service';
import { CoWorkerOpenClawService } from './coworker-openclaw.service';
import { CoWorkerAnalyticsService } from './coworker-analytics.service';
import { CoWorkerPostMeetingService } from './coworker-post-meeting.service';
import { CoWorkerAppService } from './coworker-app.service';
import { CoWorkerWinBuildService } from './coworker-win-build.service';
import { CoWorkerVerifyService } from './coworker-verify.service';
import { CoWorkerVerifyController } from './coworker-verify.controller';
import { CoWorkerCacheService } from './coworker-cache.service';
import { CoWorkerAuthGuard } from './coworker-auth.guard';
import { WorkflowTransactionService } from './workflow-transaction.service';
import { GatewayHealthService } from './gateway-health.service';
import { DbModule } from '../../db/db.module';
import { UserModule } from '../../user/user.module';
import { ModelRouterModule } from '../../model-router/model-router.module';
import { KnowledgeModule } from '../../knowledge/knowledge.module';
import { WorkspaceModule } from '../../workspace/workspace.module';
import { CacheModule } from '../../cache/cache.module';
import { EditionModule } from '../../edition/edition.module';
import { SkillModule } from '../../capability/skill/skill.module';
import { AgentModule } from '../../agent/agent.module';
import { McpRegistryModule } from '../../capability/mcp/mcp-registry.module';

@Module({
  imports: [DbModule, UserModule, ModelRouterModule, KnowledgeModule, WorkspaceModule, EditionModule, SkillModule, CacheModule, AgentModule, McpRegistryModule],
  controllers: [CoWorkerController, CoWorkerVerifyController],
  providers: [
    CoWorkerService, CoWorkerConfigService, CoWorkerProxyService, CoWorkerBuildService,
    CoWorkerOpenClawService, CoWorkerAnalyticsService, CoWorkerPostMeetingService,
    CoWorkerAppService, CoWorkerWinBuildService, CoWorkerGateway,
    CoWorkerVerifyService, CoWorkerCacheService, CoWorkerAuthGuard,
    WorkflowTransactionService, GatewayHealthService,
  ],
  exports: [CoWorkerService, CoWorkerConfigService, CoWorkerGateway],
})
export class CoWorkerModule {}
