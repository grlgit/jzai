/**
 * 对译 mcp/tools/write.py — create/str_replace/append + 引用同步 + staleness 传播。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, createVaultFS } from './index';
import { deepLink, resolvePath } from './helpers';
import { updateReferences } from './references';
import { parseFrontmatter } from '../../shared/frontmatter';
import { PgLocalVaultFS } from '../vaultfs/pg-local';

const ASSET_EXTENSIONS = new Set(['.svg', '.csv', '.json', '.xml', '.html', '.png', '.jpg', '.jpeg', '.webp', '.gif']);
const FILE_EXT_RE = /\.(md|txt|svg|csv|json|xml|html)$/i;
const CONTEXT_LINES = 5;

const LAYER_LIMITS: Record<string, { maxDocs: number; maxChars: number }> = {
  _character: { maxDocs: 3, maxChars: 8000 },
  _rules: { maxDocs: 10, maxChars: 20000 },
};

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

class WriteHandler {
  constructor(
    private readonly ctx: ToolContext,
    private readonly fs: PgLocalVaultFS,
    private readonly kb: any,
  ) {}

  private get kbId() {
    return String(this.kb.id);
  }

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
        const existingDocs = await this.fs.listDocuments(this.kbId);
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

    const existing = await this.fs.getDocument(this.kbId, filename, dirPath);

    if (!existing && !overwrite) {
      const similar = await this.fs.findDocumentByName(this.kbId, title);
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
      doc = await this.fs.createDocument(this.kbId, filename, title, dirPath, fileType, content, tags, fmDate, fmMetadata);
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
    const doc = await this.fs.getDocument(this.kbId, filename, dirPath);
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
    const doc = await this.fs.getDocument(this.kbId, filename, dirPath);
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
      await updateReferences(this.fs, this.kbId, docId, content, dirPath);
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
    const link = deepLink(this.ctx.appUrl, this.kb.slug, dirPath, filename);
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
    const link = deepLink(this.ctx.appUrl, this.kb.slug, dirPath, filename);
    return `Edited \`${path}\`. Replaced 1 occurrence.\n[View](${link})\n\n**Context after edit:**\n\`\`\`\n${snippet}\n\`\`\``;
  }

  private formatAppendResponse(path: string, dirPath: string, filename: string): string {
    const link = deepLink(this.ctx.appUrl, this.kb.slug, dirPath, filename);
    return `Appended to \`${path}\`.\n[View](${link})`;
  }
}

const DESCRIPTION =
  'Create or edit notes and wiki pages in the knowledge vault.\n\n' +
  'Wiki pages should be created under `/wiki/` and should cite their sources using ' +
  'markdown footnotes (e.g. `[^1]: paper.pdf, p.3`).\n\n' +
  'You can also create SVG diagrams and CSV data files as wiki assets:\n' +
  '- `write(command="create", path="/wiki/", title="architecture-diagram.svg", content="<svg>...</svg>", tags=["diagram"])`\n' +
  '- `write(command="create", path="/wiki/", title="data-table.csv", content="col1,col2\\nval1,val2", tags=["data"])`\n' +
  'SVGs and other assets can be embedded in wiki pages via `![Architecture](architecture-diagram.svg)`\n\n' +
  'Commands:\n' +
  '- create: create a new page (title and tags are REQUIRED). Rejects if page already exists — use overwrite=true to replace.\n' +
  '- str_replace: replace exact text in an existing page (read first)\n' +
  '- append: add content to the end of an existing page';

export function registerWrite(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'write',
    {
      description: DESCRIPTION,
      inputSchema: {
        knowledge_base: z.string(),
        command: z.enum(['create', 'str_replace', 'append']),
        path: z.string().default('/'),
        title: z.string().default(''),
        content: z.string().default(''),
        tags: z.array(z.string()).optional(),
        date_str: z.string().default(''),
        old_text: z.string().default(''),
        new_text: z.string().default(''),
        overwrite: z.boolean().default(false),
      },
    },
    async ({ knowledge_base, command, path, title, content, tags, date_str, old_text, new_text, overwrite }) => {
      const fs = createVaultFS(ctx);
      const kb = await fs.resolveKb(knowledge_base);
      if (!kb) {
        return { content: [{ type: 'text' as const, text: `Knowledge base '${knowledge_base}' not found.` }] };
      }
      const handler = new WriteHandler(ctx, fs, kb);

      let text: string;
      if (command === 'create') {
        text = await handler.create(path, title, content, tags ?? [], date_str, overwrite);
      } else if (command === 'str_replace') {
        text = await handler.edit(path, old_text, new_text, tags ?? null);
      } else if (command === 'append') {
        text = await handler.append(path, content, tags ?? null);
      } else {
        text = `Unknown command: ${command}`;
      }
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
