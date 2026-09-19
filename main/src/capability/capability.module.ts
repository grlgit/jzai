import { Module } from '@nestjs/common';
import { SkillModule } from './skill/skill.module';
import { ToolRegistryModule } from './tool/tool-registry.module';
import { McpRegistryModule } from './mcp/mcp-registry.module';
import { ChatSupportModule } from '../agent/support/chat-support.module';
import { SkillToolProvider } from './skill/skill.tools';
import { ToolAdapterService } from './tool/tool-adapter.service';
import { McpAdapterService } from './mcp/mcp-adapter.service';
import { ConnectorToolProvider } from './connector/connector.tools';


/**
 * CapabilityModule — Domain 2: Extensibility (Skill / Tool / MCP / Connector).
 * Provides ToolProviders for the agent tool bridge.
 */
@Module({
  imports: [SkillModule, ToolRegistryModule, McpRegistryModule, ChatSupportModule],
  providers: [
    SkillToolProvider,
    ToolAdapterService,
    McpAdapterService,
    ConnectorToolProvider,
  ],
  exports: [
    SkillToolProvider,
    ToolAdapterService,
    McpAdapterService,
    ConnectorToolProvider,
    McpRegistryModule,
  ],
})
export class CapabilityModule {}
