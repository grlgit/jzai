import {
  Controller, Get, Post, Put, Patch, Delete, Body, Param, Query, Req, Res,
  Headers, ForbiddenException, UnauthorizedException, NotFoundException,
  UseInterceptors, UploadedFile, Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle } from '@nestjs/throttler';
import * as express from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DbService } from '../db/db.service';
import { UserService } from '../user/user.service';
import { SpacesService, KbSpace, ENTERPRISE_SPACE_SLUG } from './spaces.service';
import { KbAccessService } from './kb-access.service';
import { ProcessorService } from './processor/processor.service';
import { DocRepository, ChunkRepository } from './shared/repository';
import { chunkText } from './shared/chunker';
import { scopeFilterSql } from './shared/scopes';
import { parseFrontmatter, titleFromFilename, extractTags } from './shared/frontmatter';

const UPDATABLE_FIELDS = new Set([
  'filename', 'path', 'title', 'tags', 'date', 'metadata',
  'relative_path', 'source_kind', 'status', 'sensitivity',
]);

const SIMPLE_TEXT_TYPES = new Set(['md', 'txt', 'csv', 'svg', 'json', 'xml']);
const NEEDS_PROCESSING = new Set([
  'pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls', 'html', 'htm',
  'png', 'jpg', 'jpeg', 'webp', 'gif',
]);

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

interface Caller {
  userId: string;
  permissions: string[];
  token: string;
  isAdmin: boolean;
}

/**
 * KbApiController — 知识库 HTTP API（替代原 bridge/knowledge KbController 的 kbs 代理）。
 * 保持 /api/kb/v1/* 路径与响应结构兼容；鉴权改为主台 JWT + 空间可见性。
 */
@SkipThrottle()
@Controller('api/kb')
export class KbApiController {
  private readonly logger = new Logger(KbApiController.name);

  constructor(
    private readonly db: DbService,
    private readonly userService: UserService,
    private readonly spaces: SpacesService,
    private readonly kbAccess: KbAccessService,
    private readonly processor: ProcessorService,
  ) {}

  // ── 鉴权与空间解析 ───────────────────────────────────────────────────────

  private async resolveCaller(auth: string): Promise<Caller | null> {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return null;
    const user = this.userService.verifyToken(token);
    if (!user) return null;
    const isAdmin = await this.kbAccess.isAdmin(user.id);
    return { userId: user.id, permissions: user.role.permissions || [], token, isAdmin };
  }

  private requirePermission(caller: Caller, perm: 'kb:read' | 'kb:write') {
    if (!this.userService.hasPermission(caller.token, perm as any)) {
      throw new ForbiddenException('权限不足');
    }
  }

  /** 解析空间并校验可读；不可见 → 404（不暴露存在性） */
  private async resolveReadableSpace(kbId: string, caller: Caller): Promise<KbSpace> {
    const space = await this.spaces.resolve(kbId);
    if (!space || !this.spaces.canRead(space, caller.userId, caller.isAdmin)) {
      throw new NotFoundException({ detail: 'Knowledge base not found' });
    }
    return space;
  }

  private requireWritable(space: KbSpace, caller: Caller) {
    if (!this.spaces.canWrite(space, caller.userId, caller.isAdmin)) {
      throw new ForbiddenException({ detail: '该空间为只读' });
    }
  }

  private async scopesFor(caller: Caller): Promise<Set<string> | null> {
    const scopes = await this.kbAccess.getAccessibleScopesForUser(caller.userId);
    if (scopes === 'ADMIN_ALL') return null;
    return new Set(scopes);
  }

  private safeResolve(root: string, relative: string): string {
    const ws = path.resolve(root);
    const resolved = path.resolve(ws, relative);
    if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
      throw new ForbiddenException({ detail: 'Path escapes workspace' });
    }
    return resolved;
  }

  private docDiskPath(space: KbSpace, doc: any): string | null {
    const relative = `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    const ws = path.resolve(this.spaces.rootFor(space.slug));
    const resolved = path.resolve(ws, relative);
    return resolved.startsWith(ws + path.sep) ? resolved : null;
  }

  // ── 个人知识（主台端点）──────────────────────────────────────────────────

  @Post('personal-knowledge')
  async savePersonalKnowledge(
    @Body() body: { content: string; title?: string; tags?: string[] },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();

    const space = await this.spaces.ensurePersonalSpace(caller.userId);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = body.title || `知识笔记 ${timestamp.slice(0, 10)}`;
    const tags = body.tags || ['personal'];
    const filename = `${timestamp}.md`;

    const frontmatter = [
      '---',
      `title: ${title}`,
      'description: 个人知识',
      'tags:',
      ...tags.map((t) => `  - ${t}`),
      '---',
      '',
    ].join('\n');

    const result = await this.createNote(space, caller, {
      filename,
      path: '/raw/',
      content: frontmatter + body.content,
    });
    return { success: true, data: result };
  }

  // ── 空间（兼容旧 /v1/knowledge-bases）────────────────────────────────────

  @Get('v1/knowledge-bases')
  async listKnowledgeBases(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    return this.spaces.listVisible(caller.userId, caller.isAdmin);
  }

  @Post('v1/knowledge-bases')
  async createKnowledgeBase(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const list = await this.spaces.listVisible(caller.userId, caller.isAdmin);
    return list[0] || null;
  }

  @Get('v1/knowledge-bases/:kbId')
  async getKnowledgeBase(@Param('kbId') kbId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const list = await this.spaces.listVisible(caller.userId, caller.isAdmin);
    const space = await this.resolveReadableSpace(kbId, caller);
    return list.find((s: any) => s.slug === space.slug) || null;
  }

  @Patch('v1/knowledge-bases/:kbId')
  async patchKnowledgeBase(@Param('kbId') kbId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const list = await this.spaces.listVisible(caller.userId, caller.isAdmin);
    const space = await this.resolveReadableSpace(kbId, caller);
    return list.find((s: any) => s.slug === space.slug) || null;
  }

  @Delete('v1/knowledge-bases/:kbId')
  async deleteKnowledgeBase() {
    throw new ForbiddenException({ detail: 'Cannot delete space via API' });
  }

  // ── 文档读 ──────────────────────────────────────────────────────────────

  @Get('v1/knowledge-bases/:kbId/documents')
  async listDocuments(
    @Param('kbId') kbId: string,
    @Query('path') docPath: string,
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:read');
    const space = await this.resolveReadableSpace(kbId, caller);
    const repo = new DocRepository(this.db);
    return repo.list({ path: docPath, spaceId: space.id, scopes: await this.scopesFor(caller), userId: caller.userId });
  }

  @Get('v1/knowledge-bases/:kbId/search')
  async searchDocuments(
    @Param('kbId') kbId: string,
    @Query('q') q: string,
    @Query('limit') limitRaw: string,
    @Query('scope') scope: string,
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:read');
    const space = await this.resolveReadableSpace(kbId, caller);
    if (!q || q.length < 1) return { detail: 'q is required' };

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
      "AND d.status = 'ready' AND d.space_id = $2 ";
    const params: any[] = [q, space.id];

    if (scope === 'wiki') sql += "AND d.source_kind = 'wiki' ";
    else if (scope === 'sources') sql += "AND d.source_kind != 'wiki' ";

    sql += "AND COALESCE(d.sensitivity, 'public') != 'restricted' ";

    const sf = scopeFilterSql(await this.scopesFor(caller), 3, 'd', caller.userId);
    sql += sf.sql;
    params.push(...sf.params);

    sql += `ORDER BY score DESC LIMIT $${sf.nextIdx}`;
    params.push(limit);

    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  @Get('v1/documents/:docId')
  async getDocument(@Param('docId') docId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:read');
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    return doc;
  }

  @Get('v1/documents/:docId/url')
  async getDocumentUrl(@Param('docId') docId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:read');
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const relative =
      doc.relative_path || `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    const space = await this.spaces.resolve(doc.space_id);
    return { url: `/api/kb/v1/files/spaces/${space?.slug || ENTERPRISE_SPACE_SLUG}/${relative}` };
  }

  @Get('v1/documents/:docId/content')
  async getDocumentContent(@Param('docId') docId: string, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:read');
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const { rows } = await this.db.query(
      'SELECT id, filename, path, content, file_type FROM jz_kb_documents WHERE id = $1',
      [docId],
    );
    return rows[0] || null;
  }

  @Get('v1/documents/:docId/extractions')
  async getExtractions() {
    throw new NotFoundException({ detail: 'Extractions not available' });
  }

  private async getReadableDoc(docId: string, caller: Caller): Promise<any | null> {
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    const doc = rows[0];
    if (!doc) return null;
    const space = await this.spaces.resolve(doc.space_id);
    if (!space || !this.spaces.canRead(space, caller.userId, caller.isAdmin)) return null;
    if (!caller.isAdmin && doc.category_id) {
      const scopes = await this.kbAccess.getAccessibleScopesForUser(caller.userId);
      if (scopes !== 'ADMIN_ALL' && !scopes.includes(String(doc.category_id)) && doc.owner_user_id !== caller.userId) {
        return null;
      }
    }
    return doc;
  }

  // ── 文档写 ──────────────────────────────────────────────────────────────

  @Post('v1/knowledge-bases/:kbId/documents/note')
  async createNoteEndpoint(
    @Param('kbId') kbId: string,
    @Body() body: { filename?: string; path?: string; content?: string },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:write');
    const space = await this.resolveReadableSpace(kbId, caller);
    this.requireWritable(space, caller);
    return this.createNote(space, caller, body);
  }

  private async createNote(
    space: KbSpace,
    caller: Caller,
    body: { filename?: string; path?: string; content?: string },
  ) {
    const filename = body.filename;
    if (!filename) throw new NotFoundException({ detail: 'filename is required' });
    const dirPath = body.path || '/';
    const content = body.content ?? '';

    const meta = parseFrontmatter(content);
    let title = (meta.title || '').trim() || titleFromFilename(filename);
    const tags = extractTags(meta);

    const findByPath = async (fn: string) => {
      const { rows } = await this.db.query(
        "SELECT * FROM jz_kb_documents WHERE filename = $1 AND path = $2 AND space_id = $3 AND status != 'archived'",
        [fn, dirPath, space.id],
      );
      return rows[0] || null;
    };

    if (content) {
      const existing = await findByPath(filename);
      if (existing && (existing.content || '') === content) {
        return existing;
      }
    }

    let finalFilename = filename;
    const dotIdx = filename.lastIndexOf('.');
    const stem = dotIdx > 0 ? filename.slice(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';
    let counter = 1;
    while (await findByPath(finalFilename)) {
      counter += 1;
      finalFilename = `${stem} ${counter}${ext}`;
    }
    if (finalFilename !== filename) title = titleFromFilename(finalFilename);

    const relative = `${dirPath.replace(/\/$/, '')}/${finalFilename}`.replace(/^\//, '');
    const filePath = this.safeResolve(this.spaces.rootFor(space.slug), relative);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');

    const sourceKind = dirPath.replace(/^\//, '').startsWith('wiki') ? 'wiki' : 'source';
    const ownerId = space.subtype === 'personal' ? caller.userId : null;

    const docId = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO jz_kb_documents ' +
        '(id, owner_user_id, filename, title, path, relative_path, source_kind, ' +
        "file_type, status, content, tags, version, space_id) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, 'md', 'ready', $8, $9, 0, $10)",
      [docId, ownerId, finalFilename, title, dirPath, relative, sourceKind, content, tags, space.id],
    );

    if (content) {
      await new ChunkRepository(this.db).storeChunks(docId, chunkText(content));
    }

    return {
      id: docId,
      filename: finalFilename,
      path: dirPath,
      title,
      relative_path: relative,
      source_kind: sourceKind,
      status: 'ready',
    };
  }

  @Put('v1/documents/:docId/content')
  async updateContent(
    @Param('docId') docId: string,
    @Body() body: { content?: string },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:write');
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const space = await this.spaces.resolve(doc.space_id);
    this.requireWritable(space!, caller);

    const content = body.content ?? '';
    const fp = this.docDiskPath(space!, doc);
    if (fp) {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      fs.writeFileSync(fp, content, 'utf-8');
    }
    await this.db.query('UPDATE jz_kb_documents SET content = $1, updated_at = NOW() WHERE id = $2', [
      content,
      docId,
    ]);
    if (content) {
      await new ChunkRepository(this.db).storeChunks(docId, chunkText(content));
    }
    const { rows } = await this.db.query('SELECT * FROM jz_kb_documents WHERE id = $1', [docId]);
    return rows[0];
  }

  @Patch('v1/documents/:docId')
  async patchDocument(
    @Param('docId') docId: string,
    @Body() body: Record<string, any>,
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:write');
    const doc = await this.getReadableDoc(docId, caller);
    if (!doc) throw new NotFoundException({ detail: 'Document not found' });
    const space = await this.spaces.resolve(doc.space_id);
    this.requireWritable(space!, caller);

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

  @Delete('v1/documents/:docId')
  async deleteDocument(@Param('docId') docId: string, @Headers('authorization') auth: string, @Res() res: express.Response) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:write');
    const doc = await this.getReadableDoc(docId, caller);
    if (doc) {
      const space = await this.spaces.resolve(doc.space_id);
      this.requireWritable(space!, caller);
      const fp = this.docDiskPath(space!, doc);
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    const r = await this.db.query("UPDATE jz_kb_documents SET status = 'archived' WHERE id = $1", [docId]);
    if (r.rowCount === 0) throw new NotFoundException({ detail: 'Document not found' });
    return res.status(204).send();
  }

  @Post('v1/documents/bulk-delete')
  async bulkDelete(@Body() body: { ids?: string[] }, @Headers('authorization') auth: string, @Res() res: express.Response) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:write');
    const ids = body?.ids || [];
    for (const docId of ids) {
      const doc = await this.getReadableDoc(docId, caller);
      if (doc) {
        const space = await this.spaces.resolve(doc.space_id);
        this.requireWritable(space!, caller);
        const fp = this.docDiskPath(space!, doc);
        if (fp && fs.existsSync(fp)) fs.unlinkSync(fp);
      }
    }
    if (ids.length > 0) {
      await this.db.query('DELETE FROM jz_kb_documents WHERE id = ANY($1)', [ids]);
    }
    return res.status(204).send();
  }

  // ── 上传 ────────────────────────────────────────────────────────────────

  @Post('v1/upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(
    @UploadedFile() file: any,
    @Body() body: { path?: string; space?: string },
    @Headers('authorization') auth: string,
  ) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:write');
    if (!file?.buffer || !file.originalname) {
      throw new NotFoundException({ detail: 'No filename' });
    }

    const space = await this.resolveReadableSpace(body?.space || ENTERPRISE_SPACE_SLUG, caller);
    this.requireWritable(space, caller);

    // multer/busboy 默认 defParamCharset=latin1，浏览器发来的 UTF-8 文件名会被误解码，需转回
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
        textContent !== null ? 'ready' : 'pending',
        textContent, contentHash, mtimeNs,
        space.id,
        space.subtype === 'personal' ? caller.userId : null,
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

  // ── 文件服务（Range + ETag + 防穿越，空间感知）──────────────────────────

  @Get('v1/files/*')
  async serveFile(@Req() req: express.Request, @Res() res: express.Response, @Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    this.requirePermission(caller, 'kb:read');

    // Express 5：从 URL 派生通配段
    const idx = req.path.indexOf('/v1/files/');
    const key = idx >= 0 ? decodeURIComponent(req.path.slice(idx + '/v1/files/'.length)) : '';
    if (!key) throw new NotFoundException({ detail: 'File not found' });

    const filePath = this.resolveFileKey(key, caller);
    if (!filePath) throw new NotFoundException({ detail: 'File not found' });

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

  /**
   * 文件 key 解析（按优先级）：
   * 1. spaces/{slug}/... 显式空间路径
   * 2. 各可见空间根（企业空间、本人个人空间）
   * 3. 空间内 .llmwiki/cache/ 派生缓存
   * 4. legacy 工作区根（旧文件，不迁移，逐步淘汰）
   */
  private resolveFileKey(key: string, caller: Caller): string | null {
    const kbRoot = path.resolve(this.spaces.kbRoot);
    const candidates: string[] = [];

    if (key.startsWith('spaces/')) {
      candidates.push(path.resolve(kbRoot, key));
    } else {
      for (const slug of [ENTERPRISE_SPACE_SLUG, `u-${caller.userId}`]) {
        const spaceRoot = this.spaces.rootFor(slug);
        candidates.push(path.resolve(spaceRoot, key));
        candidates.push(path.resolve(spaceRoot, '.llmwiki', 'cache', key));
      }
      // legacy 兼容（旧文件弃置原位，不再写入）
      candidates.push(path.resolve(kbRoot, key));
      candidates.push(path.resolve(kbRoot, '.llmwiki', 'cache', key));
    }

    for (const candidate of candidates) {
      if (!candidate.startsWith(kbRoot + path.sep)) continue;
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }
    return null;
  }

  // ── 用量 / me ───────────────────────────────────────────────────────────

  @Get('v1/usage')
  async getUsage(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const { rows } = await this.db.query(
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
  }

  @Get('v1/me')
  async getMe(@Headers('authorization') auth: string) {
    const caller = await this.resolveCaller(auth);
    if (!caller) throw new UnauthorizedException();
    const user = this.userService.verifyToken(caller.token);
    return {
      id: caller.userId,
      email: (user as any)?.email || '',
      display_name: (user as any)?.displayName || (user as any)?.email || '',
      onboarded: true,
    };
  }

  @Post('v1/onboarding/complete')
  async completeOnboarding(@Res() res: express.Response) {
    return res.status(204).send();
  }
}
