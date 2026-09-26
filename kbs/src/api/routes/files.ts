/**
 * 对译 llm_wiki/api/routes/files.py：工作区文件服务（Range + ETag + 防穿越）。
 * 先查 .llmwiki/cache/（派生产物），再查工作区根（源文件）。
 * POST /v1/files/open（桌面打开）暂不移植。
 */
import { FastifyInstance } from 'fastify';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
};

export function filesRoutes(workspaceRoot: string) {
  const ws = path.resolve(workspaceRoot);

  function resolveSafe(key: string): string | null {
    const cachePath = path.resolve(ws, '.llmwiki', 'cache', key);
    if (cachePath.startsWith(ws + path.sep) && fs.existsSync(cachePath) && fs.statSync(cachePath).isFile()) {
      return cachePath;
    }
    const rootPath = path.resolve(ws, key);
    if (rootPath.startsWith(ws + path.sep) && fs.existsSync(rootPath) && fs.statSync(rootPath).isFile()) {
      return rootPath;
    }
    return null;
  }

  return async function (app: FastifyInstance) {
    app.get('/v1/files/*', async (req, reply) => {
      const key = (req.params as { '*': string })['*'];
      const filePath = resolveSafe(key);
      if (!filePath) return reply.code(404).send({ detail: 'File not found' });

      const stat = fs.statSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const etag = `"${crypto.createHash('sha256').update(`${filePath}:${stat.mtimeMs}:${stat.size}`).digest('hex').slice(0, 32)}"`;

      if (req.headers['if-none-match'] === etag) {
        return reply.code(304).header('ETag', etag).send();
      }

      const range = req.headers.range;
      if (range && range.startsWith('bytes=')) {
        const [startStr, endStr] = range.slice(6).split('-', 2);
        const start = startStr ? parseInt(startStr, 10) : 0;
        let end = endStr ? parseInt(endStr, 10) : stat.size - 1;
        if (Number.isNaN(start) || start < 0 || start >= stat.size) {
          return reply.code(416).send({ detail: 'Range not satisfiable' });
        }
        if (Number.isNaN(end)) end = stat.size - 1;
        end = Math.min(end, stat.size - 1);
        const length = end - start + 1;
        return reply
          .code(206)
          .headers({
            'Content-Type': contentType,
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Content-Length': length,
            'Accept-Ranges': 'bytes',
            ETag: etag,
          })
          .send(fs.createReadStream(filePath, { start, end }));
      }

      return reply
        .headers({
          'Content-Type': contentType,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
          ETag: etag,
        })
        .send(fs.createReadStream(filePath));
    });
  };
}
