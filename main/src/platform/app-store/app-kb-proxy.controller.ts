import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Body,
  Query,
  Req,
  Res,
  Headers,
  UnauthorizedException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import * as express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DbService } from '../../db/db.service';
import { SpacesService, KbSpace } from '../../knowledge/spaces.service';
import { ProcessorService } from '../../knowledge/processor/processor.service';
import { DocRepository, ChunkRepository } from '../../knowledge/shared/repository';
import { chunkText } from '../../knowledge/shared/chunker';
import { titleFromFilename } from '../../knowledge/shared/frontmatter';
import { AppRegistryService } from './services/app-registry.service';
import { AppGrantService } from './services/app-grant.service';
import { InvocationContextFactory } from './runtime/invocation-context.factory';

const SIMPLE_TEXT_TYPES = new Set(['md', 'txt', 'csv', 'svg', 'json', 'xml']);
const NEEDS_PROCESSING = new Set([
  'pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
]);
const UPDATABLE_FIELDS = new Set([
  'filename', 'path', 'title', 'tags', 'date', 'metadata',
  'relative_path', 'source_kind', 'status', 'sensitivity',
]);
const MIME: Record<string, string> = {
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8',
  '.dxf': 'application/dxf',
};

/**
 * APP 知识空间存取代理（T2/P4）。
 *
 * 面板（用户 JWT + APP 授权）经本控制器存取 **该 APP 自有** 知识空间：
 * - 执行身份 = APP（owner_app_id = appId 的空间才可触达，写操作不再受
 *   "APP 空间对任何主台用户不可写" 限制——那是用户身份语义，此处是 APP 身份）
 * - 与 /api/kb/v1/* 的差异仅在 caller 构造与空间锁定；ingest/upsert/管线语义一致
 * - 空间不可枚举他人：所有文档操作强制 doc.space_id ∈ 本 APP 空间集
 */
@SkipThrottle()
@Controller('api/app-store/apps/:appId/kb')
export class AppKbProxyController {
  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
    private readonly grants: AppGrantService,
    private readonly invocationContexts: InvocationContextFactory,
    private readonly spaces: SpacesService,
    private readonly processor: ProcessorService,
  ) {}

  // ── 鉴权与空间锁定 ──────────────────────────────────────────────────────

  /** 校验：APP 存在且 active；调用者=管理员或有该 APP 授权。返回 principal。 */
  private async requireAppCaller(appId: string, req: any) {
    const app = await this.registry.findOne(appId);
    if (!app || app.status !== 'active') throw new NotFoundException(`App ${appId} not found`);
    const principal = this.invocationContexts.fromRequest(req, `app-kb:${appId}`);
    if (!principal) throw new UnauthorizedException();
    const isAdmin = principal.permissions.includes('sys:admin');
    if (!isAdmin) {
      const allowed = await this.grants.hasAppAccessForPrincipal(appId, principal);
      if (!allowed) throw new ForbiddenException(`No grant for app ${appId}`);
    }
    return principal;
  }

  /** 本 APP 的全部自有空间（owner_app_id = appId） */
  private async appSpaces(appId: string): Promise<KbSpace[]> {
    const { rows } = await this.db.query(
      "SELECT * FROM jz_kb_spaces WHERE type = 'app' AND owner_app_id = $1 ORDER BY created_at, slug",
      [appId],
    );
    return rows;
  }

  /** 解析目标空间：缺省取首个自有空间；给定时须属本 APP（slug 或 id） */
  private async resolveAppSpace(appId: string, spaceRef?: string): Promise<KbSpace> {
    const owned = await this.appSpaces(appId);
    if (owned.length === 0) throw new NotFoundException({ detail: 'App has no knowledge space' });
    if (!spaceRef) return owned[0];
    const hit = owned.find((s) => s.slug === spaceRef || String(s.id) === spaceRef);
    if (!hit) throw new NotFoundException({ detail: 'Knowledge base not found' });
    return hit;
  }

  /** 取文档并断言归属本 APP 空间（不暴露存在性） */
  private async getOwnedDoc(appId: string, docId: string): Promise<{ doc: any; space: KbSpace }> {
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    const doc = rows[0];
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const space = await this.spaces.resolve(doc.space_id);
    if (!space || space.type !== 'app' || space.owner_app_id !== appId) {
      throw new NotFoundException({ detail: 'Document not found' });
    }
    return { doc, space };
  }

  private safeResolve(root: string, relative: string): string {
    const ws = path.resolve(root);
    const resolved = path.resolve(ws, relative);
    if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
      throw new ForbiddenException({ detail: 'Path escapes workspace' });
    }
    return resolved;
  }

  // ── 文档列表 / 检索 ─────────────────────────────────────────────────────

  @Get('documents')
  async listDocuments(
    @Param('appId') appId: string,
    @Query('path') docPath: string,
    @Query('space') spaceRef: string,
    @Req() req: any,
  ) {
    await this.requireAppCaller(appId, req);
    const space = await this.resolveAppSpace(appId, spaceRef);
    const repo = new DocRepository(this.db);
    return repo.list({ path: docPath, spaceId: space.id, scopes: null, userId: '' });
  }

  @Get('search')
  async searchDocuments(
    @Param('appId') appId: string,
    @Query('q') q: string,
    @Query('limit') limitRaw: string,
    @Query('scope') scope: string,
    @Query('space') spaceRef: string,
    @Req() req: any,
  ) {
    await this.requireAppCaller(appId, req);
    const space = await this.resolveAppSpace(appId, spaceRef);
    if (!q || q.length < 1) return { detail: 'q is required' };

    let limit = parseInt(limitRaw || '20', 10);
    if (Number.isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;

    let sql =
      'SELECT dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index, ' +
      'd.id AS document_id, d.filename, d.title, d.path, d.file_type, d.tags, d.category_id, d.metadata, ' +
      'similarity(dc.content, $1) AS score ' +
      'FROM jz_kb_document_chunks dc ' +
      'JOIN jz_kb_documents d ON dc.document_id = d.id ' +
      "WHERE dc.content ILIKE '%' || $1 || '%' " +
      "AND d.status = 'ready' AND d.space_id = $2 ";
    const params: any[] = [q, space.id];

    if (scope === 'wiki') sql += "AND d.source_kind = 'wiki' ";
    else if (scope === 'sources') sql += "AND d.source_kind != 'wiki' ";
    sql += "AND COALESCE(d.sensitivity, 'public') != 'restricted' ";
    sql += 'ORDER BY score DESC LIMIT $3';
    params.push(limit);

    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  // ── 文档读取 ────────────────────────────────────────────────────────────

  @Get('documents/:docId')
  async getDocument(@Param('appId') appId: string, @Param('docId') docId: string, @Req() req: any) {
    await this.requireAppCaller(appId, req);
    const { doc } = await this.getOwnedDoc(appId, docId);
    return doc;
  }

  @Get('documents/:docId/content')
  async getDocumentContent(@Param('appId') appId: string, @Param('docId') docId: string, @Req() req: any) {
    await this.requireAppCaller(appId, req);
    await this.getOwnedDoc(appId, docId);
    const { rows } = await this.db.query(
      'SELECT id, filename, path, content, file_type FROM jz_kb_documents WHERE id = $1',
      [docId],
    );
    return rows[0] || null;
  }

  @Get('documents/:docId/url')
  async getDocumentUrl(@Param('appId') appId: string, @Param('docId') docId: string, @Req() req: any) {
    await this.requireAppCaller(appId, req);
    const { doc } = await this.getOwnedDoc(appId, docId);
    const relative =
      doc.relative_path || `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    return { url: `/api/app-store/apps/${encodeURIComponent(appId)}/kb/files/${relative}` };
  }

  // ── 文件服务（本 APP 空间根内，Range + ETag + 防穿越）───────────────────

  @Get('files/*')
  async serveFile(
    @Param('appId') appId: string,
    @Query('space') spaceRef: string,
    @Req() req: express.Request,
    @Res() res: express.Response,
  ) {
    await this.requireAppCaller(appId, req);
    const space = await this.resolveAppSpace(appId, spaceRef);

    const idx = req.path.indexOf('/kb/files/');
    const key = idx >= 0 ? decodeURIComponent(req.path.slice(idx + '/kb/files/'.length)) : '';
    if (!key) throw new NotFoundException({ detail: 'File not found' });

    let filePath: string;
    try {
      filePath = this.safeResolve(this.spaces.rootFor(space.slug), key);
    } catch {
      throw new NotFoundException({ detail: 'File not found' });
    }
    // 同时允许空间内 .llmwiki/cache/ 派生缓存
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      const cached = this.safeResolve(
        path.join(this.spaces.rootFor(space.slug), '.llmwiki', 'cache'),
        key,
      );
      if (fs.existsSync(cached) && fs.statSync(cached).isFile()) filePath = cached;
      else throw new NotFoundException({ detail: 'File not found' });
    }

    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || 'application/octet-stream';
    const etag = `"${crypto.createHash('sha256').update(`${filePath}:${stat.mtimeMs}:${stat.size}`).digest('hex').slice(0, 32)}"`;

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).setHeader('ETag', etag).send();
    }

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [startStr, endStr] = range.slice(6).split('-', 2);
      const start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      if (Number.isNaN(start) || start < 0 || start >= stat.size) {
        return res.status(416).send({ detail: 'Range not satisfiable' });
      }
      if (Number.isNaN(end)) end = stat.size - 1;
      end = Math.min(end, stat.size - 1);
      const length = end - start + 1;
      res.status(206);
      res.set({
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': length,
        'Accept-Ranges': 'bytes',
        ETag: etag,
      });
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.set({
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      ETag: etag,
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  // ── 上传 / 修改 / 删除（APP 身份写自有空间）─────────────────────────────

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @Param('appId') appId: string,
    @UploadedFile() file: any,
    @Body() body: { path?: string; space?: string },
    @Req() req: any,
  ) {
    await this.requireAppCaller(appId, req);
    if (!file?.buffer || !file.originalname) {
      throw new BadRequestException({ detail: 'No filename' });
    }
    const space = await this.resolveAppSpace(appId, body?.space);

    // multer/busboy 默认 defParamCharset=latin1，UTF-8 文件名需转回（同 kb-api 修复）
    const filename = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const dirParam = (body?.path || '/').trim() || '/';
    const relative = `${dirParam.replace(/\/$/, '')}/${filename}`.replace(/^\//, '');
    const dest = this.safeResolve(this.spaces.rootFor(space.slug), relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const contentBytes: Buffer = file.buffer;
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
    const contentHash = crypto.createHash('sha256').update(contentBytes).digest('hex');

    let textContent: string | null = null;
    if (SIMPLE_TEXT_TYPES.has(ext)) {
      textContent = contentBytes.toString('utf-8');
    }

    const stat = fs.statSync(dest);
    const mtimeNs = String(BigInt(Math.round(stat.mtimeMs)) * 1000000n);

    const docId = crypto.randomUUID();
    const { rows } = await this.db.query(
      'INSERT INTO jz_kb_documents (id, filename, title, path, relative_path, ' +
        'source_kind, file_type, file_size, status, content, content_hash, ' +
        'mtime_ns, last_indexed_at, space_id, owner_user_id) ' +
        'VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14) ' +
        'ON CONFLICT (space_id, relative_path) DO UPDATE SET ' +
        'filename = EXCLUDED.filename, title = EXCLUDED.title, ' +
        'file_size = EXCLUDED.file_size, status = EXCLUDED.status, ' +
        'content = EXCLUDED.content, content_hash = EXCLUDED.content_hash, ' +
        'mtime_ns = EXCLUDED.mtime_ns, updated_at = NOW() ' +
        'RETURNING id',
      [
        docId, filename, title, dirPath, relative, sourceKind,
        ext || 'bin', contentBytes.length,
        textContent !== null ? 'ready' : NEEDS_PROCESSING.has(ext) ? 'pending' : 'ready',
        textContent, contentHash, mtimeNs,
        space.id,
        null,
      ],
    );
    const finalDocId = rows[0].id;

    if (textContent) {
      await new ChunkRepository(this.db).storeChunks(finalDocId, chunkText(textContent));
    } else if (NEEDS_PROCESSING.has(ext)) {
      this.processor.enqueue(finalDocId);
    }

    const doc = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [finalDocId]);
    return doc.rows[0] || { id: finalDocId };
  }

  @Patch('documents/:docId')
  async patchDocument(
    @Param('appId') appId: string,
    @Param('docId') docId: string,
    @Body() body: Record<string, any>,
    @Req() req: any,
  ) {
    await this.requireAppCaller(appId, req);
    await this.getOwnedDoc(appId, docId);

    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const [k, v] of Object.entries(body || {})) {
      if (v !== null && v !== undefined && UPDATABLE_FIELDS.has(k)) {
        sets.push(`${k} = $${idx++}`);
        params.push(v);
      }
    }
    if (sets.length === 0) return { detail: 'No fields to update' };
    params.push(docId);
    await this.db.query(
      `UPDATE jz_kb_documents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${idx}`,
      params,
    );
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    return rows[0];
  }

  @Delete('documents/:docId')
  async deleteDocument(
    @Param('appId') appId: string,
    @Param('docId') docId: string,
    @Req() req: any,
    @Res() res: express.Response,
  ) {
    await this.requireAppCaller(appId, req);
    const { doc, space } = await this.getOwnedDoc(appId, docId);
    const relative = `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    try {
      const fp = this.safeResolve(this.spaces.rootFor(space.slug), relative);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {}
    await this.db.query("UPDATE jz_kb_documents SET status = 'archived' WHERE id = $1", [docId]);
    return res.status(204).send();
  }
}
