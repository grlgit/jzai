/**
 * MCP Streamable HTTP 服务 — 对译 mcp/local_server.py 的 --http 模式。
 * stateless（每请求新 transport，对齐 FastMCP stateless_http=True）+
 * enableJsonResponse（对齐 json_response=True）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import Fastify, { FastifyInstance } from 'fastify';
import { ToolContext, registerTools } from './tools';

export interface McpHttpOptions extends ToolContext {
  name?: string;
  version?: string;
}

export async function buildMcpServer(opts: McpHttpOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

  app.get('/health', async () => ({ status: 'ok' }));

  // stateless：每请求创建新的 McpServer + transport（对齐 FastMCP stateless_http）
  const handleMcp = async (req: any, reply: any) => {
    reply.hijack();
    try {
      const server = new McpServer({
        name: opts.name || 'jianzhi-kb',
        version: opts.version || '0.1.0',
      });
      registerTools(server, opts);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
        enableJsonResponse: true, // 对齐 FastMCP json_response=True
      });
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);

      reply.raw.on('close', () => {
        transport.close().catch(() => {});
        server.close().catch(() => {});
      });
    } catch (err: any) {
      req.log.error(err, 'MCP request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'Content-Type': 'application/json' });
        reply.raw.end(JSON.stringify({ error: 'MCP internal error' }));
      }
    }
  };

  app.route({ method: ['GET', 'POST', 'DELETE'], url: '/mcp', handler: handleMcp });

  return app;
}
