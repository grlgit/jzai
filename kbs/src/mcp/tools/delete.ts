/**
 * 对译 mcp/tools/delete.py — 删除（glob + overview.md/log.md 保护 + pg_local 硬删）。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, createVaultFS } from './index';
import { globMatch, resolvePath } from './helpers';
import { PgLocalVaultFS } from '../vaultfs/pg-local';

const PROTECTED_FILENAMES = new Set(['overview.md', 'log.md']);

function isProtected(doc: any): boolean {
  return PROTECTED_FILENAMES.has(doc.filename || '') && (doc.path || '').startsWith('/wiki/');
}

class DeleteHandler {
  constructor(
    private readonly fs: PgLocalVaultFS,
    private readonly kb: any,
  ) {}

  private get kbId() {
    return String(this.kb.id);
  }
  private get slug() {
    return this.kb.slug;
  }

  async delete(path: string): Promise<string> {
    if (!path || ['*', '**', '**/*'].includes(path)) {
      return 'Error: refusing to delete everything. Use a more specific path.';
    }

    const matched = await this.findDocuments(path);
    if (matched.length === 0) return `No documents matching \`${path}\` found in ${this.slug}.`;

    const protectedDocs = matched.filter(isProtected);
    const deletable = matched.filter((d) => !isProtected(d));

    if (deletable.length === 0) {
      const names = protectedDocs.map((d) => `\`${d.path}${d.filename}\``).join(', ');
      return `Cannot delete ${names} — these are structural wiki pages. Use \`write\` to edit their content instead.`;
    }

    this.fs.deleteFromDisk(deletable);

    const docIds = deletable.map((d) => String(d.id));
    const deletedCount = await this.fs.archiveDocuments(docIds);

    return this.formatResponse(deletedCount || deletable.length, deletable, protectedDocs);
  }

  private async findDocuments(path: string): Promise<any[]> {
    if (path.includes('*') || path.includes('?')) {
      const docs = await this.fs.listDocuments(this.kbId);
      const globPat = path.startsWith('/') ? path : '/' + path.replace(/^\//, '');
      return docs.filter((d) => globMatch(d.path + d.filename, globPat));
    }
    const [dirPath, filename] = resolvePath(path);
    const doc = await this.fs.getDocument(this.kbId, filename, dirPath);
    return doc ? [doc] : [];
  }

  private formatResponse(deletedCount: number, deletable: any[], protectedDocs: any[]): string {
    const lines = [`Deleted ${deletedCount} document(s):\n`];
    for (const d of deletable) lines.push(`  ${d.path}${d.filename}`);
    if (protectedDocs.length > 0) {
      const names = protectedDocs.map((d) => `\`${d.path}${d.filename}\``).join(', ');
      lines.push(`\nSkipped (protected): ${names}`);
    }
    return lines.join('\n');
  }
}

const DESCRIPTION =
  'Delete documents or wiki pages from the knowledge vault.\n\n' +
  'Provide a path to delete a single file, or a glob pattern to delete multiple.\n' +
  'Examples:\n' +
  '- `path="old-notes.md"` — delete a single file\n' +
  '- `path="/wiki/drafts/*"` — delete all files in a folder\n' +
  '- `path="/wiki/**"` — delete the entire wiki\n\n' +
  'Note: overview.md and log.md are structural pages and cannot be deleted.\n' +
  'Returns a list of deleted files. This action cannot be undone.';

export function registerDelete(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'delete',
    {
      description: DESCRIPTION,
      inputSchema: {
        knowledge_base: z.string(),
        path: z.string(),
      },
    },
    async ({ knowledge_base, path }) => {
      const fs = createVaultFS(ctx);
      const kb = await fs.resolveKb(knowledge_base);
      if (!kb) {
        return { content: [{ type: 'text' as const, text: `Knowledge base '${knowledge_base}' not found.` }] };
      }
      const handler = new DeleteHandler(fs, kb);
      const text = await handler.delete(path);
      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
