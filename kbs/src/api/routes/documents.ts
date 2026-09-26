/**
 * 对译 llm_wiki/api/routes/documents.py（pg_local 全量：读 + 写）。
 */
import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../../shared/db';
import { DocRepository } from '../../shared/doc-repository';
import { ChunkRepository } from '../../shared/chunk-repository';
import { chunkText } from '../../shared/chunker';
import { parseFrontmatter, titleFromFilename, extractTags } from '../../shared/frontmatter';
import { resolveScopes, resolveUserId } from '../../shared/scopes';

const UPDATABLE_FIELDS = new Set([
  'filename', 'path', 'title', 'tags', 'date', 'metadata',
  'relative_path', 'source_kind', 'status', 'sensitivity',
]);

export function documentsRoutes(db: Db, apiUrl: string, workspaceRoot: string) {
  const repo = new DocRepository(db);
  const chunkRepo = new ChunkRepository(db);
  const ws = path.resolve(workspaceRoot);

  function safeResolve(relative: string): string {
    const resolved = path.resolve(ws, relative);
    if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
      const err: any = new Error('Path escapes workspace');
      err.statusCode = 400;
      throw err;
    }
    return resolved;
  }

  function docDiskPath(doc: any): string | null {
    const relative = `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    const resolved = path.resolve(ws, relative);
    return resolved.startsWith(ws + path.sep) ? resolved : null;
  }

  async function findByPath(filename: string, dirPath: string): Promise<any | null> {
    const { rows } = await db.query(
      "SELECT * FROM jz_kb_documents WHERE filename = $1 AND path = $2 AND status != 'archived'",
      [filename, dirPath],
    );
    return rows[0] || null;
  }

  return async function (app: FastifyInstance) {
    // ── 读 ──────────────────────────────────────────────────────────────
    app.get('/v1/knowledge-bases/:kb_id/documents', async (req) => {
      const { path } = req.query as { path?: string };
      return repo.list({ path, scopes: resolveScopes(req), userId: resolveUserId(req) });
    });

    app.get('/v1/documents/:doc_id', async (req, reply) => {
      const { doc_id } = req.params as { doc_id: string };
      const doc = await repo.get(doc_id, resolveScopes(req), resolveUserId(req));
      if (!doc) return reply.code(404).send({ detail: 'Document not found' });
      return doc;
    });

    app.get('/v1/documents/:doc_id/url', async (req, reply) => {
      const { doc_id } = req.params as { doc_id: string };
      const doc = await repo.get(doc_id, resolveScopes(req), resolveUserId(req));
      if (!doc) return reply.code(404).send({ detail: 'Document not found' });
      const relative =
        doc.relative_path || `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
      return { url: `${apiUrl.replace(/\/$/, '')}/v1/files/${relative}` };
    });

    app.get('/v1/documents/:doc_id/content', async (req, reply) => {
      const { doc_id } = req.params as { doc_id: string };
      const row = await repo.getContent(doc_id, resolveScopes(req), resolveUserId(req));
      if (!row) return reply.code(404).send({ detail: 'Document not found' });
      return row;
    });

    // sqlite-only 功能：保持兼容响应
    app.get('/v1/documents/:doc_id/extractions', async (_req, reply) =>
      reply.code(501).send({ detail: 'Extractions only available in local mode' }),
    );

    // ── 写 ──────────────────────────────────────────────────────────────
    app.post('/v1/knowledge-bases/:kb_id/documents/note', async (req, reply) => {
      const userId = resolveUserId(req);
      const body = (req.body || {}) as { filename?: string; path?: string; content?: string };
      const filename = body.filename;
      if (!filename) return reply.code(422).send({ detail: 'filename is required' });
      const dirPath = body.path || '/';
      const content = body.content ?? '';

      const meta = parseFrontmatter(content);
      let title = (meta.title || '').trim() || titleFromFilename(filename);
      const tags = extractTags(meta);

      // 幂等：同 path+filename 且内容一致（非空）→ 返回已有文档
      if (content) {
        const existing = await findByPath(filename, dirPath);
        if (existing && (existing.content || '') === content) {
          return reply.code(201).send(existing);
        }
      }

      // 同名不同内容 → 自动改名 "stem N.ext"
      let finalFilename = filename;
      const dotIdx = filename.lastIndexOf('.');
      const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
      const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';
      let counter = 1;
      while (await findByPath(finalFilename, dirPath)) {
        counter += 1;
        finalFilename = `${stem} ${counter}${ext}`;
      }
      if (finalFilename !== filename) title = titleFromFilename(finalFilename);

      const relative = `${dirPath.replace(/\/$/, '')}/${finalFilename}`.replace(/^\//, '');
      const filePath = safeResolve(relative);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');

      const sourceKind = dirPath.replace(/^\//, '').startsWith('wiki') ? 'wiki' : 'source';
      let ownerId: string | null = null;
      if (dirPath.includes('/personal/')) {
        const u = await db.query('SELECT 1 FROM jz_users WHERE id = $1', [userId]);
        if (u.rows.length > 0) ownerId = userId;
      }

      const docId = randomUUID();
      await db.query(
        'INSERT INTO jz_kb_documents ' +
          '(id, owner_user_id, filename, title, path, relative_path, source_kind, ' +
          "file_type, status, content, tags, version) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7, 'md', 'ready', $8, $9, 0)",
        [docId, ownerId, finalFilename, title, dirPath, relative, sourceKind, content, tags],
      );

      if (content) {
        await chunkRepo.storeChunks(docId, chunkText(content));
      }

      return reply.code(201).send({
        id: docId,
        filename: finalFilename,
        path: dirPath,
        title,
        relative_path: relative,
        source_kind: sourceKind,
        status: 'ready',
      });
    });

    app.put('/v1/documents/:doc_id/content', async (req, reply) => {
      const { doc_id } = req.params as { doc_id: string };
      const body = (req.body || {}) as { content?: string };
      const content = body.content ?? '';
      const doc = await repo.get(doc_id, null, '');
      if (!doc) return reply.code(404).send({ detail: 'Document not found' });

      const fp = docDiskPath(doc);
      if (fp) {
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content, 'utf-8');
      }
      await db.query('UPDATE jz_kb_documents SET content = $1, updated_at = NOW() WHERE id = $2', [
        content,
        doc_id,
      ]);
      if (content) {
        await chunkRepo.storeChunks(doc_id, chunkText(content));
      }
      return repo.get(doc_id, null, '');
    });

    app.patch('/v1/documents/:doc_id', async (req, reply) => {
      const { doc_id } = req.params as { doc_id: string };
      const body = (req.body || {}) as Record<string, any>;
      const sets: string[] = [];
      const params: any[] = [];
      let idx = 1;
      for (const [k, v] of Object.entries(body)) {
        if (v !== null && v !== undefined && UPDATABLE_FIELDS.has(k)) {
          sets.push(`${k} = $${idx++}`);
          params.push(v);
        }
      }
      if (sets.length === 0) return reply.code(400).send({ detail: 'No fields to update' });
      params.push(doc_id);
      await db.query(
        `UPDATE jz_kb_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
        params,
      );
      const doc = await repo.get(doc_id, null, '');
      if (!doc) return reply.code(404).send({ detail: 'Document not found' });
      return doc;
    });

    app.delete('/v1/documents/:doc_id', async (req, reply) => {
      const { doc_id } = req.params as { doc_id: string };
      const doc = await repo.get(doc_id, null, '');
      if (doc) {
        const fp = docDiskPath(doc);
        if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      const r = await db.query("UPDATE jz_kb_documents SET status = 'archived' WHERE id = $1", [doc_id]);
      if (r.rowCount === 0) return reply.code(404).send({ detail: 'Document not found' });
      return reply.code(204).send();
    });

    app.post('/v1/documents/bulk-delete', async (req, reply) => {
      const body = (req.body || {}) as { ids?: string[] };
      const ids = body.ids || [];
      if (ids.length === 0) return reply.code(204).send();
      for (const docId of ids) {
        const doc = await repo.get(docId, null, '');
        if (doc) {
          const fp = docDiskPath(doc);
          if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
        }
      }
      // 对齐 Python pg_local：bulk 为硬删除
      await db.query('DELETE FROM jz_kb_documents WHERE id = ANY($1)', [ids]);
      return reply.code(204).send();
    });
  };
}
