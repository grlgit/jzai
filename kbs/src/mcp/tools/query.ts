/**
 * 对译 mcp/tools/query.py — 全文知识检索（返回完整文档内容）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, createVaultFS } from './index';
import { deepLink } from './helpers';
import { PgLocalVaultFS } from '../vaultfs/pg-local';

const MAX_CONTENT_CHARS = 120_000;
const MAX_PER_DOC_CHARS = 30_000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n... (truncated, ${text.length - limit} chars omitted)`;
}

function stripFrontmatter(content: string): string {
  if (content.startsWith('---')) {
    const end = content.indexOf('---', 3);
    if (end !== -1) return content.slice(end + 3).replace(/^\n+/, '');
  }
  return content;
}

class QueryHandler {
  constructor(
    private readonly ctx: ToolContext,
    private readonly fs: PgLocalVaultFS,
    private readonly kb: any,
    private readonly scopes: Set<string> | null,
  ) {}

  private get kbId() {
    return String(this.kb.id);
  }
  private get slug() {
    return this.kb.slug || this.kb.name;
  }

  async retrieve(query: string, scope: string, limit: number, includeReferences: boolean): Promise<string> {
    const pathFilter = this.scopeToFilter(scope);

    let docs = await this.fs.searchDocumentsFull(this.kbId, query, limit, pathFilter, this.scopes);

    if (docs.length === 0) {
      const keywords = query.split(/\s+/).filter((k) => k.trim().length > 0);
      docs = await this.fs.searchDocumentsByContent(this.kbId, keywords, limit, pathFilter, this.scopes);
    }

    if (docs.length === 0) {
      return `No results found for "${query}" in knowledge base "${this.slug}".`;
    }

    const lines = [`**${docs.length} result(s)** for "${query}" in **${this.kb.name}**:\n`];

    let totalChars = 0;
    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const content: string = doc.content || '';
      const title = doc.title || doc.filename;
      const filepath = `${doc.path}${doc.filename}`;
      const link = deepLink(this.ctx.appUrl, this.slug, doc.path, doc.filename);
      const tags: string[] = doc.tags || [];
      const tagStr = tags.length > 0 ? `  Tags: ${tags.join(', ')}` : '';

      const remaining = MAX_CONTENT_CHARS - totalChars;
      if (remaining <= 0) {
        lines.push(`\n---\n*Budget exceeded — ${docs.length - i} more results omitted.*`);
        break;
      }

      const docLimit = Math.min(MAX_PER_DOC_CHARS, remaining);
      const displayContent = truncate(stripFrontmatter(content), docLimit);
      totalChars += displayContent.length;

      lines.push('---');
      lines.push(`### ${title}`);
      lines.push(`**Path:** \`${filepath}\` — [view](${link})${tagStr}`);
      lines.push('');
      lines.push(displayContent);

      if (includeReferences) {
        const refLines = await this.getRefSummary(String(doc.id));
        if (refLines.length > 0) {
          lines.push('');
          lines.push(...refLines);
        }
      }
    }

    return lines.join('\n');
  }

  async retrieveByTags(tags: string[], scope: string, limit: number): Promise<string> {
    let docs = await this.fs.listDocumentsWithContent(this.kbId, this.scopes);

    if (scope === 'wiki') docs = docs.filter((d) => d.path.startsWith('/wiki/'));
    else if (scope === 'sources') docs = docs.filter((d) => !d.path.startsWith('/wiki/'));

    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    docs = docs.filter((d) => {
      const docTags = new Set(((d.tags || []) as string[]).map((t) => t.toLowerCase()));
      return [...tagSet].every((t) => docTags.has(t));
    });

    if (docs.length === 0) return `No documents found with tags [${tags.join(', ')}].`;

    docs = docs.slice(0, limit);
    const lines = [`**${docs.length} document(s)** with tags [${tags.join(', ')}]:\n`];

    let totalChars = 0;
    for (const doc of docs) {
      const content: string = doc.content || '';
      const title = doc.title || doc.filename;
      const filepath = `${doc.path}${doc.filename}`;
      const link = deepLink(this.ctx.appUrl, this.slug, doc.path, doc.filename);

      const remaining = MAX_CONTENT_CHARS - totalChars;
      if (remaining <= 0) {
        lines.push('\n---\n*Budget exceeded — more results omitted.*');
        break;
      }

      const docLimit = Math.min(MAX_PER_DOC_CHARS, remaining);
      const displayContent = truncate(stripFrontmatter(content), docLimit);
      totalChars += displayContent.length;

      lines.push('---');
      lines.push(`### ${title}`);
      lines.push(`**Path:** \`${filepath}\` — [view](${link})`);
      lines.push('');
      lines.push(displayContent);
    }

    return lines.join('\n');
  }

  private async getRefSummary(docId: string): Promise<string[]> {
    const forward = await this.fs.getForwardReferences(docId);
    const backlinks = await this.fs.getBacklinks(docId);

    const lines: string[] = [];
    if (forward.length > 0) {
      const cites = forward.filter((r) => r.reference_type === 'cites');
      const links = forward.filter((r) => r.reference_type === 'links_to');
      const parts: string[] = [];
      if (cites.length > 0) parts.push(`cites ${cites.length} source(s)`);
      if (links.length > 0) {
        parts.push(
          `links to ${links.length} page(s): ` +
            links.slice(0, 5).map((r) => `\`${r.path}${r.filename}\``).join(', '),
        );
      }
      if (parts.length > 0) lines.push(`**References:** ${parts.join('; ')}`);
    }
    if (backlinks.length > 0) {
      lines.push(
        '**Referenced by:** ' +
          backlinks.slice(0, 5).map((r) => `\`${r.path}${r.filename}\``).join(', '),
      );
    }
    return lines;
  }

  private scopeToFilter(scope: string): string | null {
    if (scope === 'wiki') return 'wiki';
    if (scope === 'sources') return 'sources';
    return null;
  }
}

const DESCRIPTION =
  'Retrieve knowledge from the wiki — returns full document content, not just snippets.\n\n' +
  'Use this tool when you need to:\n' +
  '- Look up standards, specifications, or procedures documented in the wiki\n' +
  '- Find detailed information about a customer, product, or concept\n' +
  '- Gather context from the knowledge base to complete a task\n' +
  '- Answer questions using information stored in wiki pages\n\n' +
  'Unlike `search` (which returns short snippets for browsing), `query` returns the ' +
  'complete content of matching wiki pages so you can extract precise answers.\n\n' +
  'Examples:\n' +
  '- `query(query="客户A生产标准")` — retrieve production standards for customer A\n' +
  '- `query(query="焊接工艺参数", scope="wiki")` — get welding process parameters from wiki pages\n' +
  '- `query(tags=["质量标准", "客户A"])` — retrieve all docs tagged with both tags\n' +
  '- `query(query="packaging requirements", include_references=true)` — include related page links';

export function registerQuery(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'query',
    {
      description: DESCRIPTION,
      inputSchema: {
        knowledge_base: z.string(),
        query: z.string().default(''),
        tags: z.array(z.string()).optional(),
        scope: z.enum(['all', 'wiki', 'sources']).default('wiki'),
        limit: z.number().default(5),
        include_references: z.boolean().default(false),
        user_email: z.string().default(''),
      },
    },
    async ({ knowledge_base, query, tags, scope, limit, include_references, user_email }) => {
      const fs = createVaultFS(ctx);

      if (!knowledge_base) {
        return { content: [{ type: 'text' as const, text: 'Please specify a knowledge_base name.' }] };
      }
      const kb = await fs.resolveKb(knowledge_base);
      if (!kb) {
        return { content: [{ type: 'text' as const, text: `Knowledge base '${knowledge_base}' not found.` }] };
      }

      const scopes = await fs.accessibleScopes(user_email || null, null);
      const handler = new QueryHandler(ctx, fs, kb, scopes);
      const effectiveLimit = Math.min(limit, 10);

      let text: string;
      if (tags && tags.length > 0 && !query) {
        text = await handler.retrieveByTags(tags, scope, effectiveLimit);
      } else if (!query) {
        text = 'Please provide a `query` or `tags` to search.';
      } else {
        text = await handler.retrieve(query, scope, effectiveLimit, include_references);
      }
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
