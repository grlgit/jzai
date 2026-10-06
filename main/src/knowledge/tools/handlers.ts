/**
 * 知识库工具处理器（移植自 kbs/src/mcp/tools/{search,read,write,delete,query}.ts）。
 * 去 MCP 传输层，改为内部类；空间语义替代原静态单例 KB。
 */
import { VaultFS } from '../vaultfs/vaultfs.service';
import { TaxonomyService } from '../taxonomy/taxonomy.service';
import { KbSpace } from '../spaces.service';
import { deepLink, globMatch, resolvePath, parsePageRange, MAX_LIST, MAX_SEARCH } from './helpers';
import { updateReferences, getBacklinksSummary } from './references';
import { parseFrontmatter } from '../shared/frontmatter';

export interface HandlerContext {
  appUrl: string;
  taxonomy: TaxonomyService;
}

const CONTEXT_CHARS = 120;
const MAX_BATCH_CHARS = 120_000;
const MAX_CONTENT_CHARS = 120_000;
const MAX_PER_DOC_CHARS = 30_000;

const IMG_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const PAGE_TYPES = new Set(['pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'csv']);
const SPREADSHEET_TYPES = new Set(['xlsx', 'xls', 'csv']);
const TEXT_TYPES = new Set(['md', 'txt', 'csv', 'html', 'svg', 'json', 'xml']);

const ASSET_EXTENSIONS = new Set(['.svg', '.csv', '.json', '.xml', '.html', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
const FILE_EXT_RE = /\.(md|txt|svg|csv|json|xml|html)$/i;
const CONTEXT_LINES = 5;

const LAYER_LIMITS: Record<string, { maxDocs: number; maxChars: number }> = {
  _character: { maxDocs: 3, maxChars: 8000 },
  _rules: { maxDocs: 10, maxChars: 20000 },
};

const PROTECTED_FILENAMES = new Set(['overview.md', 'log.md']);

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

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

function extractMetadata(meta: Record<string, any>): [string | null, Record<string, any>] {
  let dateStr: string | null = null;
  if ('date' in meta) {
    const d = meta.date;
    dateStr = d instanceof Date ? d.toISOString() : String(d);
  }
  const metadata: Record<string, any> = {};
  if (typeof meta.description === 'string' && meta.description.trim()) {
    metadata.description = meta.description.trim();
  }
  return [dateStr, metadata];
}

function extractSections(content: string, sectionNames: string[]): string {
  const lines = content.split('\n');
  const sections: Array<[string, string]> = [];
  let currentSection: string | null = null;
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('#')) {
      if (currentSection && currentLines.length > 0) {
        sections.push([currentSection, currentLines.join('\n')]);
      }
      currentSection = line.replace(/^#+/, '').trim();
      currentLines = [line];
    } else if (currentSection) {
      currentLines.push(line);
    }
  }
  if (currentSection && currentLines.length > 0) {
    sections.push([currentSection, currentLines.join('\n')]);
  }

  const wanted = new Set(sectionNames.map((s) => s.toLowerCase()));
  const matched = sections.filter(([name]) => wanted.has(name.toLowerCase())).map(([, text]) => text);
  if (matched.length === 0) return `No sections matching ${JSON.stringify(sectionNames)} found.`;
  return matched.join('\n\n');
}

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

// ── Search ────────────────────────────────────────────────────────────────

export class SearchHandler {
  constructor(
    private readonly ctx: HandlerContext,
    private readonly fs: VaultFS,
    private readonly space: KbSpace,
    private readonly scopes: Set<string> | null,
  ) {}

  private get spaceId() {
    return String(this.space.id);
  }
  private get slug() {
    return this.space.slug;
  }

  async listDocuments(target: string, tags: string[] | null): Promise<string> {
    let docs = await this.fs.listDocuments(this.scopes);

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
      compileStatus = await this.fs.getSourceCompilationStatus();
    } catch {
      /* ignore */
    }

    const lines = [`**${this.space.name}** (\`${target}\`):\n`];

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

    await this.ctx.taxonomy.ensureLoaded(this.spaceId);
    const orGroups = this.ctx.taxonomy.hasExpansion(this.spaceId, query)
      ? this.ctx.taxonomy.expandQueryOrGroups(this.spaceId, query)
      : undefined;
    const routedCategories = this.ctx.taxonomy.classifyQuery(this.spaceId, query);

    let matches = await this.fs.searchChunksHybrid(query, limit, pathFilter, this.scopes, orGroups);

    if (tags && tags.length > 0) {
      const tagSet = new Set(tags.map((t) => t.toLowerCase()));
      matches = matches.filter((m) => {
        const mTags = new Set(((m.tags || []) as string[]).map((t) => t.toLowerCase()));
        return [...tagSet].every((t) => mTags.has(t));
      });
    }

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
    const rows = await this.fs.findUncitedSources(this.scopes);
    if (rows.length === 0) return 'All sources are cited in at least one wiki page.';
    const lines = [`**${rows.length} uncited source(s)** — not referenced by any wiki page:\n`];
    for (const r of rows) lines.push(`  ${r.path}${r.filename} (${r.file_type})`);
    return lines.join('\n');
  }

  private async findStale(): Promise<string> {
    const rows = await this.fs.findStalePages(this.scopes);
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
    const doc = await this.fs.getDocument(filename, dirPath);
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
    const docs = await this.fs.listDocuments(this.scopes);
    if (docs.length === 0) return `知识库 **${this.space.name}** 当前为空。`;

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

    await this.ctx.taxonomy.ensureLoaded(this.spaceId);
    const allTags = this.ctx.taxonomy.getAllTags(this.spaceId);
    const categoryTree = this.ctx.taxonomy.resolveCategoryTree(this.spaceId);

    const readyDocs = docs
      .filter((d) => !d.path.startsWith('/wiki/_'))
      .sort((a, b) => {
        const da = new Date(a.updated_at || a.created_at || 0).getTime();
        const db = new Date(b.updated_at || b.created_at || 0).getTime();
        return db - da;
      })
      .slice(0, 5);

    const lines = [`**${this.space.name}** — ${wikiDocs.length} 百科页 / ${sourceDocs.length} 源文档\n`];

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

    const flatCats = this.ctx.taxonomy.getFlatCategories(this.spaceId);
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

// ── Read ──────────────────────────────────────────────────────────────────

export class ReadHandler {
  constructor(
    private readonly ctx: HandlerContext,
    private readonly fs: VaultFS,
    private readonly space: KbSpace,
  ) {}

  private get slug() {
    return this.space.slug;
  }

  async read(path: string, pages: string, sections: string[] | null, includeImages: boolean): Promise<string | ContentBlock[]> {
    if (path.includes('*') || path.includes('?')) {
      return this.readBatch(path);
    }
    return this.readSingle(path, pages, sections, includeImages);
  }

  private async readSingle(path: string, pages: string, sections: string[] | null, includeImages: boolean): Promise<string | ContentBlock[]> {
    const doc = await this.fetchDocument(path);
    if (!doc) return `Document '${path}' not found in ${this.slug}.`;

    const header = this.buildHeader(doc);
    const fileType = doc.file_type || '';

    if (IMAGE_TYPES.has(fileType)) return this.readImage(doc, header, includeImages);
    if (PAGE_TYPES.has(fileType) && pages) return this.readPages(doc, header, pages, includeImages);
    if (SPREADSHEET_TYPES.has(fileType) && !pages) return this.readSpreadsheetIndex(doc, header);

    let content = doc.content || '';
    if (sections && sections.length > 0) {
      content = extractSections(content, sections);
    }
    const backlinks = await getBacklinksSummary(this.fs, String(doc.id));
    return header + content + backlinks;
  }

  private async readBatch(path: string): Promise<string> {
    let docs = await this.fs.listDocumentsWithContent();
    const globPat = path.startsWith('/') ? path : '/' + path.replace(/^\//, '');
    docs = docs.filter((d) => globMatch(d.path + d.filename, globPat));

    if (docs.length === 0) return `No documents matching \`${path}\` in ${this.slug}.`;

    const parts: string[] = [];
    let charsUsed = 0;
    let truncatedDocs = 0;
    const skippedDocs: any[] = [];

    for (const doc of docs) {
      if (charsUsed >= MAX_BATCH_CHARS) {
        skippedDocs.push(doc);
        continue;
      }
      const link = deepLink(this.ctx.appUrl, this.slug, doc.path, doc.filename);
      const ft = doc.file_type || '';
      const remaining = MAX_BATCH_CHARS - charsUsed;

      if (TEXT_TYPES.has(ft) && doc.content) {
        let content = doc.content as string;
        if (content.length > remaining) {
          content = content.slice(0, remaining) + '\n\n... (truncated)';
          truncatedDocs += 1;
        }
        parts.push(`### [${doc.path}${doc.filename}](${link})\n\n${content}`);
        charsUsed += content.length;
      } else if ((doc.page_count || 0) > 0) {
        const [pageText, docChars, pagesIncluded, wasTruncated] = await this.readBatchPages(doc, remaining);
        if (wasTruncated) truncatedDocs += 1;
        const totalPages = doc.page_count;
        const remainingPages = totalPages - pagesIncluded;
        const suffix =
          remainingPages > 0
            ? `\n\n*(${remainingPages} more pages — use \`pages="${pagesIncluded + 1}-${totalPages}"\` to continue)*`
            : '';
        parts.push(`### [${doc.path}${doc.filename}](${link}) (${totalPages} pages)\n\n${pageText}${suffix}`);
        charsUsed += docChars;
      } else {
        skippedDocs.push(doc);
      }
    }

    let header = `**${parts.length} document(s)** matching \`${path}\``;
    if (truncatedDocs > 0) header += ` (some truncated to fit ${MAX_BATCH_CHARS.toLocaleString()} char budget)`;
    if (skippedDocs.length > 0) header += `\n*${skippedDocs.length} more document(s) beyond budget — read individually*`;
    header += '\n\n---\n\n';

    return header + parts.join('\n\n---\n\n');
  }

  private async readPages(doc: any, header: string, pagesStr: string, includeImages: boolean): Promise<string | ContentBlock[]> {
    const maxPage = doc.page_count || 1;
    const pageNums = parsePageRange(pagesStr, maxPage);
    if (pageNums.length === 0) {
      return header + `Invalid page range: ${pagesStr} (document has ${maxPage} pages)`;
    }

    const pageRows = await this.fs.getPages(String(doc.id), pageNums);
    if (pageRows.length === 0) return header + `No page data found for pages ${pagesStr}.`;

    const blocks: ContentBlock[] = [{ type: 'text', text: header }];
    let hasImages = false;

    for (const row of pageRows) {
      blocks.push({ type: 'text', text: `**— Page ${row.page} —**\n\n${row.content}` });
      if (!includeImages) continue;
      const elements = row.elements;
      if (!elements || typeof elements !== 'object') continue;
      for (const imgMeta of elements.images || []) {
        const imgId = imgMeta?.id;
        if (!imgId) continue;
        const imgBytes = await this.fs.loadImageBytes(String(doc.id), imgId);
        if (imgBytes) {
          const fmt = /\.jpe?g$/.test(imgId) ? 'jpeg' : 'png';
          blocks.push({ type: 'image', data: imgBytes.toString('base64'), mimeType: IMG_MIME[fmt] });
          hasImages = true;
        }
      }
    }

    if (hasImages) return blocks;
    return blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n\n');
  }

  private async readSpreadsheetIndex(doc: any, header: string): Promise<string> {
    const pageRows = await this.fs.getAllPages(String(doc.id));
    if (pageRows.length === 0) return header + (doc.content || '(no data)');

    const lines = [header, '**Sheets:**\n'];
    for (const row of pageRows) {
      const elements = typeof row.elements === 'object' ? row.elements : null;
      const sheetName = elements?.sheet_name || `Sheet ${row.page}`;
      const rowCount = row.content ? (row.content.match(/\n/g) || []).length : 0;
      lines.push(`  Page ${row.page}: **${sheetName}** (~${rowCount} rows)`);
    }
    lines.push('\nUse `pages="1"` to read a specific sheet.');
    return lines.join('\n');
  }

  private async readImage(doc: any, header: string, includeImages: boolean): Promise<string | ContentBlock[]> {
    if (!includeImages) return header + '(Image file — set `include_images=true` to view)';
    const imgBytes = await this.fs.loadSourceBytes(doc);
    if (imgBytes) {
      const fileType = doc.file_type || 'png';
      const fmt = fileType === 'jpg' ? 'jpeg' : fileType;
      return [
        { type: 'text', text: header },
        { type: 'image', data: imgBytes.toString('base64'), mimeType: IMG_MIME[fmt] || `image/${fmt}` },
      ];
    }
    return header + '(Image could not be loaded)';
  }

  private async readBatchPages(doc: any, remaining: number): Promise<[string, number, number, boolean]> {
    const pageRows = await this.fs.getAllPages(String(doc.id));
    const pageParts: string[] = [];
    let docChars = 0;
    let pagesIncluded = 0;
    let truncated = false;

    for (const r of pageRows) {
      const pageText = `**— Page ${r.page} —**\n\n${r.content}`;
      if (docChars + pageText.length > remaining) {
        pageParts.push(pageText.slice(0, remaining - docChars) + '\n\n... (truncated)');
        truncated = true;
        pagesIncluded += 1;
        docChars = remaining;
        break;
      }
      pageParts.push(pageText);
      docChars += pageText.length;
      pagesIncluded += 1;
    }

    return [pageParts.join('\n\n'), docChars, pagesIncluded, truncated];
  }

  private async fetchDocument(path: string): Promise<any | null> {
    const [dirPath, filename] = resolvePath(path);
    let doc = await this.fs.getDocument(filename, dirPath);
    if (!doc) {
      const name = path.replace(/^\//, '').split('/').pop()!;
      doc = await this.fs.findDocumentByName(name);
    }
    return doc;
  }

  private buildHeader(doc: any): string {
    const tagsStr = doc.tags && doc.tags.length > 0 ? doc.tags.join(', ') : 'none';
    const link = deepLink(this.ctx.appUrl, this.slug, doc.path, doc.filename);
    let header =
      `**${doc.title || doc.filename}**\n` +
      `Type: ${doc.file_type || ''} | Tags: ${tagsStr} | Version: ${doc.version ?? 0}`;
    if (doc.page_count) header += ` | Pages: ${doc.page_count}`;
    header += `\n[View](${link})\n\n---\n\n`;
    return header;
  }
}

// ── Write ─────────────────────────────────────────────────────────────────

export class WriteHandler {
  constructor(
    private readonly ctx: HandlerContext,
    private readonly fs: VaultFS,
    private readonly space: KbSpace,
  ) {}

  async create(
    path: string,
    title: string,
    content: string,
    tags: string[],
    dateStr: string,
    overwrite: boolean,
  ): Promise<string> {
    if (!title) return 'Error: title is required when creating a note.';
    if (!tags || tags.length === 0) return 'Error: at least one tag is required when creating a note.';

    const dirPath = this.toDirPath(path);

    for (const [layerName, limits] of Object.entries(LAYER_LIMITS)) {
      if (dirPath.includes(`/${layerName}/`)) {
        const existingDocs = await this.fs.listDocuments();
        const layerDocs = existingDocs.filter((d) =>
          ((d.path || '') + (d.filename || '')).includes(`/${layerName}/`),
        );
        if (!overwrite && layerDocs.length >= limits.maxDocs) {
          return `Error: ${layerName}/ 目录已达上限 (${limits.maxDocs} 篇)。请编辑现有文档或删除旧文档后再添加。`;
        }
        if (content.length > limits.maxChars) {
          return `Error: ${layerName}/ 目录单篇内容不超过 ${limits.maxChars} 字符 (当前 ${content.length} 字符)。请精简内容。`;
        }
        break;
      }
    }

    const [filename, fileType] = this.titleToFilename(title);
    title = this.humanizeTitle(title);

    const existing = await this.fs.getDocument(filename, dirPath);

    if (!existing && !overwrite) {
      const similar = await this.fs.findDocumentByName(title);
      if (similar) {
        const similarPath = (similar.path || '/') + similar.filename;
        return (
          `Warning: 已存在相似文档「${similar.title || similar.filename}」（位于 ${similarPath}）。\n` +
          '如果这是更新版本，请使用 `overwrite=true`。' +
          '如果是不同文档，请更换标题后重试。'
        );
      }
    }

    if (existing && !overwrite) {
      return (
        `Error: \`${dirPath}${filename}\` already exists. ` +
        'Use `command="str_replace"` to edit it, or pass `overwrite=true` to replace it entirely.'
      );
    }

    if (!this.fs.writeToDisk(dirPath, filename, content)) {
      return `Error: invalid path \`${dirPath.replace(/^\//, '') + filename}\``;
    }

    const meta = parseFrontmatter(content);
    const [fmDate, fmMetadata] = extractMetadata(meta);

    let doc: any;
    if (existing) {
      await this.fs.updateDocument(String(existing.id), content, tags, title, fmDate, fmMetadata);
      doc = existing;
    } else {
      doc = await this.fs.createDocument(filename, title, dirPath, fileType, content, tags, fmDate, fmMetadata);
    }

    const docId = String(doc.id);
    await this.syncReferences(docId, content, dirPath, fileType);

    if (!dirPath.startsWith('/wiki/') && existing) {
      await this.fs.propagateStalenessFromSource(docId);
    }

    const impact = await this.getWikiImpact(docId, dirPath);
    return this.formatCreateResponse(title, tags, dirPath, filename, fileType, dateStr) + impact;
  }

  async edit(path: string, oldText: string, newText: string, tags: string[] | null): Promise<string> {
    if (!oldText) return 'Error: old_text is required for str_replace.';

    const [dirPath, filename] = resolvePath(path);
    const doc = await this.fs.getDocument(filename, dirPath);
    if (!doc) return `Document '${path}' not found.`;

    const content: string = doc.content || '';
    const count = content.split(oldText).length - 1;
    if (count === 0) return 'Error: no match found for old_text.';
    if (count > 1) {
      return `Error: found ${count} matches for old_text. Provide more context to match exactly once.`;
    }

    const replaceStart = content.indexOf(oldText);
    const newContent = content.slice(0, replaceStart) + newText + content.slice(replaceStart + oldText.length);

    this.fs.writeToDisk(dirPath, filename, newContent);
    const meta = parseFrontmatter(newContent);
    const [fmDate, fmMetadata] = extractMetadata(meta);
    await this.fs.updateDocument(String(doc.id), newContent, tags, null, fmDate, fmMetadata);

    const docId = String(doc.id);
    await this.syncReferences(docId, newContent, dirPath);

    const snippet = this.extractContext(newContent, replaceStart, newText.length);
    const impact = await this.getWikiImpact(docId, dirPath);
    return this.formatEditResponse(path, dirPath, filename, snippet) + impact;
  }

  async append(path: string, content: string, tags: string[] | null): Promise<string> {
    const [dirPath, filename] = resolvePath(path);
    const doc = await this.fs.getDocument(filename, dirPath);
    if (!doc) return `Document '${path}' not found.`;

    const newContent = (doc.content || '') + '\n\n' + content;

    this.fs.writeToDisk(dirPath, filename, newContent);
    const meta = parseFrontmatter(newContent);
    const [fmDate, fmMetadata] = extractMetadata(meta);
    await this.fs.updateDocument(String(doc.id), newContent, tags, null, fmDate, fmMetadata);

    const docId = String(doc.id);
    await this.syncReferences(docId, newContent, dirPath);

    const impact = await this.getWikiImpact(docId, dirPath);
    return this.formatAppendResponse(path, dirPath, filename) + impact;
  }

  private async syncReferences(docId: string, content: string, dirPath: string, fileType = 'md'): Promise<void> {
    if (dirPath.startsWith('/wiki/') && fileType === 'md') {
      await updateReferences(this.fs, docId, content, dirPath);
      await this.fs.propagateStaleness(docId);
    }
  }

  private async getWikiImpact(docId: string, dirPath: string): Promise<string> {
    if (!dirPath.startsWith('/wiki/')) return '';
    const rows = await this.fs.getBacklinks(docId);
    if (rows.length === 0) return '';
    const lines = [`\n**${rows.length} page(s) reference this document** — consider updating:`];
    for (const r of rows) {
      const title = r.title || r.filename;
      const ref = r.reference_type === 'cites' ? 'cites' : 'links to';
      lines.push(`  - \`${r.path}${r.filename}\` (${title}) — ${ref} this page`);
    }
    return '\n' + lines.join('\n');
  }

  private toDirPath(path: string): string {
    if (FILE_EXT_RE.test(path)) {
      const lastSlash = path.lastIndexOf('/');
      return lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '/';
    }
    let dirPath = path.endsWith('/') ? path : path + '/';
    if (!dirPath.startsWith('/')) dirPath = '/' + dirPath;
    return dirPath;
  }

  private titleToFilename(title: string): [string, string] {
    const lower = title.toLowerCase();
    for (const ext of ASSET_EXTENSIONS) {
      if (lower.endsWith(ext)) {
        return [this.slugifyFilename(lower), ext.slice(1)];
      }
    }
    const slug = lower.replace(/\.(md|txt)$/, '');
    let filename = this.slugifyFilename(slug);
    if (!filename.endsWith('.md')) filename += '.md';
    return [filename, 'md'];
  }

  private humanizeTitle(title: string): string {
    let clean = title.replace(/\.(md|txt|svg|csv|json|xml|html)$/i, '');
    if (clean === clean.toLowerCase() && clean.includes('-')) {
      clean = clean
        .replace(/[-_]/g, ' ')
        .trim()
        .replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
    }
    return clean;
  }

  private slugifyFilename(name: string): string {
    return name.replace(/\s/g, '-').replace(/[^\w\-.一-鿿]/g, '');
  }

  private extractContext(content: string, replaceStart: number, newTextLen: number): string {
    const lines = content.split('\n');
    const offsetToLine = (offset: number): number => {
      let charCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (charCount + lines[i].length >= offset) return i;
        charCount += lines[i].length + 1;
      }
      return lines.length - 1;
    };
    const startLine = offsetToLine(replaceStart);
    const endLine = offsetToLine(replaceStart + newTextLen);
    const ctxStart = Math.max(0, startLine - CONTEXT_LINES);
    const ctxEnd = Math.min(lines.length, endLine + CONTEXT_LINES + 1);
    const prefix = ctxStart > 0 ? '...' : '';
    const suffix = ctxEnd < lines.length ? '...' : '';
    return prefix + lines.slice(ctxStart, ctxEnd).join('\n') + suffix;
  }

  private formatCreateResponse(title: string, tags: string[], dirPath: string, filename: string, fileType: string, dateStr: string): string {
    const link = deepLink(this.ctx.appUrl, this.space.slug, dirPath, filename);
    const noteDate = dateStr || new Date().toISOString().slice(0, 10);
    let suffix = '';
    if (fileType !== 'md') {
      suffix = `\n\nEmbed in wiki pages with: \`![${title}](${filename})\``;
    } else if (dirPath.startsWith('/wiki/')) {
      suffix = '\n\nRemember to cite sources using footnotes: `[^1]: source-file.pdf, p.X`';
    }
    return (
      `Created **${title}** at \`${dirPath}${filename}\`\n` +
      `Tags: ${tags.join(', ')} | Date: ${noteDate}\n` +
      `[View](${link})${suffix}`
    );
  }

  private formatEditResponse(path: string, dirPath: string, filename: string, snippet: string): string {
    const link = deepLink(this.ctx.appUrl, this.space.slug, dirPath, filename);
    return `Edited \`${path}\`. Replaced 1 occurrence.\n[View](${link})\n\n**Context after edit:**\n\`\`\`\n${snippet}\n\`\`\``;
  }

  private formatAppendResponse(path: string, dirPath: string, filename: string): string {
    const link = deepLink(this.ctx.appUrl, this.space.slug, dirPath, filename);
    return `Appended to \`${path}\`.\n[View](${link})`;
  }
}

// ── Delete ────────────────────────────────────────────────────────────────

export class DeleteHandler {
  constructor(
    private readonly fs: VaultFS,
    private readonly space: KbSpace,
  ) {}

  private get slug() {
    return this.space.slug;
  }

  async delete(path: string): Promise<string> {
    if (!path || ['*', '**', '**/*'].includes(path)) {
      return 'Error: refusing to delete everything. Use a more specific path.';
    }

    const matched = await this.findDocuments(path);
    if (matched.length === 0) return `No documents matching \`${path}\` found in ${this.slug}.`;

    const protectedDocs = matched.filter(isProtectedDoc);
    const deletable = matched.filter((d) => !isProtectedDoc(d));

    if (deletable.length === 0) {
      const names = protectedDocs.map((d) => `\`${d.path}${d.filename}\``).join(', ');
      return `Cannot delete ${names} — these are structural wiki pages. Use \`write\` to edit their content instead.`;
    }

    this.fs.deleteFromDisk(deletable);

    const docIds = deletable.map((d) => String(d.id));
    const deletedCount = await this.fs.archiveDocuments(docIds);

    const lines = [`Deleted ${deletedCount || deletable.length} document(s):\n`];
    for (const d of deletable) lines.push(`  ${d.path}${d.filename}`);
    if (protectedDocs.length > 0) {
      const names = protectedDocs.map((d) => `\`${d.path}${d.filename}\``).join(', ');
      lines.push(`\nSkipped (protected): ${names}`);
    }
    return lines.join('\n');
  }

  private async findDocuments(path: string): Promise<any[]> {
    if (path.includes('*') || path.includes('?')) {
      const docs = await this.fs.listDocuments();
      const globPat = path.startsWith('/') ? path : '/' + path.replace(/^\//, '');
      return docs.filter((d) => globMatch(d.path + d.filename, globPat));
    }
    const [dirPath, filename] = resolvePath(path);
    const doc = await this.fs.getDocument(filename, dirPath);
    return doc ? [doc] : [];
  }
}

function isProtectedDoc(doc: any): boolean {
  return PROTECTED_FILENAMES.has(doc.filename || '') && (doc.path || '').startsWith('/wiki/');
}

// ── Query ─────────────────────────────────────────────────────────────────

export class QueryHandler {
  constructor(
    private readonly ctx: HandlerContext,
    private readonly fs: VaultFS,
    private readonly space: KbSpace,
    private readonly scopes: Set<string> | null,
  ) {}

  private get slug() {
    return this.space.slug || this.space.name;
  }

  async retrieve(query: string, scope: string, limit: number, includeReferences: boolean): Promise<string> {
    const pathFilter = this.scopeToFilter(scope);

    let docs = await this.fs.searchDocumentsFull(query, limit, pathFilter, this.scopes);

    if (docs.length === 0) {
      const keywords = query.split(/\s+/).filter((k) => k.trim().length > 0);
      docs = await this.fs.searchDocumentsByContent(keywords, limit, pathFilter, this.scopes);
    }

    if (docs.length === 0) {
      return `No results found for "${query}" in knowledge base "${this.slug}".`;
    }

    const lines = [`**${docs.length} result(s)** for "${query}" in **${this.space.name}**:\n`];

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
    let docs = await this.fs.listDocumentsWithContent(this.scopes);

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
