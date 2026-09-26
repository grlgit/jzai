/**
 * 对译 llm_wiki/api/routes/search.py + mcp/vaultfs/pg_local.py::search_chunks
 * （pg_trgm similarity + ILIKE，fail-closed scope 过滤）。
 */
import { FastifyInstance } from 'fastify';
import { Db } from '../../shared/db';
import { resolveScopes, resolveUserId, scopeFilterSql } from '../../shared/scopes';

export function searchRoutes(db: Db) {
  return async function (app: FastifyInstance) {
    app.get('/v1/knowledge-bases/:kb_id/search', async (req, reply) => {
      const { q, limit: limitRaw, scope } = req.query as {
        q?: string;
        limit?: string;
        scope?: string;
      };
      if (!q || q.length < 1) {
        return reply.code(422).send({ detail: 'q is required' });
      }
      let limit = parseInt(limitRaw || '20', 10);
      if (Number.isNaN(limit) || limit < 1) limit = 20;
      if (limit > 100) limit = 100;

      let sql =
        'SELECT dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index, ' +
        'd.filename, d.title, d.path, d.file_type, d.tags, d.category_id, d.metadata, ' +
        'similarity(dc.content, $1) AS score ' +
        'FROM jz_kb_document_chunks dc ' +
        'JOIN jz_kb_documents d ON dc.document_id = d.id ' +
        "WHERE dc.content ILIKE '%' || $1 || '%' " +
        "AND d.status = 'ready' ";
      const params: any[] = [q];

      if (scope === 'wiki') sql += "AND d.source_kind = 'wiki' ";
      else if (scope === 'sources') sql += "AND d.source_kind != 'wiki' ";

      sql += "AND COALESCE(d.sensitivity, 'public') != 'restricted' ";

      const sf = scopeFilterSql(resolveScopes(req), 2, 'd', resolveUserId(req));
      sql += sf.sql;
      params.push(...sf.params);

      sql += `ORDER BY score DESC LIMIT $${sf.nextIdx}`;
      params.push(limit);

      const { rows } = await db.query(sql, params);
      return rows;
    });
  };
}
