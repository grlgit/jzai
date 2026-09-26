/**
 * 对译 llm_wiki/api/routes/local_upload.py 的 pg_local 路径：
 * multipart 上传 → 写入工作区 → jz_kb_documents 建档（relative_path 冲突覆盖）
 * → 文本类即时分块 / 其余后台提取管线。
 */
import { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../../shared/db';
import { ChunkRepository } from '../../shared/chunk-repository';
import { chunkText } from '../../shared/chunker';
import { resolveUserId } from '../../shared/scopes';
import { titleFromFilename } from '../../shared/frontmatter';
import { enqueueProcessing, ProcessorOptions } from '../../processor';

const SIMPLE_TEXT_TYPES = new Set(['md', 'txt', 'csv', 'svg', 'json', 'xml']);
// Python 原集合 + 图片扩展（kbs 新增 tesseract OCR 后图片进入处理管线）
const NEEDS_PROCESSING = new Set([
  'pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
]);

export function uploadRoutes(db: Db, workspaceRoot: string, processorOpts: ProcessorOptions) {
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

  return async function (app: FastifyInstance) {
    app.post('/v1/upload', async (req, reply) => {
      // multipart 全量遍历：path 字段可能在 file 之后到达（web 前端即此顺序）
      let filename = '';
      let fileBytes: Buffer | null = null;
      let dirParam = '/';
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          filename = part.filename || '';
          fileBytes = await part.toBuffer();
        } else if (part.fieldname === 'path' && typeof part.value === 'string' && part.value.trim()) {
          dirParam = part.value.trim();
        }
      }
      if (!filename || !fileBytes) {
        return reply.code(400).send({ detail: 'No filename' });
      }
      const relative = `${dirParam.replace(/\/$/, '')}/${filename}`.replace(/^\//, '');
      const dest = safeResolve(relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const contentBytes = fileBytes;
      fs.writeFileSync(dest, contentBytes);

      const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
      const title = titleFromFilename(filename);
      const dirPath = relative.includes('/')
        ? `/${relative.split('/').slice(0, -1).join('/')}/`
        : '/';
      const sourceKind = relative.startsWith('wiki/assets/')
        ? 'asset'
        : relative.startsWith('wiki/')
          ? 'wiki'
          : 'source';
      const contentHash = createHash('sha256').update(contentBytes).digest('hex');

      let textContent: string | null = null;
      if (SIMPLE_TEXT_TYPES.has(ext)) {
        textContent = contentBytes.toString('utf-8');
      }

      const stat = fs.statSync(dest);
      const mtimeNs = String(BigInt(Math.round(stat.mtimeMs)) * 1000000n);

      // relative_path UNIQUE：重复上传同一路径覆盖旧文档
      const docId = randomUUID();
      const { rows } = await db.query(
        'INSERT INTO jz_kb_documents (id, filename, title, path, relative_path, ' +
          'source_kind, file_type, file_size, status, content, content_hash, ' +
          'mtime_ns, last_indexed_at) ' +
          'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()) ' +
          'ON CONFLICT (relative_path) DO UPDATE SET ' +
          'filename = EXCLUDED.filename, title = EXCLUDED.title, ' +
          'file_size = EXCLUDED.file_size, status = EXCLUDED.status, ' +
          'content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, ' +
          'mtime_ns = EXCLUDED.mtime_ns, updated_at = NOW() ' +
          'RETURNING id',
        [
          docId, filename, title, dirPath, relative, sourceKind,
          ext || 'bin', contentBytes.length,
          textContent !== null ? 'ready' : 'pending',
          textContent, contentHash, mtimeNs,
        ],
      );
      const finalDocId = rows[0].id;

      if (textContent) {
        await new ChunkRepository(db).storeChunks(finalDocId, chunkText(textContent));
      } else if (NEEDS_PROCESSING.has(ext)) {
        enqueueProcessing(db, finalDocId, processorOpts);
      }

      const doc = await db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [finalDocId]);
      return reply.code(201).send(doc.rows[0] || { id: finalDocId });
    });
  };
}
