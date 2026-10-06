/**
 * frontmatter 工具（移植自 kbs/src/shared/frontmatter.ts）。
 */
import yaml from 'js-yaml';

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

export function parseFrontmatter(content: string): Record<string, any> {
  const m = content.match(FRONTMATTER_RE);
  if (!m) return {};
  try {
    const meta = yaml.load(m[1]);
    return meta && typeof meta === 'object' && !Array.isArray(meta)
      ? (meta as Record<string, any>)
      : {};
  } catch {
    return {};
  }
}

export function titleFromFilename(filename: string): string {
  const stem = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename;
  const s = stem.replace(/[-_]/g, ' ').trim();
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export function extractTags(meta: Record<string, any>): string[] {
  const tags = meta.tags;
  if (Array.isArray(tags)) return tags.filter((t) => t != null).map(String);
  return [];
}
