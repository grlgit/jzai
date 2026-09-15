import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { WorkspaceService } from '../../workspace/workspace.service';
import { KbSignatureService } from './kb-signature.service';
import * as fs from 'fs';
import * as path from 'path';

const COMPILE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
const ENTERPRISE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

@Injectable()
export class KbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(KbService.name);
  private compileTimer: ReturnType<typeof setInterval> | null = null;
  private enterpriseTimer: ReturnType<typeof setInterval> | null = null;
  private compiling = false;
  private maintaining = false;

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly signatureService: KbSignatureService,
  ) {}

  onModuleInit() {
    // Personal compilation + stale maintenance every 2 hours
    this.compileTimer = setInterval(() => this.runMaintenance(), COMPILE_INTERVAL_MS);
    this.logger.log(`Personal knowledge maintenance scheduled every ${COMPILE_INTERVAL_MS / 3600000}h`);

    // Enterprise compilation on a longer 6-hour interval
    this.enterpriseTimer = setInterval(() => this.compileEnterpriseKnowledge(), ENTERPRISE_INTERVAL_MS);
    this.logger.log(`Enterprise knowledge compilation scheduled every ${ENTERPRISE_INTERVAL_MS / 3600000}h`);
  }

  onModuleDestroy() {
    if (this.compileTimer) clearInterval(this.compileTimer);
    if (this.enterpriseTimer) clearInterval(this.enterpriseTimer);
  }

  getConfig(): { apiEndpoint: string; mcpEndpoint: string; slug: string } {
    try {
      const cfgPath = path.join(process.cwd(), 'config', 'system.json');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      return {
        apiEndpoint: cfg.knowledgeBase?.apiEndpoint || 'http://localhost:8000',
        mcpEndpoint: cfg.knowledgeBase?.mcpEndpoint || 'http://localhost:3011',
        slug: cfg.knowledgeBase?.slug || 'default',
      };
    } catch {
      return { apiEndpoint: 'http://localhost:8000', mcpEndpoint: 'http://localhost:3011', slug: 'default' };
    }
  }

  /**
   * Proxy a request to the llm_wiki API.
   * Forwards the caller's JWT token for unified auth.
   *
   * When no caller auth token is present, the request is signed internally
   * with the __system__ / ADMIN_ALL identity so that service-to-service calls
   * still pass llm_wiki's signature verification middleware.
   */
  async proxy(
    subPath: string, method: string, body?: any,
    headers?: Record<string, string>, authToken?: string,
  ): Promise<{ status: number; data: any; contentType?: string }> {
    const { apiEndpoint } = this.getConfig();
    const url = `${apiEndpoint}${subPath}`;

    try {
      const fetchHeaders: Record<string, string> = { ...headers };
      if (body && typeof body === 'object' && !(body instanceof Buffer)) {
        fetchHeaders['Content-Type'] = 'application/json';
      }
      // Forward auth token to llm_wiki for unified authentication
      if (authToken && !fetchHeaders['Authorization']) {
        fetchHeaders['Authorization'] = `Bearer ${authToken}`;
      }

      // Sign service-to-service requests when the caller did not supply
      // an Authorization header or pre-computed internal signature.
      if (!fetchHeaders['Authorization'] && !fetchHeaders['X-JZ-Signature']) {
        const signPath = subPath.split('?')[0];
        const signed = this.signatureService.signInternalRequest(method, signPath, body);
        Object.assign(fetchHeaders, signed);
      }

      const resp = await fetch(url, {
        method,
        headers: fetchHeaders,
        body: body ? (typeof body === 'string' || body instanceof Buffer ? body : JSON.stringify(body)) : undefined,
        signal: AbortSignal.timeout(30000),
      });

      const contentType = resp.headers.get('content-type') || '';
      let data: any;
      if (contentType.includes('json')) {
        data = await resp.json();
      } else {
        data = await resp.text();
      }

      return { status: resp.status, data, contentType };
    } catch (err: any) {
      this.logger.error(`KB proxy error: ${method} ${url} — ${err.message}`);
      return { status: 502, data: { error: '企业心智服务不可用', detail: err.message } };
    }
  }

  // ── Personal knowledge compilation ────────────────────────────────

  /**
   * Scan all users' raw/ folders and compile unprocessed docs into wiki/.
   * Runs every 2 hours via timer.
   */
  async compileAllPersonalKnowledge(): Promise<void> {
    if (this.compiling) { this.logger.debug('Compilation already running, skipping'); return; }
    this.compiling = true;
    try {
      // Get KB and all documents
      const kbResult = await this.proxy('/v1/knowledge-bases', 'GET');
      const kbs = Array.isArray(kbResult.data) ? kbResult.data : [];
      const kb = kbs[0];
      if (!kb) return;

      const docsResult = await this.proxy(`/v1/knowledge-bases/${kb.id}/documents`, 'GET');
      const docs = Array.isArray(docsResult.data) ? docsResult.data : [];

      // Find all personal raw docs
      const rawDocs = docs.filter((d: any) =>
        d.path?.includes('/_personal/') && d.path?.includes('/raw/') &&
        d.status === 'ready' && d.file_type === 'md',
      );
      if (rawDocs.length === 0) return;

      // Group by userId (extract from path: /wiki/_personal/{userId}/raw/)
      const byUser = new Map<string, any[]>();
      for (const doc of rawDocs) {
        const match = doc.path.match(/\/_personal\/([^/]+)\/raw\//);
        if (match) {
          const userId = match[1];
          if (!byUser.has(userId)) byUser.set(userId, []);
          byUser.get(userId)!.push(doc);
        }
      }

      // Find existing wiki docs to know what's already compiled
      const wikiDocs = docs.filter((d: any) =>
        d.path?.includes('/_personal/') && d.path?.includes('/wiki/'),
      );
      const wikiDocPaths = new Set(wikiDocs.map((d: any) => d.path + d.filename));

      for (const [userId, userRawDocs] of byUser) {
        // Check if there are new raw docs since last compilation
        const wikiOverviewPath = `/wiki/_personal/${userId}/wiki/overview.md`;
        const existingOverview = wikiDocs.find((d: any) => (d.path + d.filename) === wikiOverviewPath);
        const lastCompileTime = existingOverview?.updated_at ? new Date(existingOverview.updated_at) : new Date(0);

        const newDocs = userRawDocs.filter((d: any) => new Date(d.created_at) > lastCompileTime);
        if (newDocs.length === 0) continue;

        await this.compileUserKnowledge(kb.id, userId, userRawDocs);
      }
    } catch (err: any) {
      this.logger.debug(`Personal knowledge compilation skipped: ${err.message}`);
    } finally {
      this.compiling = false;
    }
  }

  /**
   * Compile a single user's raw docs into a structured wiki overview.
   */
  private async compileUserKnowledge(kbId: string, userId: string, rawDocs: any[]): Promise<void> {
    try {
      // Read content of raw docs (up to 20, most recent first)
      const sorted = rawDocs.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const toProcess = sorted.slice(0, 20);

      const contents: string[] = [];
      for (const doc of toProcess) {
        const contentResult = await this.proxy(`/v1/documents/${doc.id}/content`, 'GET');
        if (contentResult.status === 200) {
          const text = typeof contentResult.data === 'string' ? contentResult.data : contentResult.data?.content || '';
          if (text.trim()) contents.push(`### ${doc.title || doc.filename}\n\n${text.substring(0, 2000)}`);
        }
      }

      if (contents.length === 0) return;

      // Call LLM to compile into structured knowledge
      const { apiEndpoint } = this.getConfig();
      // Use the main platform's model router config
      const modelConfigPath = path.join(this.workspace.getRoot(), 'config', 'models.json');
      let modelConfig: any = {};
      try { modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8')); } catch {}

      const cloudProvider = modelConfig.cloudProvider || 'deepseek';
      const cloudModel = modelConfig.cloudModel || 'deepseek-chat';
      const apiKey = modelConfig.cloudApiKey || '';

      if (!apiKey) {
        this.logger.debug(`Skipping compilation for user ${userId}: no cloud API key`);
        return;
      }

      const providers: Record<string, string> = {
        deepseek: 'https://api.deepseek.com/v1',
        openai: 'https://api.openai.com/v1',
        'silicon-flow': 'https://api.siliconflow.cn/v1',
        qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      };
      const baseUrl = providers[cloudProvider] || `https://api.${cloudProvider}.com/v1`;

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cloudModel,
          messages: [{
            role: 'user',
            content: `将以下零散的个人知识笔记整理为结构化的个人百科。
要求：
- 合并相关主题，去除重复
- 按主题分章节，使用 Markdown 标题
- 保留关键事实和结论，去除对话噪声
- 输出完整的 Markdown 文档

---
${contents.join('\n\n---\n\n')}`,
          }],
          max_tokens: 4096,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) return;
      const data = await resp.json();
      const compiled = data.choices?.[0]?.message?.content?.trim();
      if (!compiled || compiled.length < 50) return;

      // Write compiled wiki overview
      const today = new Date().toISOString().slice(0, 10);
      const overviewContent = `---\ntitle: 个人知识总览\ndescription: 自动整理的个人知识百科\ntags:\n  - personal\n  - compiled\ndate: ${today}\n---\n\n${compiled}`;

      await this.proxy(
        `/v1/knowledge-bases/${kbId}/documents/note`, 'POST',
        { filename: 'overview.md', path: `/wiki/_personal/${userId}/wiki/`, content: overviewContent },
      );

      this.logger.log(`Compiled personal knowledge for user ${userId}: ${contents.length} raw docs → overview.md`);
    } catch (err: any) {
      this.logger.debug(`Failed to compile knowledge for user ${userId}: ${err.message}`);
    }
  }

  // ── Maintenance cycle ────────────────────────────────────────────

  /**
   * Run the full maintenance cycle: personal compilation + stale page refresh.
   */
  private async runMaintenance(): Promise<void> {
    if (this.maintaining) { this.logger.debug('Maintenance already running, skipping'); return; }
    this.maintaining = true;
    try {
      await this.compileAllPersonalKnowledge();
      await this.maintainWikiStaleness();
    } catch (err: any) {
      this.logger.debug(`Maintenance cycle error: ${err.message}`);
    } finally {
      this.maintaining = false;
    }
  }

  // ── Stale page detection and recompilation ───────────────────────

  /**
   * Find stale wiki pages via search and regenerate them from updated sources.
   */
  async maintainWikiStaleness(): Promise<void> {
    try {
      const { slug } = this.getConfig();

      // Get KB id
      const kbResult = await this.proxy('/v1/knowledge-bases', 'GET');
      const kbs = Array.isArray(kbResult.data) ? kbResult.data : [];
      const kb = kbs[0];
      if (!kb) return;

      // Search for stale wiki pages
      const searchResult = await this.proxy(
        `/v1/knowledge-bases/${kb.id}/search?q=stale&scope=wiki&limit=20`, 'GET',
      );
      const stalePages = Array.isArray(searchResult.data) ? searchResult.data : [];

      if (stalePages.length === 0) {
        this.logger.debug('No stale wiki pages found');
        return;
      }

      // Resolve LLM config (same pattern as compileUserKnowledge)
      const modelConfigPath = path.join(this.workspace.getRoot(), 'config', 'models.json');
      let modelConfig: any = {};
      try { modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8')); } catch {}

      const cloudProvider = modelConfig.cloudProvider || 'deepseek';
      const cloudModel = modelConfig.cloudModel || 'deepseek-chat';
      const apiKey = modelConfig.cloudApiKey || '';

      if (!apiKey) {
        this.logger.debug('Skipping stale page maintenance: no cloud API key');
        return;
      }

      const providers: Record<string, string> = {
        deepseek: 'https://api.deepseek.com/v1',
        openai: 'https://api.openai.com/v1',
        'silicon-flow': 'https://api.siliconflow.cn/v1',
        qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      };
      const baseUrl = providers[cloudProvider] || `https://api.${cloudProvider}.com/v1`;

      let refreshed = 0;
      for (const page of stalePages) {
        try {
          const docId = page.document_id || page.id;
          if (!docId) continue;

          // Read the stale page's current content
          const contentResult = await this.proxy(`/v1/documents/${docId}/content`, 'GET');
          if (contentResult.status !== 200) continue;
          const currentContent = typeof contentResult.data === 'string'
            ? contentResult.data
            : contentResult.data?.content || '';
          if (!currentContent.trim()) continue;

          // Call LLM to regenerate page from its current content + references
          const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: cloudModel,
              messages: [{
                role: 'user',
                content: `以下是一篇企业知识库的 wiki 页面，其引用的源数据已更新，内容可能过时。
请根据现有内容重新生成一个更准确、更完整的版本。

要求：
- 保持原有结构和 Markdown 格式
- 修正可能过时的描述
- 保留关键结论，更新事实数据
- 输出完整的 Markdown 文档

---
${currentContent.substring(0, 4000)}`,
              }],
              max_tokens: 4096,
              temperature: 0.2,
            }),
            signal: AbortSignal.timeout(60000),
          });

          if (!resp.ok) continue;
          const data = await resp.json();
          const regenerated = data.choices?.[0]?.message?.content?.trim();
          if (!regenerated || regenerated.length < 50) continue;

          // Write updated content back
          const docPath = page.path || '';
          const docFilename = page.filename || page.title || 'page.md';
          await this.proxy(
            `/v1/knowledge-bases/${kb.id}/documents/note`, 'POST',
            { filename: docFilename, path: docPath, content: regenerated },
          );
          refreshed++;
        } catch (err: any) {
          this.logger.debug(`Failed to refresh stale page ${page.id}: ${err.message}`);
        }
      }

      if (refreshed > 0) {
        this.logger.log(`Stale page maintenance: refreshed ${refreshed}/${stalePages.length} wiki pages`);
      }
    } catch (err: any) {
      this.logger.debug(`Stale page maintenance skipped: ${err.message}`);
    }
  }

  // ── Enterprise knowledge compilation ─────────────────────────────

  /**
   * Compile enterprise-level (non-personal) source documents into
   * a structured overview at /wiki/overview.md.
   * Runs every 6 hours via separate timer.
   */
  async compileEnterpriseKnowledge(): Promise<void> {
    if (this.compiling) { this.logger.debug('Compilation running, skipping enterprise compile'); return; }
    this.compiling = true;
    try {
      // Get KB
      const kbResult = await this.proxy('/v1/knowledge-bases', 'GET');
      const kbs = Array.isArray(kbResult.data) ? kbResult.data : [];
      const kb = kbs[0];
      if (!kb) return;

      // Get all documents
      const docsResult = await this.proxy(`/v1/knowledge-bases/${kb.id}/documents`, 'GET');
      const docs = Array.isArray(docsResult.data) ? docsResult.data : [];

      // Filter: in /sources/, status ready, NOT in /_personal/
      const sourceDocs = docs.filter((d: any) =>
        d.path?.includes('/sources/') &&
        d.status === 'ready' &&
        !d.path?.includes('/_personal/'),
      );

      if (sourceDocs.length === 0) {
        this.logger.debug('No enterprise source documents found');
        return;
      }

      // Check if there are new sources since last enterprise compilation
      const wikiDocs = docs.filter((d: any) =>
        d.path === '/wiki/' && d.filename === 'overview.md' && !d.path?.includes('/_personal/'),
      );
      const existingOverview = wikiDocs[0];
      const lastCompileTime = existingOverview?.updated_at ? new Date(existingOverview.updated_at) : new Date(0);

      const newSourceDocs = sourceDocs.filter((d: any) =>
        new Date(d.created_at) > lastCompileTime || new Date(d.updated_at) > lastCompileTime,
      );

      if (newSourceDocs.length === 0) {
        this.logger.debug('No new enterprise source docs since last compilation');
        return;
      }

      // Read up to 30 most recent source doc contents (truncated to 2000 chars each)
      const sorted = sourceDocs.sort(
        (a: any, b: any) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime(),
      );
      const toProcess = sorted.slice(0, 30);

      const contents: string[] = [];
      for (const doc of toProcess) {
        const contentResult = await this.proxy(`/v1/documents/${doc.id}/content`, 'GET');
        if (contentResult.status === 200) {
          const text = typeof contentResult.data === 'string'
            ? contentResult.data
            : contentResult.data?.content || '';
          if (text.trim()) {
            contents.push(`### ${doc.title || doc.filename}\n\n${text.substring(0, 2000)}`);
          }
        }
      }

      if (contents.length === 0) return;

      // Resolve LLM config (same pattern as compileUserKnowledge)
      const modelConfigPath = path.join(this.workspace.getRoot(), 'config', 'models.json');
      let modelConfig: any = {};
      try { modelConfig = JSON.parse(fs.readFileSync(modelConfigPath, 'utf-8')); } catch {}

      const cloudProvider = modelConfig.cloudProvider || 'deepseek';
      const cloudModel = modelConfig.cloudModel || 'deepseek-chat';
      const apiKey = modelConfig.cloudApiKey || '';

      if (!apiKey) {
        this.logger.debug('Skipping enterprise compilation: no cloud API key');
        return;
      }

      const providers: Record<string, string> = {
        deepseek: 'https://api.deepseek.com/v1',
        openai: 'https://api.openai.com/v1',
        'silicon-flow': 'https://api.siliconflow.cn/v1',
        qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      };
      const baseUrl = providers[cloudProvider] || `https://api.${cloudProvider}.com/v1`;

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: cloudModel,
          messages: [{
            role: 'user',
            content: `将以下企业知识源文档整理为结构化的企业知识总览百科。
要求：
- 按业务领域和主题分章节，使用 Markdown 标题
- 合并相关内容，去除重复信息
- 突出关键业务流程、规则和决策要点
- 保留数据指标和关键事实
- 输出完整的 Markdown 文档

---
${contents.join('\n\n---\n\n')}`,
          }],
          max_tokens: 4096,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(60000),
      });

      if (!resp.ok) return;
      const data = await resp.json();
      const compiled = data.choices?.[0]?.message?.content?.trim();
      if (!compiled || compiled.length < 50) return;

      // Write enterprise wiki overview
      const today = new Date().toISOString().slice(0, 10);
      const overviewContent = `---\ntitle: 企业知识总览\ndescription: 自动整理的企业知识百科\ntags:\n  - enterprise\n  - compiled\ndate: ${today}\n---\n\n${compiled}`;

      await this.proxy(
        `/v1/knowledge-bases/${kb.id}/documents/note`, 'POST',
        { filename: 'overview.md', path: '/wiki/', content: overviewContent },
      );

      this.logger.log(`Compiled enterprise knowledge: ${contents.length} source docs → /wiki/overview.md`);
    } catch (err: any) {
      this.logger.debug(`Enterprise knowledge compilation skipped: ${err.message}`);
    } finally {
      this.compiling = false;
    }
  }
}
