/**
 * 分类树与同义词（移植自 kbs/src/mcp/tools/taxonomy.ts，改为按空间缓存的 Injectable）。
 * 60s TTL 惰性重载；同义词展开产出 AND-of-OR 词组，由 VaultFS 生成每组多 ILIKE OR 条件。
 */
import { Injectable } from '@nestjs/common';
import { DbService } from '../../db/db.service';

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

interface SpaceTaxonomy {
  synonymMap: Map<string, Set<string>>;
  categories: CategoryNode[];
  flatCategories: FlatCategory[];
  loadedAt: number;
}

const TTL_MS = 60_000;

@Injectable()
export class TaxonomyService {
  private readonly cache = new Map<string, SpaceTaxonomy>();

  constructor(private readonly db: DbService) {}

  async ensureLoaded(spaceId: string): Promise<void> {
    const cached = this.cache.get(spaceId);
    if (cached && Date.now() - cached.loadedAt < TTL_MS) return;

    const entry: SpaceTaxonomy = {
      synonymMap: new Map(),
      categories: [],
      flatCategories: [],
      loadedAt: Date.now(),
    };

    try {
      const { rows } = await this.db.query(
        'SELECT * FROM jz_kb_categories WHERE space_id = $1 ORDER BY sort_order, name',
        [spaceId],
      );
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
      entry.categories = roots;
      entry.flatCategories = flattenCategories(roots);

      // 同义词为全局表（不分空间）
      const synRows = await this.db.query('SELECT keyword, synonyms FROM jz_kb_synonyms');
      for (const row of synRows.rows) {
        const allTerms = new Set<string>(
          [String(row.keyword).toLowerCase(), ...((row.synonyms || []) as string[]).map((v) => v.toLowerCase())],
        );
        for (const term of allTerms) {
          if (!entry.synonymMap.has(term)) entry.synonymMap.set(term, new Set());
          for (const t of allTerms) entry.synonymMap.get(term)!.add(t);
        }
      }
    } catch (err: any) {
      console.warn(`[knowledge] taxonomy 加载失败: ${err.message}`);
    }

    this.cache.set(spaceId, entry);
  }

  private get(spaceId: string): SpaceTaxonomy {
    return (
      this.cache.get(spaceId) || {
        synonymMap: new Map(),
        categories: [],
        flatCategories: [],
        loadedAt: 0,
      }
    );
  }

  /** 同义词展开 → AND-of-OR 词组。"薪资 标准" → [["薪资","薪酬","工资",...], ["标准"]] */
  expandQueryOrGroups(spaceId: string, query: string): string[][] {
    const { synonymMap } = this.get(spaceId);
    const words = query.split(/\s+/).filter((w) => w.length > 0);
    return words.map((word) => {
      const syns = synonymMap.get(word.toLowerCase());
      if (syns && syns.size > 1) return [...syns].sort();
      return [word];
    });
  }

  /** 查询是否在展开后产生了多义词组 */
  hasExpansion(spaceId: string, query: string): boolean {
    const { synonymMap } = this.get(spaceId);
    return query.split(/\s+/).some((w) => {
      const syns = synonymMap.get(w.toLowerCase());
      return !!syns && syns.size > 1;
    });
  }

  getFlatCategories(spaceId: string): FlatCategory[] {
    return this.get(spaceId).flatCategories;
  }

  getAllTags(spaceId: string): Set<string> {
    const tags = new Set<string>();
    for (const cat of this.get(spaceId).flatCategories) {
      for (const tag of cat.tags) tags.add(tag);
    }
    return tags;
  }

  resolveCategoryTree(spaceId: string): string {
    const { categories } = this.get(spaceId);
    if (categories.length === 0) return '';
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
    return render(categories, 0).join('\n');
  }

  classifyQuery(spaceId: string, query: string): string[] {
    const { flatCategories, synonymMap } = this.get(spaceId);
    if (flatCategories.length === 0) return [];
    const queryLower = query.toLowerCase();
    const queryWords = new Set(queryLower.split(/\s+/).filter(Boolean));

    const expandedWords = new Set(queryWords);
    for (const word of queryWords) {
      const syns = synonymMap.get(word);
      if (syns) for (const s of syns) expandedWords.add(s);
    }

    const scored: Array<[string, number]> = [];
    for (const cat of flatCategories) {
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
