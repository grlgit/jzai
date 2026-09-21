import { Module } from '@nestjs/common';
import { McpRegistryService } from './mcp-registry.service';
import { McpRegistryController } from './mcp-registry.controller';
import { McpRunnerService } from './mcp-runner.service';
import { DbModule } from '../../db/db.module';
import { SkillModule } from '../skill/skill.module';
import { UserModule } from '../../user/user.module';

@Module({
  imports: [DbModule, SkillModule, UserModule],
  controllers: [McpRegistryController],
  providers: [McpRegistryService, McpRunnerService],
  exports: [McpRegistryService, McpRunnerService],
})
export class McpRegistryModule {}
