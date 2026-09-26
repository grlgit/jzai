/**
 * 对译 llm_wiki/api/services/types.py 的 frontmatter 工具。
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
  // Python str.title()：每个词首字母大写、其余小写
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

export function extractTags(meta: Record<string, any>): string[] {
  const tags = meta.tags;
  if (Array.isArray(tags)) return tags.filter((t) => t != null).map(String);
  return [];
}
