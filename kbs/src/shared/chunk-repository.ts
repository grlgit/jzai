/**
 * 对译 services/pg_local.py::PgChunkRepository 与 pg_local_processor 的 pages/chunks 落库。
 */
import { randomUUID } from 'crypto';
import { Db } from './db';
import { Chunk } from './chunker';

export class ChunkRepository {
  constructor(private readonly db: Db) {}

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
