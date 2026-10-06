/**
 * 文档/分块仓储（移植自 kbs/src/shared/{doc,chunk}-repository.ts）。
 * Db 接口与 main DbService / kbs Db 均兼容（query(text, params)）。
 */
import { randomUUID } from 'crypto';
import { scopeFilterSql } from './scopes';
import { Chunk } from './chunker';

export interface DbLike {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export class DocRepository {
  constructor(private readonly db: DbLike) {}

  async list(opts: {
    path?: string;
    spaceId: string;
    scopes: Set<string> | null;
    userId: string;
  }): Promise<any[]> {
    let sql = "SELECT * FROM jz_kb_documents WHERE status != 'archived' AND space_id = $1";
    const params: any[] = [opts.spaceId];
    let idx = 2;
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

export class ChunkRepository {
  constructor(private readonly db: DbLike) {}

  async storeChunks(docId: string, chunks: Chunk[]): Promise<void> {
    await this.db.query('DELETE FROM jz_kb_document_chunks WHERE document_id = $1', [docId]);
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      await this.db.query(
        'INSERT INTO jz_kb_document_chunks ' +
          '(id, document_id, chunk_index, content, page, start_char, token_count, header_breadcrumb) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [randomUUID(), docId, i, c.content, c.page, c.start_char, c.token_count, c.header_breadcrumb],
      );
    }
  }

  async storePages(
    docId: string,
    pageContents: Array<[number, string]>,
    elementsByPage?: Map<number, string>,
  ): Promise<void> {
    await this.db.query('DELETE FROM jz_kb_document_pages WHERE document_id = $1', [docId]);
    for (const [pageNum, content] of pageContents) {
      const elements = elementsByPage?.get(pageNum) ?? null;
      await this.db.query(
        'INSERT INTO jz_kb_document_pages (id, document_id, page, content, elements) VALUES ($1, $2, $3, $4, $5)',
        [randomUUID(), docId, pageNum, content, elements],
      );
    }
  }
}
