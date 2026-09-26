/**
 * MCP 工具注册入口（对译 mcp/tools/__init__.py::register）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Db } from '../../shared/db';
import { LOCAL_USER_ID } from '../../shared/scopes';
import { PgLocalVaultFS } from '../vaultfs/pg-local';
import { registerGuide } from './guide';
import { registerSearch } from './search';
import { registerRead } from './read';
import { registerWrite } from './write';
import { registerDelete } from './delete';
import { registerQuery } from './query';

export interface ToolContext {
  db: Db;
  workspace: string;
  appUrl: string;
  wikiLanguage: string;
}

export function createVaultFS(ctx: ToolContext, userId: string = LOCAL_USER_ID): PgLocalVaultFS {
  return new PgLocalVaultFS(ctx.db, ctx.workspace, userId);
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerGuide(server, ctx);
  registerSearch(server, ctx);
  registerRead(server, ctx);
  registerWrite(server, ctx);
  registerDelete(server, ctx);
  registerQuery(server, ctx);

  // 对齐 Python local_server 的 ping 工具
  server.registerTool(
    'ping',
    { description: 'Check if the KB MCP server is alive.', inputSchema: {} },
    async () => ({ content: [{ type: 'text' as const, text: 'pong' }] }),
  );
}
