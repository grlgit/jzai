/**
 * 对译 llm_wiki/api/services/pg_local.py 的读路径（PgDocumentRepository 查询部分）。
 * tags(TEXT[])/metadata(JSONB) 由 pg 驱动自动反序列化。
 */
import { Db } from '../shared/db';
import { scopeFilterSql } from '../shared/scopes';

export class DocRepository {
  constructor(private readonly db: Db) {}

  async list(opts: {
    path?: string;
    scopes: Set<string> | null;
    userId: string;
  }): Promise<any[]> {
    let sql = "SELECT * FROM jz_kb_documents WHERE status != 'archived'";
    const params: any[] = [];
    let idx = 1;
    if (opts.path) {
      sql += ` AND path = $${idx++}`;
      params.push(opts.path);
    }
    const scope = scopeFilterSql(opts.scopes, idx, '', opts.userId);
    sql += scope.sql;
    params.push(...scope.params);
    sql += ' ORDER BY path, filename';
    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  async get(docId: string, scopes: Set<string> | null, userId: string): Promise<any | null> {
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    const doc = rows[0];
    if (!doc) return null;
    if (scopes !== null && !scopes.has('ADMIN_ALL')) {
      if (doc.category_id && !scopes.has(String(doc.category_id)) && doc.owner_user_id !== userId) {
        return null;
      }
    }
    return doc;
  }

  async getContent(docId: string, scopes: Set<string> | null, userId: string): Promise<any | null> {
    const doc = await this.get(docId, scopes, userId);
    if (!doc) return null;
    const { rows } = await this.db.query(
      'SELECT id, filename, path, content, file_type FROM jz_kb_documents WHERE id = $1',
      [docId],
    );
    return rows[0] || null;
  }
}
