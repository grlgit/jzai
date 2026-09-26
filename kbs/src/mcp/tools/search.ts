/**
 * 对译 mcp/tools/search.py — list/search/references/digest 四模式。
 * file_search 模式不移植（SEARCH_MODE=db 为 pg_local 唯一实用路径，P5 候选）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, createVaultFS } from './index';
import { deepLink, globMatch, resolvePath, MAX_LIST, MAX_SEARCH } from './helpers';
import { PgLocalVaultFS } from '../vaultfs/pg-local';
import {
  ensureTaxonomyLoaded,
  expandQueryOrGroups,
  hasExpansion,
  classifyQuery,
  getFlatCategories,
  getAllTags,
  resolveCategoryTree,
} from './taxonomy';

const CONTEXT_CHARS = 120;

function extractSnippet(content: string, query: string): string {
  if (!content) return '(empty)';
  const idx = content.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, CONTEXT_CHARS * 2).trim();
  const start = Math.max(0, idx - CONTEXT_CHARS);
  const end = Math.min(content.length, idx + query.length + CONTEXT_CHARS);
  let snippet = content.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < content.length) snippet = snippet + '...';
  return snippet;
}

function fmtDate(val: any, fmt: '%Y-%m-%d' | '%m-%d' = '%Y-%m-%d'): string {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  if (Number.isNaN(d.getTime())) return String(val);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return fmt === '%m-%d' ? `${mm}-${dd}` : `${d.getFullYear()}-${mm}-${dd}`;
}

class SearchHandler {
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
    return this.kb.slug;
  }

  async listDocuments(target: string, tags: string[] | null): Promise<string> {
    let docs = await this.fs.listDocuments(this.kbId, this.scopes);

    if (!['*', '**', '**/*'].includes(target)) {
      const globPat = target.startsWith('/') ? target : '/' + target.replace(/^\//, '');
      docs = docs.filter((d) => globMatch(d.path + d.filename, globPat));
    }
    if (tags && tags.length > 0) {
      const tagSet = new Set(tags.map((t) => t.toLowerCase()));
      docs = docs.filter((d) => {
        const docTags = new Set(((d.tags || []) as string[]).map((t) => t.toLowerCase()));
        return [...tagSet].every((t) => docTags.has(t));
      });
    }

    if (docs.length === 0) return `No matches for \`${target}\` in ${this.slug}.`;

    const sources = docs.filter((d) => !d.path.startsWith('/wiki/'));
    const wikiPages = docs.filter((d) => d.path.startsWith('/wiki/'));

    let compileStatus: Record<string, string> = {};
    try {
      compileStatus = await this.fs.getSourceCompilationStatus(this.kbId);
    } catch {
      /* ignore */
    }

    const lines = [`**${this.kb.name}** (\`${target}\`):\n`];

    if (sources.length > 0) {
      lines.push(`**Sources (${sources.length}):**`);
      for (const doc of sources.slice(0, MAX_LIST)) {
        const status = compileStatus[String(doc.id)] || 'uncited';
        const label = status === 'current' ? '[已编译]' : status === 'needs_update' ? '[需更新]' : '[未编译]';
        lines.push(this.formatSourceLine(doc) + ` ${label}`);
      }
      if (sources.length > MAX_LIST) lines.push(`  ... ${sources.length - MAX_LIST} more`);
    }

    if (wikiPages.length > 0) {
      if (sources.length > 0) lines.push('');
      lines.push(`**Wiki (${wikiPages.length} pages):**`);
      for (const doc of wikiPages.slice(0, MAX_LIST)) {
        lines.push(this.formatWikiLine(doc));
      }
    }

    return lines.join('\n');
  }

  async searchChunks(query: string, path: string, tags: string[] | null, limit: number): Promise<string> {
    const pathFilter = this.pathFilterKey(path);

    await ensureTaxonomyLoaded();
    // 同义词展开（AND-of-OR 词组 SQL；无展开时整串 ILIKE，与 Python 一致）
    const orGroups = hasExpansion(query) ? expandQueryOrGroups(query) : undefined;
    const routedCategories = classifyQuery(query);

    let matches = await this.fs.searchChunksHybrid(
      this.kbId,
      query,
      limit,
      pathFilter,
      this.scopes,
      orGroups,
    );

    if (tags && tags.length > 0) {
      const tagSet = new Set(tags.map((t) => t.toLowerCase()));
      matches = matches.filter((m) => {
        const mTags = new Set(((m.tags || []) as string[]).map((t) => t.toLowerCase()));
        return [...tagSet].every((t) => mTags.has(t));
      });
    }

    // 语义路由 category boost
    if (routedCategories.length > 0 && matches.length > 0) {
      const boost = (m: any): number => {
        const matchPath = (m.path || '').toLowerCase();
        for (const catPath of routedCategories) {
          for (const segment of catPath.toLowerCase().split('/')) {
            if (segment && matchPath.includes(segment)) return 1.0;
          }
        }
        return 0.0;
      };
      matches = matches
        .map((m) => ({ ...m, _boost: boost(m) }))
        .sort((a, b) => (b.score || 0) + (b._boost || 0) - ((a.score || 0) + (a._boost || 0)));
    }

    if (matches.length === 0) {
      const hint = routedCategories.length > 0 ? ` (检测到相关领域: ${routedCategories.join(', ')})` : '';
      return `No matches for \`${query}\` in ${this.slug}.${hint}`;
    }

    const lines = [`**${matches.length} result(s)** for \`${query}\`:\n`];
    if (routedCategories.length > 0) {
      lines.push(`*语义路由: ${routedCategories.join(', ')}*\n`);
    }
    for (const m of matches) {
      lines.push(this.formatSearchResult(m, query));
    }

    try {
      const suggestions = this.suggestRelatedTopics(query, matches, routedCategories);
      if (suggestions.length > 0) {
        lines.push(`\n---\n**你可能还想搜索：** ${suggestions.join(', ')}`);
      }
    } catch {
      /* ignore */
    }

    return lines.join('\n');
  }

  async queryReferences(path: string, query: string): Promise<string> {
    if (query === 'uncited') return this.findUncited();
    if (query === 'stale') return this.findStale();
    if (query === 'conflicts') return 'Conflict detection not available.';
    return this.documentReferences(path);
  }

  private async findUncited(): Promise<string> {
    const rows = await this.fs.findUncitedSources(this.kbId, this.scopes);
    if (rows.length === 0) return 'All sources are cited in at least one wiki page.';
    const lines = [`**${rows.length} uncited source(s)** — not referenced by any wiki page:\n`];
    for (const r of rows) lines.push(`  ${r.path}${r.filename} (${r.file_type})`);
    return lines.join('\n');
  }

  private async findStale(): Promise<string> {
    const rows = await this.fs.findStalePages(this.kbId, this.scopes);
    if (rows.length === 0) return 'No stale pages found.';
    const lines = [`**${rows.length} potentially stale page(s)** — a page they reference was updated:\n`];
    for (const r of rows) {
      const title = r.title || r.filename;
      const stale = r.stale_since ? fmtDate(r.stale_since) : '?';
      lines.push(`  ${r.path}${r.filename} (${title}) — stale since ${stale}`);
    }
    return lines.join('\n');
  }

  private async documentReferences(path: string): Promise<string> {
    if (!path || path === '*' || path === '**') {
      return 'references mode requires a `path` to a specific document, or `query="uncited"` / `query="stale"`.';
    }
    const [dirPath, filename] = resolvePath(path);
    const doc = await this.fs.getDocument(this.kbId, filename, dirPath);
    if (!doc) return `Document '${path}' not found.`;

    const docId = String(doc.id);
    const forward = await this.fs.getForwardReferences(docId);
    const backlinks = await this.fs.getBacklinks(docId);

    const title = doc.title || doc.filename;
    const lines = [`**References for ${title}** (\`${dirPath}${filename}\`):\n`];

    if (forward.length > 0) {
      const cites = forward.filter((r) => r.reference_type === 'cites');
      const links = forward.filter((r) => r.reference_type === 'links_to');
      if (cites.length > 0) {
        lines.push(`**Cites (${cites.length} sources):**`);
        for (const r of cites) {
          lines.push(`  ${r.path}${r.filename}${r.page ? `, p.${r.page}` : ''}`);
        }
      }
      if (links.length > 0) {
        lines.push(`\n**Links to (${links.length} pages):**`);
        for (const r of links) {
          lines.push(`  ${r.path}${r.filename} (${r.title || r.filename})`);
        }
      }
    } else {
      lines.push('No outgoing references.');
    }

    lines.push('');
    if (backlinks.length > 0) {
      lines.push(`**Referenced by (${backlinks.length} pages):**`);
      for (const r of backlinks) {
        const ref = r.reference_type === 'cites' ? 'cites' : 'links to';
        lines.push(`  ${r.path}${r.filename} (${r.title || r.filename}) — ${ref}`);
      }
    } else {
      lines.push('No incoming references (backlinks).');
    }

    return lines.join('\n');
  }

  async generateDigest(): Promise<string> {
    const docs = await this.fs.listDocuments(this.kbId, this.scopes);
    if (docs.length === 0) return `知识库 **${this.kb.name}** 当前为空。`;

    const wikiDocs = docs.filter(
      (d) => d.path.startsWith('/wiki/') && !d.path.startsWith('/wiki/_'),
    );
    const sourceDocs = docs.filter((d) => !d.path.startsWith('/wiki/'));

    const categoryCounts = new Map<string, number>();
    for (const d of wikiDocs) {
      const parts = (d.path as string).replace(/^\/|\/$/g, '').split('/');
      const cat = parts.length > 1 ? parts[1] : '(根)';
      categoryCounts.set(cat, (categoryCounts.get(cat) || 0) + 1);
    }

    await ensureTaxonomyLoaded();
    const allTags = getAllTags();
    const categoryTree = resolveCategoryTree();

    const readyDocs = docs
      .filter((d) => !d.path.startsWith('/wiki/_'))
      .sort((a, b) => {
        const da = new Date(a.updated_at || a.created_at || 0).getTime();
        const db = new Date(b.updated_at || b.created_at || 0).getTime();
        return db - da;
      })
      .slice(0, 5);

    const lines = [`**${this.kb.name}** — ${wikiDocs.length} 百科页 / ${sourceDocs.length} 源文档\n`];

    if (categoryCounts.size > 0) {
      lines.push('**知识领域：**');
      for (const [cat, count] of [...categoryCounts.entries()].sort((a, b) => b[1] - a[1])) {
        lines.push(`  - ${cat} (${count}篇)`);
      }
    }
    if (categoryTree) {
      const treeLines = categoryTree.split('\n').slice(0, 15);
      lines.push('\n**分类体系：**');
      for (const l of treeLines) lines.push(`  ${l}`);
    }
    if (allTags.size > 0) {
      lines.push(`**标签：** ${[...allTags].sort().slice(0, 20).join(', ')}`);
    }
    if (readyDocs.length > 0) {
      lines.push('\n**最近更新：**');
      for (const d of readyDocs) {
        const title = d.title || d.filename;
        lines.push(`  - ${title} (${fmtDate(d.updated_at || d.created_at, '%m-%d')})`);
      }
    }

    let digest = lines.join('\n');
    if (digest.length > 1500) digest = digest.slice(0, 1497) + '...';
    return digest;
  }

  private suggestRelatedTopics(query: string, matches: any[], routedCategories: string[]): string[] {
    const suggestions: string[] = [];
    const seen = new Set([query.toLowerCase()]);

    const flatCats = getFlatCategories();
    for (const routed of routedCategories) {
      const parts = routed.split('/');
      const parent = parts.slice(0, -1).join('/');
      for (const cat of flatCats) {
        const catParts = cat.path.split('/');
        const catParent = catParts.slice(0, -1).join('/');
        if (catParent === parent && cat.path !== routed) {
          if (!seen.has(cat.name.toLowerCase())) {
            suggestions.push(cat.name);
            seen.add(cat.name.toLowerCase());
          }
        }
      }
    }

    for (const m of matches.slice(0, 5)) {
      for (const tag of (m.tags || []) as string[]) {
        if (!seen.has(tag.toLowerCase()) && !query.toLowerCase().includes(tag.toLowerCase())) {
          suggestions.push(tag);
          seen.add(tag.toLowerCase());
        }
      }
    }

    return suggestions.slice(0, 5);
  }

  private pathFilterKey(path: string): string | null {
    if (['*', '**', '**/*'].includes(path)) return null;
    if (path.startsWith('/wiki')) return 'wiki';
    if (path === '/' || path === '/*') return 'sources';
    return null;
  }

  private formatSourceLine(doc: any): string {
    const tagStr = doc.tags && doc.tags.length > 0 ? ` [${doc.tags.join(', ')}]` : '';
    const datePart = doc.updated_at ? `, ${fmtDate(doc.updated_at)}` : '';
    const pagesPart = doc.page_count ? `, ${doc.page_count}p` : '';
    return `  ${doc.path}${doc.filename} (${doc.file_type || ''}${pagesPart}${datePart})${tagStr}`;
  }

  private formatWikiLine(doc: any): string {
    const datePart = doc.updated_at ? `, ${fmtDate(doc.updated_at)}` : '';
    return `  ${doc.path}${doc.filename}${datePart}`;
  }

  private formatSearchResult(match: any, query: string): string {
    const filepath = `${match.path}${match.filename}`;
    const pageStr = match.page ? ` (p.${match.page})` : '';
    const breadcrumb = match.header_breadcrumb ? `\n  ${match.header_breadcrumb}` : '';
    const snippet = extractSnippet(match.content || '', query);
    const link = deepLink(this.ctx.appUrl, this.slug, match.path, match.filename);
    const score = match.score || 0;
    const scoreStr = score ? ` [${score.toFixed(1)}]` : '';
    return `**${filepath}**${pageStr}${scoreStr} — [view](${link})${breadcrumb}\n\`\`\`\n${snippet}\n\`\`\`\n`;
  }
}

async function listAllKbs(fs: PgLocalVaultFS): Promise<string> {
  const kbs = await fs.listKnowledgeBases();
  if (kbs.length === 0) return 'No knowledge bases found.';
  const lines = ['**Knowledge Bases:**\n'];
  for (const kb of kbs) lines.push(`  ${kb.slug}/ — ${kb.name}`);
  return lines.join('\n');
}

const DESCRIPTION =
  'Browse or search the knowledge vault.\n\n' +
  'Sources (raw documents) live at `/`. Wiki pages (LLM-compiled) live at `/wiki/`.\n\n' +
  'Modes:\n' +
  '- list: browse files and folders\n' +
  '- search: keyword search across document content (searches chunks for precise results with page numbers)\n' +
  '- references: query the citation/link graph for a document\n' +
  '- digest: compact knowledge base summary (categories, tags, recent docs) for context injection\n\n' +
  'References mode examples:\n' +
  '- `search(mode="references", path="/wiki/concepts/scaling.md")` — what it cites + what links to it\n' +
  '- `search(mode="references", path="paper.pdf")` — which wiki pages cite this source\n' +
  '- `search(mode="references", query="uncited")` — sources with no wiki citations\n' +
  '- `search(mode="references", query="stale")` — pages flagged as potentially stale\n\n' +
  'Use `path` to scope: `*` for root, `/wiki/**` for wiki only, `*.pdf` for PDFs, etc.\n' +
  'Use `tags` to filter by document tags.';

export function registerSearch(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'search',
    {
      description: DESCRIPTION,
      inputSchema: {
        knowledge_base: z.string().describe('KB slug (call guide to discover)'),
        mode: z.enum(['list', 'search', 'references', 'digest']).default('list'),
        query: z.string().default(''),
        path: z.string().default('*'),
        tags: z.array(z.string()).optional(),
        limit: z.number().default(10),
        user_email: z.string().default(''),
        scopes: z.array(z.string()).optional(),
      },
    },
    async ({ knowledge_base, mode, query, path, tags, limit, user_email, scopes }) => {
      const fs = createVaultFS(ctx);

      if (!knowledge_base) {
        return { content: [{ type: 'text' as const, text: await listAllKbs(fs) }] };
      }
      const kb = await fs.resolveKb(knowledge_base);
      if (!kb) {
        return { content: [{ type: 'text' as const, text: `Knowledge base '${knowledge_base}' not found.` }] };
      }

      const resolvedScopes = await fs.accessibleScopes(user_email || null, scopes ?? null);
      const handler = new SearchHandler(ctx, fs, kb, resolvedScopes);

      let text: string;
      if (mode === 'list') {
        text = await handler.listDocuments(path, tags ?? null);
      } else if (mode === 'search') {
        if (!query) text = 'search mode requires a query.';
        else text = await handler.searchChunks(query, path, tags ?? null, Math.min(limit, MAX_SEARCH));
      } else if (mode === 'references') {
        text = await handler.queryReferences(path, query);
      } else if (mode === 'digest') {
        text = await handler.generateDigest();
      } else {
        text = `Unknown mode: ${mode}`;
      }
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
