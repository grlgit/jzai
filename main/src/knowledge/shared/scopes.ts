/**
 * scope 过滤 SQL（移植自 kbs/src/shared/scopes.ts，去除 Fastify 依赖）：
 *   scopes === null        → 不过滤（ADMIN_ALL）
 *   scopes 含 'ADMIN_ALL'  → 不过滤
 *   scopes 为空集           → 仅 category_id IS NULL（公共）或 owner_user_id = 本人
 *   其余                    → 上述 + category_id ∈ scopes
 */
export const ADMIN_ALL = 'ADMIN_ALL';

export interface ScopeFilter {
  sql: string;
  params: any[];
  nextIdx: number;
}

/**
 * 生成 scope 过滤 SQL 片段（以 ' AND' 开头）。
 * @param alias 表别名（如 'd'），空串表示无别名
 */
export function scopeFilterSql(
  scopes: Set<string> | null,
  paramIdx: number,
  alias: string,
  userId: string,
): ScopeFilter {
  if (scopes === null || scopes.has(ADMIN_ALL)) {
    return { sql: '', params: [], nextIdx: paramIdx };
  }
  const col = alias ? `${alias}.` : '';
  const scopeList = [...scopes];
  return {
    sql:
      ` AND (${col}category_id IS NULL` +
      ` OR ${col}category_id::text = ANY($${paramIdx}::text[])` +
      ` OR ${col}owner_user_id = $${paramIdx + 1})`,
    params: [scopeList, userId],
    nextIdx: paramIdx + 2,
  };
}
