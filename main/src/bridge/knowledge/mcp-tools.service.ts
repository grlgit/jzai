import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service';

/**
 * McpToolsService connects to the Knowledge Base MCP Server (llm_wiki)
 * and wraps MCP tools as AgentTools for the main agent.
 */
@Injectable()
export class McpToolsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpToolsService.name);
  private mcpClient: any = null;
  private connected = false;
  private kbSlug = 'default';
  private kbEventListeners: Array<(event: KbAnalyticsEvent) => void> = [];
  // Circuit breaker state
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private static readonly MAX_FAILURES = 3;
  private static readonly COOLDOWN_MS = 30000; // 30s

  // Enterprise Mind layer cache (P0-5: avoid repeated MCP reads on agent creation)
  private knowledgeLayerCache = new Map<string, { value: string | null; expiry: number }>();
  private static readonly KNOWLEDGE_LAYER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly appConfig: AppConfigService) {}

  /** Register a listener for KB analytics events (used by AnalyticsService) */
  onKbEvent(fn: (event: KbAnalyticsEvent) => void) {
    this.kbEventListeners.push(fn);
  }

  private emitKbEvent(type: string, data: Record<string, any>) {
    const event: KbAnalyticsEvent = { type, timestamp: new Date(), ...data };
    for (const fn of this.kbEventListeners) {
      try { fn(event); } catch { /* ignore listener errors */ }
    }
  }

  async onModuleInit() {
    this.kbSlug = this.appConfig.get('knowledgeBase.slug', 'default');
    await this.connect();
  }

  async onModuleDestroy() {
    try { await this.mcpClient?.close?.(); } catch { /* ignore */ }
    this.mcpClient = null;
    this.connected = false;
    this.kbEventListeners = [];
    this.logger.log('MCP client disconnected');
  }

  private getEndpoint(): string {
    return this.appConfig.get('knowledgeBase.mcpEndpoint', 'http://localhost:3011');
  }

  private getApiEndpoint(): string {
    return this.appConfig.get('knowledgeBase.apiEndpoint', 'http://localhost:8000');
  }

  private async connect() {
    const endpoint = this.getEndpoint();
    this.logger.log(`Connecting to Knowledge Base MCP: ${endpoint}/mcp`);

    try {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      const transport = new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`));
      const client = new Client({ name: 'jianzhi-main', version: '1.0.0' });
      await client.connect(transport);

      this.mcpClient = client;
      this.connected = true;
      this.consecutiveFailures = 0;
      this.logger.log('Knowledge Base MCP connected successfully');
    } catch (err: any) {
      this.consecutiveFailures++;
      this.connected = false;
      if (this.consecutiveFailures >= McpToolsService.MAX_FAILURES) {
        this.circuitOpenUntil = Date.now() + McpToolsService.COOLDOWN_MS;
        this.logger.warn(`MCP circuit breaker OPEN — ${this.consecutiveFailures} failures, cooling ${McpToolsService.COOLDOWN_MS / 1000}s`);
      } else {
        this.logger.warn(`MCP connection failed (${this.consecutiveFailures}/${McpToolsService.MAX_FAILURES}): ${err.message}`);
      }
    }
  }

  private async ensureConnected() {
    if (this.connected && this.mcpClient) return;
    // Circuit breaker: skip retry if in cooldown
    if (Date.now() < this.circuitOpenUntil) return;
    await this.connect();
  }

  private async callMcpTool(
    toolName: string,
    args: Record<string, any>,
    scopes?: string[] | 'ADMIN_ALL',
  ): Promise<string> {
    await this.ensureConnected();
    if (!this.mcpClient) {
      return '企业心智未连接，请确保知识服务已启动。';
    }

    try {
      const callArgs = { ...args };
      if (scopes !== undefined) {
        callArgs.scopes = scopes === 'ADMIN_ALL' ? ['ADMIN_ALL'] : scopes;
      }
      const result = await this.mcpClient.callTool({ name: toolName, arguments: callArgs });
      // Invalidate cached KB layers after successful writes to wiki paths
      if ((toolName === 'write' || toolName === 'delete') && args.path?.startsWith('/wiki/')) {
        this.invalidateKnowledgeLayerCache();
      }
      // MCP returns content array with text items
      if (result?.content && Array.isArray(result.content)) {
        return result.content.map((c: any) => c.text || '').join('\n');
      }
      return JSON.stringify(result);
    } catch (err: any) {
      this.logger.error(`MCP tool ${toolName} failed: ${err.message}`);
      // Mark as disconnected for retry
      this.connected = false;
      this.mcpClient = null;
      return `企业心智查询失败: ${err.message}`;
    }
  }

  private getCachedKnowledgeLayer(key: string): string | null | undefined {
    const cached = this.knowledgeLayerCache.get(key);
    if (!cached) return undefined;
    if (cached.expiry < Date.now()) {
      this.knowledgeLayerCache.delete(key);
      return undefined;
    }
    return cached.value;
  }

  private setCachedKnowledgeLayer(key: string, value: string | null) {
    this.knowledgeLayerCache.set(key, {
      value,
      expiry: Date.now() + McpToolsService.KNOWLEDGE_LAYER_CACHE_TTL_MS,
    });
  }

  /** Explicitly invalidate the KB layer cache (e.g. after admin edits) */
  invalidateKnowledgeLayerCache() {
    this.knowledgeLayerCache.clear();
    this.logger.debug('Knowledge layer cache invalidated');
  }

  /**
   * Returns raw MCP tools (guide/search/read/write/delete) for the wiki_compiler agent.
   * These pass arguments directly to the MCP server without schema restrictions.
   */
  async getRawMcpTools(): Promise<McpTool[]> {
    await this.ensureConnected();
    if (!this.mcpClient) return [];

    try {
      const { tools } = await this.mcpClient.listTools();
      return tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || tool.name,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        execute: async (_id: string, params: any) => {
          const text = await this.callMcpTool(tool.name, params);
          return { content: [{ type: 'text', text }] };
        },
      }));
    } catch (err: any) {
      this.logger.error(`Failed to list MCP tools: ${err.message}`);
      return [];
    }
  }

  async getKnowledgeTools(): Promise<McpTool[]> {
    return [
      {
        name: 'search_knowledge',
        description: '搜索企业心智，根据问题检索相关知识。返回带来源引用的结构化上下文。用于回答用户关于公司产品、制度、流程等问题。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '搜索查询' },
            tags: { type: 'string', description: '按标签过滤，多个用逗号分隔（如 "产品,规格"）' },
            scope: { type: 'string', enum: ['all', 'wiki', 'sources'], description: '搜索范围: all=全部, wiki=百科, sources=来源文档' },
            limit: { type: 'number', description: '最多返回条数（默认5）' },
          },
          required: ['query'],
        },
        execute: async (
          _id: string,
          params: { query: string; tags?: string; scope?: string; limit?: number },
          ctx?: { userEmail?: string; userId?: string; scopes?: string[] | 'ADMIN_ALL' },
        ) => {
          this.logger.debug(`Knowledge search: ${params.query} (tags: ${params.tags || '-'}, scope: ${params.scope || 'all'}, user: ${ctx?.userEmail || '-'})`);

          // Use search (chunk-level) for better granularity, then read full docs for top hits
          const searchText = await this.callMcpTool('search', {
            knowledge_base: this.kbSlug,
            mode: 'search',
            query: params.query,
            path: params.scope === 'wiki' ? '/wiki/**' : params.scope === 'sources' ? '/**' : undefined,
            tags: params.tags,
            limit: params.limit || 8,
            ...(ctx?.userEmail ? { user_email: ctx.userEmail } : {}),
          }, ctx?.scopes);

          // Hit detection: check for actual content (not just error messages)
          const noResultPatterns = ['No results', 'No matches', '没有找到', 'No documents', 'not found', '0 result'];
          const isError = noResultPatterns.some(p => searchText.includes(p));
          const hasSubstantiveContent = searchText.trim().length > 100 && /[a-zA-Z\u4e00-\u9fa5]{10,}/.test(searchText);
          const hasResults = !isError && hasSubstantiveContent;

          this.emitKbEvent('kb_search', {
            query: params.query, tags: params.tags || null,
            scope: params.scope || 'all', hit: hasResults,
            resultLength: searchText.trim().length,
          });

          if (!hasResults) {
            return { content: [{ type: 'text', text: `未找到与"${params.query}"相关的知识。建议尝试不同的关键词，或联系管理员补充相关资料。` }] };
          }

          // Assemble context with token budget (max ~4000 tokens ≈ 16KB)
          const MAX_CONTEXT_CHARS = 16000;
          let assembled = `## 企业心智检索结果\n\n**查询**: ${params.query}${params.tags ? `  **标签**: ${params.tags}` : ''}\n\n`;

          // Deduplicate: the search results may contain overlapping chunks from the same doc
          const sections = searchText.split(/(?=^###?\s)/m).filter(s => s.trim());
          const seen = new Set<string>();
          let budgetRemaining = MAX_CONTEXT_CHARS;

          for (const section of sections) {
            // Extract source identifier (filename) for dedup
            const sourceMatch = section.match(/(?:来源|Source|File):\s*(.+?)(?:\n|$)/i) || section.match(/\*\*(.+?)\*\*/);
            const sourceKey = sourceMatch ? sourceMatch[1].trim() : section.substring(0, 80);

            if (seen.has(sourceKey)) continue;
            seen.add(sourceKey);

            if (section.length > budgetRemaining) {
              if (budgetRemaining > 200) {
                assembled += section.substring(0, budgetRemaining) + '\n\n...(内容已截断)\n';
              }
              break;
            }
            assembled += section + '\n\n';
            budgetRemaining -= section.length;
          }

          return { content: [{ type: 'text', text: assembled.trim() }] };
        },
      },
      {
        name: 'list_knowledge_tags',
        description: '列出企业心智中已有的标签分类，帮助了解知识内容结构。',
        parameters: {
          type: 'object',
          properties: {},
        },
        execute: async (_id: string, _params: any) => {
          const text = await this.callMcpTool('search', {
            knowledge_base: this.kbSlug,
            mode: 'list',
            path: '**',
          });
          // Extract unique tags from document listing
          const tagSet = new Set<string>();
          const tagMatches = text.matchAll(/tags?:\s*\[([^\]]*)\]/gi);
          for (const m of tagMatches) {
            m[1].split(',').map(t => t.trim().replace(/['"]/g, '')).filter(Boolean).forEach(t => tagSet.add(t));
          }
          const tags = [...tagSet].sort();
          const result = tags.length > 0
            ? `企业心智标签 (${tags.length}):\n${tags.map(t => `- ${t}`).join('\n')}`
            : '企业心智尚未设置标签。建议在文档 frontmatter 中添加 tags 字段。';
          return { content: [{ type: 'text', text: result }] };
        },
      },
      {
        name: 'compile_wiki',
        description: '将企业心智中的来源文档编译为企业百科（Wiki）。自动读取来源、生成并写入 Wiki 页面。当用户要求"生成百科"、"编译心智"、"整理资料"时调用。',
        parameters: {
          type: 'object',
          properties: {
            focus: { type: 'string', description: '可选：只处理指定文件名的文档' },
          },
        },
        execute: async (_id: string, params: { focus?: string }) => {
          this.logger.log('compile_wiki: starting');

          // Resolve KB slug
          const apiEndpoint = this.getApiEndpoint();
          let kbSlug = this.kbSlug;
          let sources: any[] = [];
          try {
            const kbResp = await fetch(`${apiEndpoint}/v1/knowledge-bases`);
            const kbs = await kbResp.json();
            const kb = kbs[0];
            if (!kb) return { content: [{ type: 'text', text: '企业心智未初始化。' }] };
            kbSlug = kb.slug || kb.name;
            const resp = await fetch(`${apiEndpoint}/v1/knowledge-bases/${kb.id}/documents`);
            const docs = await resp.json();
            sources = docs.filter((d: any) => !d.path?.startsWith('/wiki/') && d.status === 'ready');
            if (params.focus) sources = sources.filter((d: any) => d.filename.includes(params.focus));
          } catch (err: any) {
            return { content: [{ type: 'text', text: `无法获取来源文档列表: ${err.message}` }] };
          }

          if (sources.length === 0) {
            return { content: [{ type: 'text', text: '没有可处理的来源文档。请先上传文档到企业心智。' }] };
          }

          // Read source summaries via MCP read
          const summaries: string[] = [];
          for (const doc of sources.slice(0, 15)) {
            try {
              const text = await this.callMcpTool('read', {
                knowledge_base: kbSlug,
                path: doc.filename,
                pages: '1-3',
              });
              summaries.push(`- **${doc.title || doc.filename}** (${doc.page_count || '?'}p): ${text.substring(0, 200)}`);
            } catch {
              summaries.push(`- **${doc.title || doc.filename}**: [读取失败]`);
            }
          }

          const today = new Date().toISOString().split('T')[0];
          const results: string[] = [];

          // Directly write overview page via MCP write
          try {
            const overviewContent = [
              '---',
              'title: 企业心智总览',
              `description: ${sources.length} 篇来源文档的知识汇总`,
              `date: ${today}`,
              'tags:',
              '  - overview',
              '---',
              '',
              `本企业心智包含 ${sources.length} 篇来源文档。`,
              '',
              '## 来源文档',
              '',
              '| 文件名 | 类型 | 页数 |',
              '|--------|------|------|',
              ...sources.map((d: any) => `| ${d.title || d.filename} | ${d.file_type} | ${d.page_count || '-'} |`),
              '',
              '## 关键发现',
              '',
              ...summaries,
            ].join('\n');

            await this.callMcpTool('write', {
              knowledge_base: kbSlug, command: 'create',
              path: '/wiki/_drafts/', title: 'overview.md',
              content: overviewContent, tags: ['overview'], overwrite: true,
            });
            results.push('✅ /wiki/overview.md');
            this.logger.log('compile_wiki: wrote overview.md');
          } catch (e: any) {
            results.push(`❌ overview.md: ${e.message}`);
          }

          // Directly write log page via MCP write
          try {
            const sourceList = sources.map((d: any) => `  - ${d.filename}`).join('\n');
            const logContent = [
              '---',
              'title: 编译日志',
              'description: 企业心智编译记录',
              `date: ${today}`,
              'tags:',
              '  - log',
              '---',
              '',
              `## [${today}] ingest`,
              '',
              `- 来源文档: ${sources.length} 篇`,
              sourceList,
              '- 创建了 overview.md 总览页',
            ].join('\n');

            await this.callMcpTool('write', {
              knowledge_base: kbSlug, command: 'create',
              path: '/wiki/_drafts/', title: 'log.md',
              content: logContent, tags: ['log'], overwrite: true,
            });
            results.push('✅ /wiki/log.md');
            this.logger.log('compile_wiki: wrote log.md');
          } catch (e: any) {
            results.push(`❌ log.md: ${e.message}`);
          }

          return {
            content: [{ type: 'text', text: [
              `## 百科编译完成`,
              '',
              `已处理 ${sources.length} 篇来源文档:`,
              ...results,
              '',
              '基础页面已生成到 /wiki/_drafts/ 目录，待管理员审核后发布。',
              '你可以继续让我为企业心智生成更多概念页和实体页。',
            ].join('\n') }],
            details: { __action: true, actionType: 'kb_compiling', actionData: { sourceCount: sources.length } },
          };
        },
      },
      {
        name: 'suggest_knowledge',
        description: '建议将一条新知识添加到企业心智（需管理员审核）。当发现有价值的新知识时调用。',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '知识内容' },
            type: { type: 'string', enum: ['character', 'rule', 'fact'], description: '知识类型' },
            category: { type: 'string', description: '知识分类' },
          },
          required: ['content', 'type'],
        },
        execute: async (_id: string, params: any) => {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const pagePath = `/wiki/pending/${params.category || params.type}/${timestamp}.md`;
          const pageContent = `---\ntags: [${params.type}, pending]\ncategory: ${params.category || '未分类'}\n---\n\n${params.content}`;
          const text = await this.callMcpTool('write', {
            knowledge_base: this.kbSlug,
            path: pagePath,
            content: pageContent,
          });
          return { content: [{ type: 'text', text: text || '已提交知识建议，等待审核。' }] };
        },
      },
    ];
  }

  // ── Enterprise Mind: three-layer knowledge retrieval ──────────────────

  /**
   * Fetch a compact knowledge digest for system prompt injection.
   * Returns categories, tags, and recent docs (~1500 chars) or null.
   */
  async fetchKnowledgeDigest(): Promise<string | null> {
    const cacheKey = `digest:${this.kbSlug}`;
    const cached = this.getCachedKnowledgeLayer(cacheKey);
    if (cached !== undefined) return cached;

    try {
      await this.ensureConnected();
      if (!this.mcpClient) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }

      const text = await this.callMcpTool('search', {
        knowledge_base: this.kbSlug,
        mode: 'digest',
      }, ['ADMIN_ALL']);

      if (!text || text.includes('未连接') || text.includes('not found') || text.includes('当前为空')) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }
      const result = text.trim() || null;
      this.setCachedKnowledgeLayer(cacheKey, result);
      return result;
    } catch (err: any) {
      this.logger.debug(`Knowledge digest fetch failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch character layer content from KB (_character/ directory).
   * Returns concatenated markdown or null if KB unavailable or empty.
   */
  async fetchCharacterLayer(): Promise<string | null> {
    const cacheKey = `character:${this.kbSlug}`;
    const cached = this.getCachedKnowledgeLayer(cacheKey);
    if (cached !== undefined) return cached;

    try {
      await this.ensureConnected();
      if (!this.mcpClient) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }

      const text = await this.callMcpTool('read', {
        knowledge_base: this.kbSlug,
        path: '/wiki/_character/**',
      });

      if (!text || text.includes('未连接') || text.includes('No documents found') || text.includes('not found')) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }
      const result = text.trim() || null;
      this.setCachedKnowledgeLayer(cacheKey, result);
      return result;
    } catch (err: any) {
      this.logger.debug(`Character layer fetch failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Fetch rules layer content from KB (_rules/ directory).
   * Returns concatenated markdown or null if KB unavailable or empty.
   */
  async fetchRulesLayer(): Promise<string | null> {
    const cacheKey = `rules:${this.kbSlug}`;
    const cached = this.getCachedKnowledgeLayer(cacheKey);
    if (cached !== undefined) return cached;

    try {
      await this.ensureConnected();
      if (!this.mcpClient) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }

      const text = await this.callMcpTool('read', {
        knowledge_base: this.kbSlug,
        path: '/wiki/_rules/**',
      });

      if (!text || text.includes('未连接') || text.includes('No documents found') || text.includes('not found')) {
        this.setCachedKnowledgeLayer(cacheKey, null);
        return null;
      }
      const result = text.trim() || null;
      this.setCachedKnowledgeLayer(cacheKey, result);
      return result;
    } catch (err: any) {
      this.logger.debug(`Rules layer fetch failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Check if KB is connected and has content.
   */
  isAvailable(): boolean {
    return this.connected && !!this.mcpClient;
  }

  /**
   * Public: list available MCP tools (for CoWorker proxy).
   */
  async getAvailableTools(): Promise<Array<{ name: string; description: string; inputSchema?: any }>> {
    await this.ensureConnected();
    if (!this.mcpClient) return [];
    try {
      const { tools } = await this.mcpClient.listTools();
      return tools.map((t: any) => ({
        name: t.name,
        description: t.description || t.name,
        inputSchema: t.inputSchema,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Public: call an MCP tool by name (for CoWorker proxy).
   */
  async callTool(
    name: string,
    args: Record<string, any>,
    scopes?: string[] | 'ADMIN_ALL',
  ): Promise<{ content: string }> {
    const text = await this.callMcpTool(name, args, scopes);
    return { content: text };
  }
}

/** Lightweight tool definition used by McpToolsService before pi-ai wrapping */
export interface McpTool {
  name: string;
  description: string;
  parameters: any;
  execute: (
    id: string,
    params: any,
    ctx?: { userEmail?: string; userId?: string; scopes?: string[] | 'ADMIN_ALL' },
  ) => Promise<{ content: { type: string; text: string }[] }>;
}

/** KB analytics event emitted on knowledge searches */
export interface KbAnalyticsEvent {
  type: string;
  timestamp: Date;
  query?: string;
  tags?: string | null;
  scope?: string;
  hit?: boolean;
  [key: string]: any;
}
