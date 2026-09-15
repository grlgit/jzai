import { Module } from '@nestjs/common';
import { SkillsController } from './connector.controller';
import { SkillModule } from '../skill/skill.module';
import { ToolRegistryModule } from '../tool/tool-registry.module';
import { McpRegistryModule } from '../mcp/mcp-registry.module';

@Module({
  imports: [SkillModule, ToolRegistryModule, McpRegistryModule],
  controllers: [SkillsController],
  exports: [ToolRegistryModule, McpRegistryModule],
})
export class ConnectorModule {}
