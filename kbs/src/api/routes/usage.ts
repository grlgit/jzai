/**
 * 对译 llm_wiki/api/routes/usage.py + PgLocalUserService.get_usage。
 */
import { FastifyInstance } from 'fastify';
import { Db } from '../../shared/db';

export function usageRoutes(db: Db) {
  return async function (app: FastifyInstance) {
    app.get('/v1/usage', async () => {
      const { rows } = await db.query(
        "SELECT count(*)::int AS doc_count, " +
          'COALESCE(SUM(page_count), 0)::bigint AS total_pages, ' +
          'COALESCE(SUM(file_size), 0)::bigint AS total_storage ' +
          "FROM jz_kb_documents WHERE status != 'failed'",
      );
      const row = rows[0] || {};
      return {
        total_pages: Number(row.total_pages || 0),
        total_storage_bytes: Number(row.total_storage || 0),
        document_count: row.doc_count || 0,
        max_pages: 999999,
        max_storage_bytes: 999999999999,
      };
    });
  };
}
