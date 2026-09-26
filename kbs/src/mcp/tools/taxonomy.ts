/**
 * 对译 mcp/tools/taxonomy.py — PG 版（jz_kb_categories + jz_kb_synonyms）。
 * 60s TTL 惰性重载（Python 仅启动时加载一次，长期运行下分类变更不可见）。
 *
 * 搜索同义词展开的差异说明：Python expand_query 产出 FTS5 OR 语法，
 * 但 pg_local 用整串 ILIKE —— 展开后反而必不命中（潜在 bug）。
 * TS 改为 expandQueryOrGroups：AND-of-OR 词组，由 vaultfs 生成
 * 每组多 ILIKE OR 条件（这是计划内明确的"查询生成器重写"）。
 */
import { Db } from '../../shared/db';

export interface FlatCategory {
  name: string;
  path: string;
  tags: string[];
  template: string | null;
  depth: number;
}

interface CategoryNode {
  name: string;
  tags?: string[];
  template?: string | null;
  children?: CategoryNode[];
}

let _synonymMap: Map<string, Set<string>> = new Map();
let _categories: CategoryNode[] = [];
let _flatCategories: FlatCategory[] = [];
let _loadedAt = 0;
const TTL_MS = 60_000;

let _db: Db | null = null;

export function initTaxonomy(db: Db): void {
  _db = db;
}

export async function ensureTaxonomyLoaded(): Promise<void> {
  if (!_db) return;
  if (Date.now() - _loadedAt < TTL_MS) return;
  _loadedAt = Date.now();
  try {
    const { rows } = await _db.query('SELECT * FROM jz_kb_categories ORDER BY sort_order, name');
    const byId = new Map<string, any>();
    for (const c of rows) {
      byId.set(c.id, { ...c, children: [] as any[] });
    }
    const roots: any[] = [];
    for (const c of byId.values()) {
      if (c.parent_id && byId.has(c.parent_id)) {
        byId.get(c.parent_id)!.children.push(c);
      } else {
        roots.push(c);
      }
    }
    _categories = roots;
    _flatCategories = flattenCategories(roots);

    _synonymMap = new Map();
    const synRows = await _db.query('SELECT keyword, synonyms FROM jz_kb_synonyms');
    for (const row of synRows.rows ?? synRows) {
      const allTerms = new Set<string>(
        [String(row.keyword).toLowerCase(), ...((row.synonyms || []) as string[]).map((v) => v.toLowerCase())],
      );
      for (const term of allTerms) {
        if (!_synonymMap.has(term)) _synonymMap.set(term, new Set());
        for (const t of allTerms) _synonymMap.get(term)!.add(t);
      }
    }
  } catch (err: any) {
    console.warn(`[kbs] taxonomy 加载失败: ${err.message}`);
  }
}

function flattenCategories(cats: CategoryNode[], prefix = ''): FlatCategory[] {
  const result: FlatCategory[] = [];
  for (const cat of cats) {
    const name = cat.name || '';
    const p = prefix ? `${prefix}/${name}` : name;
    result.push({
      name,
      path: p,
      tags: cat.tags || [],
      template: cat.template ?? null,
      depth: p.split('/').length - 1,
    });
    if (cat.children && cat.children.length > 0) {
      result.push(...flattenCategories(cat.children, p));
    }
  }
  return result;
}

/**
 * 同义词展开 → AND-of-OR 词组。
 * "薪资 标准" → [["薪资","薪酬","工资",...], ["标准"]]
 */
export function expandQueryOrGroups(query: string): string[][] {
  const words = query.split(/\s+/).filter((w) => w.length > 0);
  return words.map((word) => {
    const syns = _synonymMap.get(word.toLowerCase());
    if (syns && syns.size > 1) return [...syns].sort();
    return [word];
  });
}

/** 查询是否在展开后产生了多义词组（决定走 OR 组 SQL 还是整串 ILIKE） */
export function hasExpansion(query: string): boolean {
  return query
    .split(/\s+/)
    .some((w) => {
      const syns = _synonymMap.get(w.toLowerCase());
      return !!syns && syns.size > 1;
    });
}

export function getFlatCategories(): FlatCategory[] {
  return _flatCategories;
}

export function getAllTags(): Set<string> {
  const tags = new Set<string>();
  for (const cat of _flatCategories) {
    for (const tag of cat.tags) tags.add(tag);
  }
  return tags;
}

export function resolveCategoryTree(): string {
  if (_categories.length === 0) return '';
  const render = (cats: CategoryNode[], indent: number): string[] => {
    const lines: string[] = [];
    const prefix = '  '.repeat(indent);
    for (const cat of cats) {
      const tagStr = cat.tags && cat.tags.length > 0 ? ` [${cat.tags.join(', ')}]` : '';
      lines.push(`${prefix}${cat.name}${tagStr}`);
      if (cat.children && cat.children.length > 0) lines.push(...render(cat.children, indent + 1));
    }
    return lines;
  };
  return render(_categories, 0).join('\n');
}

export function classifyQuery(query: string): string[] {
  if (_flatCategories.length === 0) return [];
  const queryLower = query.toLowerCase();
  const queryWords = new Set(queryLower.split(/\s+/).filter(Boolean));

  const expandedWords = new Set(queryWords);
  for (const word of queryWords) {
    const syns = _synonymMap.get(word);
    if (syns) for (const s of syns) expandedWords.add(s);
  }

  const scored: Array<[string, number]> = [];
  for (const cat of _flatCategories) {
    let score = 0;
    const nameLower = cat.name.toLowerCase();
    if (queryLower.includes(nameLower)) score += 3;
    else if (expandedWords.has(nameLower)) score += 2;

    for (const tag of cat.tags) {
      const tagLower = tag.toLowerCase();
      if (queryLower.includes(tagLower)) score += 2;
      else if (expandedWords.has(tagLower)) score += 1;
    }

    if (score > 0) {
      score += cat.depth * 0.5;
      scored.push([cat.path, score]);
    }
  }

  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, 3).map(([p]) => p);
}
