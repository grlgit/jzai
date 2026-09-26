/**
 * 分类 scope 过滤 — 对译 llm_wiki api/documents.py::_resolve_scopes
 * 与 mcp/vaultfs/pg_local.py::_scope_filter（fail-closed 语义）：
 *
 *   scopes === null        → 不过滤（无签名本地调用 / ADMIN_ALL）
 *   scopes 含 'ADMIN_ALL'  → 不过滤
 *   scopes 为空集           → 仅 category_id IS NULL（公共）或 owner_user_id = 本人
 *   其余                    → 上述 + category_id ∈ scopes
 */
import { FastifyRequest } from 'fastify';

/** pg_local 本地固定用户（对齐 Python uuid5(NAMESPACE_DNS, "local")） */
export const LOCAL_USER_ID = 'e6b612bf-d985-5024-a244-4206e5dd869d';

export function resolveUserId(req: FastifyRequest): string {
  return req.internalUser || LOCAL_USER_ID;
}

/** null = 不做 scope 过滤（等价 ADMIN_ALL） */
export function resolveScopes(req: FastifyRequest): Set<string> | null {
  if (req.internalScopes === undefined) return null;
  const scopes = new Set(req.internalScopes);
  if (scopes.has('ADMIN_ALL')) return null;
  return scopes;
}

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
  if (scopes === null || scopes.has('ADMIN_ALL')) {
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
