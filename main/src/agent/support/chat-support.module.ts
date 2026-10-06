import { Module } from '@nestjs/common';
import { AgentPoolService } from '../core/agent-pool.service';
import { SessionService } from '../session/session.service';
import { ConfirmationBridgeService } from './confirmation-bridge.service';
import { ContextManagerService } from '../context/context-manager.service';
import { AgentRegistryService } from '../core/agent-registry.service';
import { DbModule } from '../../db/db.module';
import { UserModule } from '../../user/user.module';
import { ModelRouterModule } from '../../model-router/model-router.module';
import { WorkspaceModule } from '../../workspace/workspace.module';
import { KnowledgeModule } from '../../knowledge/knowledge.module';

/**
 * ChatSupportModule — exports shared support services that other domains need.
 * Extracted to break circular dependency: capability/ needs AgentPool+Session+ConfirmBridge,
 * but ChatModule imports CapabilityModule.
 */
@Module({
  imports: [DbModule, UserModule, ModelRouterModule, WorkspaceModule, KnowledgeModule],
  providers: [AgentPoolService, SessionService, ConfirmationBridgeService, ContextManagerService, AgentRegistryService],
  exports: [AgentPoolService, SessionService, ConfirmationBridgeService, ContextManagerService, AgentRegistryService],
})
export class ChatSupportModule {}
