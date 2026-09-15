import { Injectable, Logger } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { ToolRegistryService } from './tool-registry.service';
import { CredentialService } from '../skill/credential.service';
import { ConfirmationBridgeService } from '../../agent/support/confirmation-bridge.service';

/**
 * ToolAdapterService — dynamically creates tool_* prefixed tools from the tool registry.
 * Each registered Tool with handlerCode becomes an invocable agent tool.
 */
@Injectable()
export class ToolAdapterService implements ToolProvider {
  readonly toolIds = ['tools'];
  private readonly logger = new Logger(ToolAdapterService.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly credentialService: CredentialService,
    private readonly confirmBridge: ConfirmationBridgeService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [{ id: 'tools', label: 'Tool Connectors', group: '连接' }];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const userId = ctx.userId;
    const skipConfirm = ctx.agentKey === '__skill__'; // Skills bypass confirmation forms

    return this.toolRegistry.getEnabled().filter(t => t.handlerCode).map(t => {
      const paramProps: Record<string, any> = {};
      for (const p of t.parameters) {
        const baseType = p.type === 'object' ? Type.Any() : p.type === 'number' ? Type.Number() : p.type === 'boolean' ? Type.Boolean() : Type.String();
        paramProps[p.name] = p.required ? baseType : Type.Optional(baseType);
      }
      const authSystem = t.authSystem || t.system || t.name;
      const needsAuth = t.authFields && t.authFields.length > 0;

      return {
        name: `tool_${t.name}`, label: t.description,
        description: (t.llmHint ? `${t.description}\n\n## 调用说明\n${t.llmHint}` : t.description) + (t.confirm ? '\n\n## 参数确认\n此工具有参数确认表单，调用时会弹出表单供用户核对编辑。请直接调用此工具并传入已知参数，不要逐项询问用户确认参数内容。缺失的参数留空即可，用户会在表单中补充。' : ''),
        parameters: Type.Object(paramProps) as any,
        execute: async (_id: string, args: Record<string, any>) => {
          // Auto-parse string args that should be objects/arrays (LLM may serialize JSON as string)
          for (const p of t.parameters) {
            if ((p.type === 'object' || p.type === 'array') && typeof args[p.name] === 'string') {
              try { args[p.name] = JSON.parse(args[p.name]); } catch {}
            }
          }
          // Confirm gate: if tool has confirm=true, request user confirmation before executing
          // Skip when called from skill handler (no UI to confirm in sandbox)
          if (t.confirm && !skipConfirm) {
            const confirmId = `${t.name}_${Date.now()}`;
            try {
              const editedArgs = await this.confirmBridge.requestConfirmation({
                confirmId,
                toolName: t.name,
                args,
                parameters: t.parameters,
                confirmForm: t.confirmForm,
                description: t.description,
              });
              args = editedArgs;
            } catch (err: any) {
              const cancelled = err.message === 'user_cancelled';
              const msg = cancelled ? '用户取消了此操作' : '参数确认超时，操作已取消';
              return { content: [{ type: 'text' as const, text: msg }], details: { __confirmCancelled: true, __userCancelled: cancelled } };
            }
          }
          const userCredentials = this.credentialService.resolveCredentials(userId || '', authSystem);
          if (needsAuth && (!userCredentials || Object.keys(userCredentials).length === 0)) {
            const fieldNames = t.authFields!.map(f => f.label || f.key).join('、');
            return { content: [{ type: 'text' as const, text: `[凭证缺失] 工具 "${t.name}" 需要凭证（${fieldNames}）但当前用户未配置。请在侧边栏"连接"面板中选择该连接，切换到"凭证"选项卡配置。` }], details: null };
          }
          try {
            let code = t.handlerCode!.replace(/import\s+.*?from\s+.*?;?\n?/g, '').replace(/export\s+/g, '').replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ');
            const fn = new Function('ctx', `return (async function() { ${code} return execute(ctx); })();`);
            const { McpHttpClient } = require('../mcp/mcp-http-client');
            const httpClient = new McpHttpClient(userId);
            const result = await fn({ params: args, credentials: userCredentials || {}, userId, http: httpClient });
            const resultText = result.message || JSON.stringify(result);
            this.logger.debug(`Tool ${t.name} result: ${resultText.substring(0, 200)}`);
            if (result.success === false || resultText.includes('失败') || resultText.includes('failed') || resultText.includes('error')) {
              return { content: [{ type: 'text' as const, text: `${resultText}` }], details: result };
            }
            return { content: [{ type: 'text' as const, text: resultText }], details: result };
          } catch (err: any) {
            this.logger.warn(`Tool ${t.name} error: ${err.message}`);
            return { content: [{ type: 'text' as const, text: `工具执行失败: ${err.message}` }], details: null };
          }
        },
      };
    });
  }
}
