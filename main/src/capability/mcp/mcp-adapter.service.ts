import { Injectable, Logger } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { CredentialService } from '../skill/credential.service';

/**
 * McpAdapterService — dynamically creates mcp_* prefixed tools from the MCP registry.
 * Each enabled MCP Server with handlerCode exposes its tools as invocable agent tools.
 */
@Injectable()
export class McpAdapterService implements ToolProvider {
  readonly toolIds = ['mcp'];
  private readonly logger = new Logger(McpAdapterService.name);

  constructor(
    private readonly mcpRegistry: McpRegistryService,
    private readonly credentialService: CredentialService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [{ id: 'mcp', label: 'MCP Connectors', group: '连接' }];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const allTools: ToolInstance[] = [];
    const userId = ctx.userId;

    for (const m of this.mcpRegistry.getEnabled()) {
      // Skip MCPs still being built (no tools or no handler)
      if (m.tools.length === 0 || !m.handlerCode) continue;

      const authSystem = m.authSystem || m.system || m.name;
      const needsAuth = m.authFields && m.authFields.length > 0;

      for (const t of m.tools) {
        const paramProps: Record<string, any> = {};
        if (t.inputSchema?.properties) {
          for (const [k, def] of Object.entries(t.inputSchema.properties as Record<string, any>)) {
            const propType = def?.type;
            const baseType = propType === 'object' ? Type.Any()
              : propType === 'array' ? Type.Any()
              : propType === 'number' ? Type.Number()
              : propType === 'boolean' ? Type.Boolean()
              : Type.String();
            paramProps[k] = (t.inputSchema.required || []).includes(k) ? baseType : Type.Optional(baseType);
          }
        }
        allTools.push({
          name: `mcp_${m.name}_${t.name}`, label: `${m.name}: ${t.description}`,
          description: m.llmHint ? `${t.description}\n\n## 调用说明\n${m.llmHint}` : t.description,
          parameters: Type.Object(paramProps) as any,
          execute: async (_id: string, args: Record<string, any>) => {
            // Auto-parse string args that should be objects/arrays (LLM may serialize JSON as string)
            if (t.inputSchema?.properties) {
              for (const [k, def] of Object.entries(t.inputSchema.properties as Record<string, any>)) {
                if ((def.type === 'object' || def.type === 'array') && typeof args[k] === 'string') {
                  try { args[k] = JSON.parse(args[k]); } catch {}
                }
              }
            }
            // Read credentials at execution time — resolve with scope (global fallback)
            let userCredentials = this.credentialService.resolveCredentials(userId || '', authSystem, m.authScope);
            // Fallback: try db- prefixed name (save_db_connection stores as db-{name})
            if ((!userCredentials || Object.keys(userCredentials).length === 0) && !authSystem.startsWith('db-')) {
              userCredentials = this.credentialService.resolveCredentials(userId || '', `db-${authSystem}`, m.authScope);
            }
            const authMissing = needsAuth && (!userCredentials || Object.keys(userCredentials).length === 0);

            if (authMissing) {
              const fieldNames = m.authFields!.map(f => f.label || f.key).join('、');
              return { content: [{ type: 'text' as const, text: `[凭证缺失] MCP "${m.name}" 需要凭证（${fieldNames}）但当前用户未配置。请直接告知用户：需要在侧边栏"连接"面板中选择该连接，切换到"凭证"选项卡配置。不要尝试导航或打开其他页面。` }], details: null };
            }
            try {
              let code = m.handlerCode!.replace(/import\s+.*?from\s+.*?;?\n?/g, '').replace(/export\s+/g, '').replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ');
              const fn = new Function('require', 'ctx', `return (async function() { ${code} return execute(ctx); })();`);
              const { McpHttpClient } = require('./mcp-http-client');
              const httpClient = new McpHttpClient(userId);
              const handlerCtx = { params: args, tool: t.name, toolName: t.name, userId, credentials: userCredentials || {}, http: httpClient };
              const result = await fn(require, handlerCtx);
              const resultText = (result.data && result.message) ? `${result.message}\n${JSON.stringify(result.data, null, 2)}` : (result.message || JSON.stringify(result));
              this.logger.debug(`MCP ${m.name}/${t.name} result: ${resultText.substring(0, 200)}`);
              // If MCP handler returned failure, add guardrail instruction
              if (result.success === false || resultText.includes('失败') || resultText.includes('failed') || resultText.includes('error')) {
                return { content: [{ type: 'text' as const, text: `${resultText}` }], details: null };
              }
              return { content: [{ type: 'text' as const, text: resultText }], details: null };
            } catch (err: any) {
              this.logger.warn(`MCP ${m.name}/${t.name} error: ${err.message}`);
              return { content: [{ type: 'text' as const, text: `MCP工具执行失败: ${err.message}` }], details: null };
            }
          },
        });
      }
    }
    return allTools;
  }
}
