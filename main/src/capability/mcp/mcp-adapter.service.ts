import { Injectable, Logger } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { McpRunnerService } from '../mcp/mcp-runner.service';
import {
  normalizeInvocationPrincipal,
  principalHasScope,
  principalIsExpired,
} from '../../platform/app-store/runtime/invocation-principal';

/**
 * McpAdapterService — dynamically creates mcp_* prefixed tools from the MCP registry.
 * Each enabled MCP Server with handlerCode exposes its tools as invocable agent tools.
 * 执行体统一走 McpRunnerService（凭据解析/沙箱执行的唯一实现）。
 */
@Injectable()
export class McpAdapterService implements ToolProvider {
  readonly toolIds = ['mcp'];
  private readonly logger = new Logger(McpAdapterService.name);

  constructor(
    private readonly mcpRegistry: McpRegistryService,
    private readonly mcpRunner: McpRunnerService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [{ id: 'mcp', label: 'MCP Connectors', group: '连接' }];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const allTools: ToolInstance[] = [];
    const principal = ctx.principal ?? normalizeInvocationPrincipal(ctx.userId, 'legacy-mcp');
    const userId = principal?.userId;
    const roleIds = principal?.roleIds ?? [];

    for (const m of this.mcpRegistry.getEnabled()) {
      if (m.tools.length === 0 || !m.handlerCode) continue;

      for (const t of m.tools) {
        const hasBoundServiceCapability = principal?.type === 'service'
          && principalHasScope(principal, `mcp:${m.name}:${t.name}:invoke`);
        const canInvoke = () => hasBoundServiceCapability
          || this.mcpRegistry.isAllowedForUser(m.name, userId, roleIds);
        if (!canInvoke()) continue;
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
            if ((principal && principalIsExpired(principal)) || !canInvoke()) {
              return {
                content: [{ type: 'text' as const, text: `Forbidden: no access to MCP ${m.name}` }],
                details: { __error: { code: 'FORBIDDEN', message: `No access to MCP ${m.name}` } },
              };
            }
            // Auto-parse string args that should be objects/arrays (LLM may serialize JSON as string)
            if (t.inputSchema?.properties) {
              for (const [k, def] of Object.entries(t.inputSchema.properties as Record<string, any>)) {
                if ((def.type === 'object' || def.type === 'array') && typeof args[k] === 'string') {
                  try { args[k] = JSON.parse(args[k]); } catch {}
                }
              }
            }
            try {
              const result = await this.mcpRunner.run(m.name, { tool: t.name, params: args, userId, principal });
              const resultText = (result.data && result.message) ? `${result.message}\n${JSON.stringify(result.data, null, 2)}` : (result.message || JSON.stringify(result));
              this.logger.debug(`MCP ${m.name}/${t.name} result: ${resultText.substring(0, 200)}`);
              if (result.success === false) {
                return {
                  content: [{ type: 'text' as const, text: resultText }],
                  details: {
                    __error: {
                      code: result.code || 'MCP_HANDLER_ERROR',
                      message: result.message || 'MCP handler reported failure',
                    },
                  },
                };
              }
              return { content: [{ type: 'text' as const, text: resultText }], details: null };
            } catch (err: any) {
              if (err?.code === 'MCP_CREDENTIALS_MISSING') {
                const fieldNames = (m.authFields || []).map(f => f.label || f.key).join('、');
                return { content: [{ type: 'text' as const, text: `[凭证缺失] MCP "${m.name}" 需要凭证（${fieldNames}）但当前用户未配置。请直接告知用户：需要在侧边栏"连接"面板中选择该连接，切换到"凭证"选项卡配置。不要尝试导航或打开其他页面。` }], details: null };
              }
              this.logger.warn(`MCP ${m.name}/${t.name} error: ${err.message}`);
              return {
                content: [{ type: 'text' as const, text: `MCP工具执行失败: ${err.message}` }],
                details: {
                  __error: {
                    code: err?.code || 'MCP_EXECUTION_ERROR',
                    message: err.message,
                  },
                },
              };
            }
          },
        });
      }
    }
    return allTools;
  }
}
