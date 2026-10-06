/**
 * 纯函数工具（移植自 kbs/src/mcp/tools/helpers.ts）。
 */
export const MAX_LIST = 50;
export const MAX_SEARCH = 20;

export function deepLink(appUrl: string, spaceSlug: string, path: string, filename: string): string {
  const full = `${path.replace(/\/$/, '')}/${filename}`.replace(/^\//, '');
  return `${appUrl}/wikis/${spaceSlug}/${full}`;
}

/** Python fnmatch 语义：* 与 ** 均匹配任意字符（含 /），? 匹配单字符 */
export function globMatch(filepath: string, pattern: string): boolean {
  const re = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
  );
  return re.test(filepath);
}

export function resolvePath(path: string): [string, string] {
  const pathClean = path.replace(/^\//, '');
  if (pathClean.includes('/')) {
    const idx = pathClean.lastIndexOf('/');
    return ['/' + pathClean.slice(0, idx) + '/', pathClean.slice(idx + 1)];
  }
  return ['/', pathClean];
}

export function parsePageRange(pagesStr: string, maxPage: number): number[] {
  const result = new Set<number>();
  for (const part of pagesStr.split(',')) {
    const p = part.trim();
    if (p.includes('-')) {
      const [start, end] = p.split('-', 2);
      const s = parseInt(start.trim(), 10);
      const e = parseInt(end.trim(), 10);
      if (!Number.isNaN(s) && !Number.isNaN(e)) {
        for (let pg = Math.max(1, s); pg <= Math.min(maxPage, e); pg++) result.add(pg);
      }
    } else if (/^\d+$/.test(p)) {
      const pg = parseInt(p, 10);
      if (pg >= 1 && pg <= maxPage) result.add(pg);
    }
  }
  return [...result].sort((a, b) => a - b);
}
