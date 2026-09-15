import { Module } from '@nestjs/common';
import { McpToolsService } from './mcp-tools.service';

@Module({
  providers: [McpToolsService],
  exports: [McpToolsService],
})
export class McpToolsModule {}
