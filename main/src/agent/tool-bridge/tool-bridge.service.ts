
import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry, TOOL_PROVIDERS } from './tool-provider.interface';
import { DynamicToolProviderRegistry } from './dynamic-tool-provider.registry';
import { AppGrantService } from '../../platform/app-store/services/app-grant.service';
import { UserService } from '../../user/user.service';
import { classifyError, formatToolError } from './tool-error';

/**
 * ToolBridgeService — collects all ToolProviders and builds tool sets for agents.
 * Includes L1 truncation (safety wrapper) for all tool outputs.
 */
@Injectable()
export class ToolBridgeService {
  private readonly logger = new Logger(ToolBridgeService.name);
  private providerMap = new Map<string, ToolProvider>();
  private providerTokenLimits: Record<string, number> = {};
  private piAi: any = null;

  // P0-4: cache ToolInstance Arrays per provider+context to avoid rebuilding on every message
  private toolInstanceCache = new Map<string, { tools: ToolInstance[]; expiry: number }>();
  private static readonly TOOL_CACHE_TTL_MS = 60 * 1000; // 1 minute

  // App tool access cache: "appId:userId" -> { allowed, expiry }
  private toolAccessCache = new Map<string, { allowed: boolean; expiry: number }>();
  private static readonly TOOL_ACCESS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    @Optional() @Inject(TOOL_PROVIDERS) private readonly providers: ToolProvider[] = [],
    @Optional() private readonly dynamicRegistry?: DynamicToolProviderRegistry,
    @Optional() private readonly appGrantService?: AppGrantService,
    @Optional() private readonly userService?: UserService,
  ) {
    for (const p of (this.providers || [])) {
      for (const id of p.toolIds) {
        this.providerMap.set(id, p);
      }
      if (p.tokenLimits) {
        for (const [toolName, limit] of Object.entries(p.tokenLimits)) {
          this.providerTokenLimits[toolName] = limit;
        }
      }
    }
    const dynamicCount = this.dynamicRegistry ? this.dynamicRegistry.getAll().length : 0;
    if (this.providers?.length > 0 || dynamicCount > 0) {
      this.logger.log(`Registered ${this.providers.length} static tool providers (${this.providerMap.size} static tool IDs), ${dynamicCount} dynamic providers`);
    }
  }

  /** Initialize with piAi reference (called from DynamicAgentService.onModuleInit) */
  async init(piAi: any): Promise<void> {
    this.piAi = piAi;
    this.logger.log(`ToolBridgeService initialized (${this.providerMap.size} tool IDs)`);
  }

  private cacheKeyForProvider(provider: ToolProvider, ctx: ToolContext): string {
    // Only user/agent-scoped fields affect tool shape; piAi is process-global.
    return `${provider.toolIds.join(',')}::${ctx.userId || ''}::${ctx.userEmail || ''}::${ctx.agentKey || ''}`;
  }

  private async getOrCreateTools(provider: ToolProvider, triggerId: string, ctx: ToolContext): Promise<ToolInstance[]> {
    const key = this.cacheKeyForProvider(provider, ctx);
    const cached = this.toolInstanceCache.get(key);
    if (cached && cached.expiry > Date.now()) {
      return cached.tools;
    }

    try {
      const tools = await provider.createTools(ctx);
      this.toolInstanceCache.set(key, { tools, expiry: Date.now() + ToolBridgeService.TOOL_CACHE_TTL_MS });
      return tools;
    } catch (err: any) {
      this.logger.warn(`ToolProvider for "${triggerId}" failed: ${err.message}`);
      return [];
    }
  }

  /**
   * Build tools for an agent by tool name list.
   * Resolves each name to a ToolProvider, creates tool instances, and wraps with safety.
   */
  async buildForAgent(
    toolNames: string[],
    ctx: ToolContext,
    maxToolOutputChars?: number,
  ): Promise<ToolInstance[]> {
    const fullCtx: ToolContext = { ...ctx, piAi: this.piAi };
    const tools: { tool: ToolInstance; triggerId: string }[] = [];
    const individualTools: string[] = [];
    const individualMcps: string[] = [];

    // Preserve first-appearance order of providers for deterministic deduplication
    const providerOrder: { provider: ToolProvider; triggerId: string }[] = [];
    const seenProviders = new Set<ToolProvider>();
    for (const name of toolNames) {
      if (name.startsWith('tool:')) {
        individualTools.push(name.slice(5));
      } else if (name.startsWith('mcp:')) {
        individualMcps.push(name.slice(4));
      } else {
        const provider = this.findProvider(name);
        if (provider && !seenProviders.has(provider)) {
          seenProviders.add(provider);
          providerOrder.push({ provider, triggerId: name });
        } else if (!provider) {
          this.logger.warn(`Unknown tool: ${name} (no provider registered)`);
        }
      }
    }

    // Create tools in parallel while preserving order for collision resolution
    const createdArrays = await Promise.all(
      providerOrder.map(({ provider, triggerId }) =>
        this.getOrCreateTools(provider, triggerId, fullCtx).then(created =>
          created.map(t => ({ tool: t, triggerId }))
        )
      )
    );
    for (const arr of createdArrays) tools.push(...arr);

    // Load individually selected custom tools (tool:xxx → filter from 'tools' provider)
    if (individualTools.length > 0) {
      const toolsProvider = this.providerMap.get('tools');
      if (toolsProvider) {
        const allCustom = await this.getOrCreateTools(toolsProvider, 'tools', fullCtx);
        for (const t of allCustom.filter(t => individualTools.some(n => t.name === `tool_${n}`))) {
          tools.push({ tool: t, triggerId: 'tools' });
        }
      }
    }

    // Load individually selected MCP servers (mcp:xxx → filter from 'mcp' provider)
    if (individualMcps.length > 0) {
      const mcpProvider = this.providerMap.get('mcp');
      if (mcpProvider) {
        const allMcp = await this.getOrCreateTools(mcpProvider, 'mcp', fullCtx);
        for (const t of allMcp.filter(t => individualMcps.some(n => t.name.startsWith(`mcp_${n}_`)))) {
          tools.push({ tool: t, triggerId: 'mcp' });
        }
      }
    }

    // Deduplicate: first occurrence keeps its name, later ones get prefixed with triggerId
    const seen = new Map<string, number>();
    const deduped: ToolInstance[] = [];
    for (const { tool, triggerId } of tools) {
      if (!seen.has(tool.name)) {
        seen.set(tool.name, deduped.length);
        deduped.push(tool);
      } else {
        const prefixed = `${triggerId}_${tool.name}`;
        this.logger.warn(`Tool name collision: "${tool.name}" (from ${triggerId}) renamed to "${prefixed}"`);
        deduped.push({ ...tool, name: prefixed });
      }
    }

    // Global safety wrapper: auth + truncation + error catch
    return this.wrapWithSafety(deduped, ctx.userId, maxToolOutputChars);
  }

  /** Get catalog for settings UI */
  getCatalog(): ToolCatalogEntry[] {
    const entries: ToolCatalogEntry[] = [];
    for (const p of (this.providers || [])) {
      entries.push(...p.getCatalog());
    }
    for (const p of (this.dynamicRegistry?.getAll() ?? [])) {
      entries.push(...p.getCatalog());
    }
    return entries;
  }

  hasProvider(toolId: string): boolean {
    if (this.providerMap.has(toolId)) return true;
    return this.dynamicRegistry?.getAll().some(p => p.toolIds.includes(toolId)) ?? false;
  }

  getRegisteredToolIds(): string[] {
    const ids = new Set(this.providerMap.keys());
    for (const p of (this.dynamicRegistry?.getAll() ?? [])) {
      for (const id of p.toolIds) ids.add(id);
    }
    return Array.from(ids);
  }

  private findProvider(toolId: string): ToolProvider | undefined {
    return this.providerMap.get(toolId) ?? this.dynamicRegistry?.getAll().find(p => p.toolIds.includes(toolId));
  }

  // ── Safety wrapper (L1 truncation + error catch) ────────────────────────

  private wrapWithSafety(tools: ToolInstance[], userId?: string, maxToolOutputChars?: number): ToolInstance[] {
    return tools.map(tool => ({
      ...tool,
      execute: async (...args: any[]) => {
        // Auth gate for tools contributed by installed apps.
        const ownerApp = this.dynamicRegistry?.getOwnerApp(tool.name);
        if (ownerApp && userId) {
          const allowed = await this.checkToolAccess(ownerApp, userId);
          if (!allowed) {
            return {
              content: [{ type: 'text' as const, text: `Forbidden: no grant for app ${ownerApp}` }],
              details: { __error: { code: 'FORBIDDEN', message: `No grant for app ${ownerApp}` } },
            };
          }
        }
        try {
          const result = await tool.execute(...args);
          return this.truncateToolResult(result, tool.name, maxToolOutputChars);
        } catch (err: any) {
          // P0-5: classify the exception so the Agent loop and UI can react by error type
          const structured = classifyError(err, tool.name);
          this.logger.warn(`Tool ${tool.name} error [${structured.code}]: ${structured.raw || structured.message}`);
          return {
            content: [{ type: 'text' as const, text: formatToolError(structured) }],
            details: { __error: structured },
          };
        }
      },
    }));
  }

  private async checkToolAccess(appId: string, userId: string): Promise<boolean> {
    const key = `${appId}:${userId}`;
    const cached = this.toolAccessCache.get(key);
    if (cached && cached.expiry > Date.now()) return cached.allowed;

    let allowed = false;
    if (this.userService && this.appGrantService) {
      const user = await this.userService.getUser(userId);
      if (user?.role?.permissions?.includes('sys:admin')) {
        allowed = true;
      } else {
        allowed = await this.appGrantService.hasAppAccess(appId, userId);
      }
    }

    this.toolAccessCache.set(key, { allowed, expiry: Date.now() + ToolBridgeService.TOOL_ACCESS_CACHE_TTL_MS });
    return allowed;
  }

  /**
   * Direct single-tool invocation — the runtime path of AppContext.tools.call
   * (manifest.usesPlatformTools channel). Goes through the same safety wrapper
   * (auth + truncation + error classification) as agent tool calls.
   * Structured tool errors are re-thrown as exceptions for app code.
   */
  async callTool(toolId: string, params: unknown, userId?: string): Promise<unknown> {
    const provider = this.findProvider(toolId);
    if (!provider) throw new Error(`Unknown platform tool: ${toolId}`);
    const created = await this.getOrCreateTools(provider, toolId, { userId, piAi: this.piAi });
    const tool = created.find(t => t.name === toolId) ?? created[0];
    if (!tool) throw new Error(`Tool ${toolId} not created by its provider`);
    const [wrapped] = this.wrapWithSafety([tool], userId);
    const result = await wrapped.execute(toolId, params);
    const structured = (result as any)?.details?.__error;
    if (structured) {
      throw new Error(`${structured.code ?? 'TOOL_ERROR'}: ${structured.message ?? structured.raw ?? 'tool failed'}`);
    }
    return result;
  }

  /** L1: Truncate tool results to prevent context overflow. */
  private truncateToolResult(result: any, toolName: string, agentMaxChars?: number): any {
    if (!result?.content) return result;

    const baseLimits: Record<string, number> = {
      document_extract: 20000, read: 20000, ocr: 20000,
      knowledge: 15000, kb_mcp: 15000, web_search: 15000,
      fetch_url: 15000, firecrawl: 15000, web_fetch: 15000,
      bash: 10000,
    };

    // Dynamic registry limits override static provider limits, which override base defaults.
    // Agent-level cap wins if explicitly provided.
    const dynamicLimit = this.dynamicRegistry?.getTokenLimit(toolName);
    let maxChars = agentMaxChars || dynamicLimit || this.providerTokenLimits[toolName] || baseLimits[toolName];
    if (!maxChars) {
      if (toolName.startsWith('mcp_') || toolName.startsWith('tool_')) {
        maxChars = 55000;
      } else {
        maxChars = 20000;
      }
    }

    const textParts = Array.isArray(result.content) ? result.content.filter((c: any) => c.type === 'text') : [];
    for (const part of textParts) {
      if (!part.text || part.text.length <= maxChars) continue;

      const sample = part.text.slice(0, 200);
      if (/[\x00-\x08\x0E-\x1F]/.test(sample) || sample.includes('PK!')) {
        this.logger.warn(`Tool ${toolName}: binary content detected (${part.text.length}ch), filtered`);
        part.text = `工具返回了二进制内容（${part.text.length} 字符），已自动过滤。如需提取文件内容，请使用 document_extract 工具。`;
        continue;
      }

      const origLen = part.text.length;
      const originalText = part.text;
      if (toolName === 'bash') {
        const head = part.text.slice(0, Math.floor(maxChars * 0.7));
        const tail = part.text.slice(-Math.floor(maxChars * 0.3));
        part.text = `${head}\n\n...(中间省略 ${origLen - maxChars} 字符)...\n\n${tail}`;
      } else {
        const firstChar = part.text.trimStart()[0];
        if (firstChar === '{' || firstChar === '[') {
          part.text = this.summarizeData(part.text, maxChars, origLen);
        } else {
          part.text = part.text.slice(0, maxChars) + `\n\n...(截断，原文共 ${origLen} 字符)`;
        }
      }
      // Preserve original full text for programmatic consumers (skill handlers)
      result._raw = originalText;
      this.logger.debug(`Tool ${toolName}: result truncated ${origLen} → ${part.text.length}ch`);
      this.logger.log(`[CTX_METRIC] event=l1_truncate tool=${toolName} original_size=${origLen} truncated_size=${part.text.length} limit=${maxChars}`);
    }
    return result;
  }

  private summarizeData(text: string, maxChars: number, origLen: number): string {
    try {
      const data = JSON.parse(text);
      if (data && typeof data === 'object') {
        // DB query result pattern: { columns: [...], rows: [...], rowCount: N }
        if (Array.isArray(data.rows)) {
          const cols = Array.isArray(data.columns) ? data.columns : (data.rows[0] ? Object.keys(data.rows[0]) : []);
          const totalRows = data.rows.length;
          const sampleRows = data.rows.slice(0, 5);
          const summary = JSON.stringify({ columns: cols, rows: sampleRows, rowCount: data.rowCount ?? totalRows, _summary: `共 ${totalRows} 条数据，已保留前 5 条作为样本` });
          if (summary.length <= maxChars) return summary;
          // Even sample too large — just return metadata
          return JSON.stringify({ columns: cols, rowCount: data.rowCount ?? totalRows, _summary: `共 ${totalRows} 条数据（${origLen} 字符），样本数据过大已省略。字段: ${cols.join(', ')}` });
        }
        // Generic object/array — keep first portion as valid JSON
        if (Array.isArray(data)) {
          const sample = data.slice(0, 5);
          const summary = JSON.stringify(sample);
          if (summary.length <= maxChars) return JSON.stringify({ _items: sample, _summary: `共 ${data.length} 条，已保留前 5 条` });
          return JSON.stringify({ _summary: `数组共 ${data.length} 项（${origLen} 字符），数据过大已省略` });
        }
      }
    } catch { /* not valid JSON — fall through to plain truncation */ }
    return text.slice(0, maxChars) + `\n\n...(截断，原文共 ${origLen} 字符)`;
  }
}
