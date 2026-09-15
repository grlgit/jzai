import { Module } from '@nestjs/common';
import { ModelRouterModule } from '../model-router/model-router.module';
import { McpToolsModule } from '../bridge/knowledge/mcp-tools.module';
import { AnalyticsModule } from '../platform/analytics/analytics.module';
import { AutomationModule } from '../capability/automation/automation.module';
import { UserModule } from '../user/user.module';
import { SkillModule } from '../capability/skill/skill.module';
import { ConnectorModule } from '../capability/connector/connector.module';
import { OcrModule } from '../data/media/ocr.module';
import { KbModule } from '../bridge/knowledge/kb.module';
import { EditionModule } from '../edition/edition.module';
import { DashboardModule } from '../data/dashboard/dashboard.module';
import { OemModule } from '../platform/oem/oem.module';
import { EmailModule } from '../platform/email/email.module';
import { ChatSupportModule } from './support/chat-support.module';
import { CapabilityModule } from '../capability/capability.module';
import { DataModule } from '../data/data.module';
import { BridgeModule } from '../bridge/bridge.module';
import { AppStoreModule } from '../platform/app-store/app-store.module';

// Core agent services
import { ChatGateway } from './core/agent.gateway';
import { ChatService } from './core/agent.service';
import { DynamicAgentService } from './core/dynamic-agent.service';
import { ToolBuilderService } from './core/tool-builder.service';
import { AgentRegistryController } from './core/agent-registry.controller';
import { SessionController } from './session/session.controller';

// Tool bridge
import { ToolBridgeService } from './tool-bridge/tool-bridge.service';
import { DynamicToolProviderRegistry } from './tool-bridge/dynamic-tool-provider.registry';
import { TOOL_PROVIDERS } from './tool-bridge/tool-provider.interface';
import { WebToolProvider } from '../capability/builtin/web.tools';
import { SystemToolProvider } from '../capability/builtin/system.tools';

// Context & prompt
import { ContextPrunerService } from './context/context-pruner.service';
import { ContextCompactorService } from './context/context-compactor.service';
import { PromptSynthesizerService } from './prompt/prompt-synthesizer.service';
import { PromptEnhancerService } from './prompt/prompt-enhancer.service';
import { PromptEnhancerLoaderService } from './prompt/prompt-enhancer.loader';
import { AgentDelegationRegistry } from './core/agent-delegation.registry';

// Domain tool providers (for TOOL_PROVIDERS factory)
import { SkillToolProvider } from '../capability/skill/skill.tools';
import { ToolAdapterService } from '../capability/tool/tool-adapter.service';
import { McpAdapterService } from '../capability/mcp/mcp-adapter.service';
import { ConnectorToolProvider } from '../capability/connector/connector.tools';
import { MediaToolProvider } from '../data/media/media.tools';
import { DatabaseToolProvider } from '../data/database/database.tools';
import { DashboardToolProvider } from '../data/dashboard/dashboard.tools';
import { ExcelToolProvider } from '../data/excel/excel.tools';
import { PdfToolProvider } from '../data/pdf/pdf.tools';
import { KnowledgeToolProvider } from '../bridge/knowledge/knowledge.tools';
import { DistillToolProvider } from '../bridge/knowledge/distill/distill.tools';
import { EmailToolProvider } from '../platform/email/email.tools';
// Panel message registry
import { PanelMessageRegistry } from './panel/panel-message-registry.service';
import { PanelController } from './panel/panel.controller';

/**
 * AgentModule — the main module for the agent engine.
 * Replaces the old ChatModule. Imports all domain modules and
 * collects their ToolProviders into the TOOL_PROVIDERS token.
 */
@Module({
  imports: [
    // Platform infrastructure
    ModelRouterModule, McpToolsModule, AnalyticsModule, AutomationModule,
    UserModule, SkillModule, ConnectorModule, OcrModule, KbModule,
    EditionModule, DashboardModule, OemModule, EmailModule,
    // Shared support services
    ChatSupportModule,
    // Domain modules
    CapabilityModule, DataModule, BridgeModule,
    // AppStore integration (for app tool grants)
    AppStoreModule,
  ],
  controllers: [AgentRegistryController, SessionController, PanelController],
  providers: [
    // Core agent services
    ChatGateway, ChatService, DynamicAgentService, ToolBuilderService,
    // Tool bridge
    ToolBridgeService, DynamicToolProviderRegistry,
    // Tool providers (agent's own)
    WebToolProvider, SystemToolProvider,
    // Context & prompt services
    PromptEnhancerService, PromptEnhancerLoaderService, AgentDelegationRegistry,
    // Collect ALL ToolProviders into single array
    {
      provide: TOOL_PROVIDERS,
      useFactory: (...providers: any[]) => providers,
      inject: [
        WebToolProvider, SystemToolProvider,
        SkillToolProvider, ToolAdapterService, McpAdapterService, ConnectorToolProvider,
        MediaToolProvider, DatabaseToolProvider, DashboardToolProvider, ExcelToolProvider, PdfToolProvider,
        KnowledgeToolProvider, DistillToolProvider, EmailToolProvider,
      ],
    },
    // Context & prompt
    ContextPrunerService, ContextCompactorService, PromptSynthesizerService,
    // Panel message registry
    PanelMessageRegistry,
  ],
  exports: [
    ChatService, ChatSupportModule,
    ToolBridgeService, DynamicToolProviderRegistry, ContextPrunerService, ContextCompactorService, PromptSynthesizerService,
    PanelMessageRegistry,
  ],
})
export class AgentModule {}
