/**
 * 引用解析（移植自 kbs/src/mcp/tools/references.ts）：
 * 从 wiki 内容解析脚注引用与内链，重建引用边。
 */
import { VaultFS } from '../vaultfs/vaultfs.service';

const CITATION_RE = /\[\^\d+\]:\s*(.+)$/gm;
const WIKI_LINK_RE = /(?<!!)\[(?:[^\]]*)\]\(([^)]+)\)/g;

function parseCitationFilename(raw: string): [string, number | null] {
  let s = raw.trim().replace(/^\*/, '').replace(/\*$/, '');
  const linkMatch = s.match(/\[([^\]]+)\]\([^)]*\)/);
  if (linkMatch) s = linkMatch[1];
  const parts = s.match(/^(.+?)(?:,\s*p\.?\s*(\d+))?(?:\s*[-–—].*)?$/);
  if (!parts) return [s, null];
  const filename = parts[1].trim();
  const page = parts[2] ? parseInt(parts[2], 10) : null;
  return [filename, page];
}

function parseWikiLinks(content: string, currentDir: string): string[] {
  const paths: string[] = [];
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const href = match[1];
    if (/^(http|#|mailto:|data:)/.test(href)) continue;
    if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(href)) continue;

    let resolved: string;
    if (href.startsWith('/wiki/')) {
      resolved = href.replace('/wiki/', '');
    } else if (href.startsWith('./')) {
      resolved = currentDir ? currentDir + href.slice(2) : href.slice(2);
    } else if (href.startsWith('../')) {
      const parts = (currentDir.replace(/\/$/, '') + '/' + href).split('/');
      const resolvedParts: string[] = [];
      for (const p of parts) {
        if (p === '..') {
          if (resolvedParts.length > 0) resolvedParts.pop();
        } else if (p && p !== '.') {
          resolvedParts.push(p);
        }
      }
      resolved = resolvedParts.join('/');
    } else if (!href.includes('/')) {
      resolved = currentDir ? currentDir + href : href;
    } else {
      resolved = href;
    }

    if (resolved) paths.push(resolved);
  }
  return paths;
}

const EXT_RE = /\.(pdf|docx?|pptx?|xlsx?|csv|html?|md|txt)$/;

export async function updateReferences(
  fs: VaultFS,
  documentId: string,
  content: string,
  docPath: string,
): Promise<void> {
  const wikiRelativeDir = docPath.startsWith('/wiki/') ? docPath.replace('/wiki/', '') : '';

  const allDocs = await fs.listDocuments();

  const filenameToDoc = new Map<string, any>();
  const wikiPathToDoc = new Map<string, any>();
  for (const doc of allDocs) {
    const fnLower = (doc.filename as string).toLowerCase();
    if (!filenameToDoc.has(fnLower)) filenameToDoc.set(fnLower, doc);
    if (doc.title) {
      const titleLower = (doc.title as string).toLowerCase();
      if (!filenameToDoc.has(titleLower)) filenameToDoc.set(titleLower, doc);
    }
    if ((doc.path as string).startsWith('/wiki/')) {
      const relative = (doc.path + doc.filename).replace('/wiki/', '');
      wikiPathToDoc.set(relative.toLowerCase(), doc);
    }
  }

  const edges: Array<[string, string, number | null]> = [];

  for (const match of content.matchAll(CITATION_RE)) {
    const [filename, page] = parseCitationFilename(match[1]);
    const fnLower = filename.toLowerCase();
    let target = filenameToDoc.get(fnLower);
    if (!target) {
      const base = fnLower.replace(EXT_RE, '');
      for (const doc of allDocs) {
        const docBase = (doc.filename as string).toLowerCase().replace(EXT_RE, '');
        if (docBase === base) {
          target = doc;
          break;
        }
      }
    }
    if (target && String(target.id) !== documentId) {
      edges.push([String(target.id), 'cites', page]);
    }
  }

  for (const linkPath of parseWikiLinks(content, wikiRelativeDir)) {
    const lp = linkPath.toLowerCase();
    let target = wikiPathToDoc.get(lp) || wikiPathToDoc.get(lp + '.md');
    if (!target) {
      const basename = lp.split('/').pop()!;
      target = wikiPathToDoc.get(basename);
    }
    if (target && String(target.id) !== documentId) {
      edges.push([String(target.id), 'links_to', null]);
    }
  }

  await fs.deleteReferences(documentId);

  const seen = new Set<string>();
  for (const [targetId, refType, page] of edges) {
    const key = `${targetId}|${refType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await fs.upsertReference(documentId, targetId, refType, page);
  }
}

export async function getBacklinksSummary(fs: VaultFS, docId: string): Promise<string> {
  const rows = await fs.getBacklinks(docId);
  if (rows.length === 0) return '';
  const lines = [`\n---\n**Referenced by (${rows.length}):**`];
  for (const r of rows) {
    const title = r.title || r.filename;
    lines.push(`  - ${title} (${r.reference_type})`);
  }
  return lines.join('\n');
}
