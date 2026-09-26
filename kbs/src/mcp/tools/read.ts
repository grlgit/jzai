/**
 * 对译 mcp/tools/read.py — 单读/批量/分页/表格索引/图片。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, createVaultFS } from './index';
import { deepLink, globMatch, resolvePath, parsePageRange } from './helpers';
import { getBacklinksSummary } from './references';
import { PgLocalVaultFS } from '../vaultfs/pg-local';

const MAX_BATCH_CHARS = 120_000;

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

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

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

class ReadHandler {
  constructor(
    private readonly ctx: ToolContext,
    private readonly fs: PgLocalVaultFS,
    private readonly kb: any,
  ) {}

  private get kbId() {
    return String(this.kb.id);
  }
  private get slug() {
    return this.kb.slug;
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
    let docs = await this.fs.listDocumentsWithContent(this.kbId);
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
    let doc = await this.fs.getDocument(this.kbId, filename, dirPath);
    if (!doc) {
      const name = path.replace(/^\//, '').split('/').pop()!;
      doc = await this.fs.findDocumentByName(this.kbId, name);
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

const DESCRIPTION =
  'Read document content from the knowledge vault.\n\n' +
  'Accepts a single file path OR a glob pattern to batch-read multiple files:\n' +
  '- `path="notes.md"` — read one file\n' +
  '- `path="*.md"` — read all markdown files in root\n' +
  '- `path="/wiki/**"` — read all wiki pages\n' +
  '- `path="**/*.md"` — read all markdown files everywhere\n\n' +
  'Batch reads are the PREFERRED way to read multiple documents at once — use them generously.\n' +
  'Glob reads sample the first few pages from each document (including PDFs) up to a 120k char budget. ' +
  'This gives you a broad overview of an entire folder in one call. Read individual files for full content.\n\n' +
  'For PDFs and office docs, use `pages` to read specific page ranges (e.g. \'1-50\', \'3\', \'10-30\').\n' +
  'You can read up to 50+ pages in a single call — use wide ranges to avoid unnecessary round trips.\n' +
  'For spreadsheets, each sheet is a page (call without pages first to see sheet names).\n' +
  'Set `include_images=true` to include embedded images (e.g. figures in PDFs, standalone image files). ' +
  'Off by default to save context — enable when you need to see charts, diagrams, or photos.\n\n' +
  'When reading sources to compile wiki pages, note the filename and page ranges for citation.';

export function registerRead(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'read',
    {
      description: DESCRIPTION,
      inputSchema: {
        knowledge_base: z.string(),
        path: z.string(),
        pages: z.string().default(''),
        sections: z.array(z.string()).optional(),
        include_images: z.boolean().default(false),
      },
    },
    async ({ knowledge_base, path, pages, sections, include_images }) => {
      const fs = createVaultFS(ctx);
      const kb = await fs.resolveKb(knowledge_base);
      if (!kb) {
        return { content: [{ type: 'text' as const, text: `Knowledge base '${knowledge_base}' not found.` }] };
      }
      const handler = new ReadHandler(ctx, fs, kb);
      const result = await handler.read(path, pages, sections ?? null, include_images);
      if (typeof result === 'string') {
        return { content: [{ type: 'text' as const, text: result }] };
      }
      return { content: result as any };
    },
  );
}
