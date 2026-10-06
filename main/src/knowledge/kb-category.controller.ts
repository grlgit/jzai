import { Controller, Get, Post, Put, Delete, Body, Param, Req, ForbiddenException, Logger } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { DbService } from '../db/db.service';
import { UserService, Permission } from '../user/user.service';
import { KbAccessService } from './kb-access.service';
import { SpacesService, ENTERPRISE_SPACE_SLUG } from './spaces.service';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 知识分类树与同义词管理（自 bridge/knowledge 迁入，space 化）。
 * T0 范围：分类树仅管理企业空间（ent-default）；APP 空间的分类管理在 T1+ 由 APP 自行负责。
 */
@SkipThrottle()
@Controller('api/kb/categories')
export class KbCategoryController {
  private readonly logger = new Logger(KbCategoryController.name);

  constructor(
    private readonly db: DbService,
    private readonly userService: UserService,
    private readonly kbAccess: KbAccessService,
    private readonly spaces: SpacesService,
  ) {}

  private requirePermission(req: any, perm: Permission) {
    const token = (req.headers?.authorization || '').replace('Bearer ', '');
    if (!token || !this.userService.hasPermission(token, perm)) throw new ForbiddenException('权限不足');
  }

  private resolveCaller(req: any): { userId: string; permissions: string[] } | null {
    const token = (req.headers?.authorization || '').replace('Bearer ', '');
    if (!token) return null;
    const user = this.userService.verifyToken(token);
    if (!user) return null;
    return { userId: user.id, permissions: user.role.permissions || [] };
  }

  private async enterpriseSpaceId(): Promise<string> {
    const space = await this.spaces.resolve(ENTERPRISE_SPACE_SLUG);
    return space!.id;
  }

  // ===== Categories CRUD =====

  @Get()
  async listCategories(@Req() req: any) {
    this.requirePermission(req, 'kb:read');
    const caller = this.resolveCaller(req);
    const scopes = caller ? await this.kbAccess.getAccessibleScopesForUser(caller.userId) : [];
    const spaceId = await this.enterpriseSpaceId();

    if (scopes === 'ADMIN_ALL') {
      const { rows } = await this.db.query(
        'SELECT * FROM jz_kb_categories WHERE space_id = $1 ORDER BY sort_order, name',
        [spaceId],
      );
      return rows;
    }

    if (!scopes.length) {
      return [];
    }

    const { rows } = await this.db.query(
      'SELECT * FROM jz_kb_categories WHERE space_id = $1 AND id = ANY($2::text[]) ORDER BY sort_order, name',
      [spaceId, scopes],
    );
    return rows;
  }

  @Post()
  async createCategory(@Req() req: any, @Body() body: {
    name: string; slug: string; path: string; parent_id?: string;
    tags?: string[]; template?: string; description?: string; icon?: string;
  }) {
    this.requirePermission(req, 'kb:write');
    const id = crypto.randomUUID();
    const spaceId = await this.enterpriseSpaceId();
    await this.db.query(
      `INSERT INTO jz_kb_categories (id, parent_id, name, slug, path, tags, template, description, icon, space_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, body.parent_id || null, body.name, body.slug, body.path,
       body.tags || [], body.template || null, body.description || null, body.icon || null, spaceId],
    );
    const { rows } = await this.db.query('SELECT * FROM jz_kb_categories WHERE id = $1', [id]);

    // Create corresponding directories on filesystem: /raw/{path}/ and /wiki/{path}/
    this.ensureCategoryDirs(body.path).catch(e => this.logger.warn(`Dir creation failed: ${e.message}`));

    return rows[0];
  }

  /** 在企业空间磁盘根创建 /raw/{catPath}/ 与 /wiki/{catPath}/ 目录 */
  private async ensureCategoryDirs(catPath: string) {
    if (!catPath) return;
    const root = this.spaces.rootFor(ENTERPRISE_SPACE_SLUG);
    const segments = catPath.split('/').filter(Boolean);
    for (const base of ['raw', 'wiki']) {
      const dir = path.resolve(root, base, ...segments);
      if (!dir.startsWith(path.resolve(root) + path.sep)) continue;
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  @Put(':id')
  async updateCategory(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requirePermission(req, 'kb:write');
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    for (const key of ['name', 'slug', 'path', 'parent_id', 'tags', 'template', 'description', 'icon', 'sort_order']) {
      if (body[key] !== undefined) { fields.push(`${key} = $${idx}`); values.push(body[key]); idx++; }
    }
    if (fields.length === 0) return { updated: false };
    values.push(id);
    await this.db.query(`UPDATE jz_kb_categories SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    const { rows } = await this.db.query('SELECT * FROM jz_kb_categories WHERE id = $1', [id]);
    return rows[0];
  }

  @Delete(':id')
  async deleteCategory(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'kb:write');
    await this.db.query('DELETE FROM jz_kb_categories WHERE id = $1', [id]);
    return { deleted: true };
  }

  /** Clear all wiki pages under a category path. Admin only. Source docs in /raw/ are kept. */
  @Delete(':id/wiki')
  async clearCategoryWiki(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'sys:admin');
    const spaceId = await this.enterpriseSpaceId();
    const { rows } = await this.db.query('SELECT path FROM jz_kb_categories WHERE id = $1', [id]);
    if (!rows[0]) return { deleted: 0 };
    const catPath = rows[0].path;
    const wikiPath = `/wiki${catPath}/`;

    // 1. Delete DB records（硬删，对齐原 bulk-delete 语义）
    const wikiDocs = await this.db.query(
      "SELECT id FROM jz_kb_documents WHERE path LIKE $1 AND source_kind = 'wiki' AND space_id = $2",
      [wikiPath + '%', spaceId],
    );
    const ids = wikiDocs.rows.map((d: any) => d.id);
    if (ids.length > 0) {
      await this.db.query('DELETE FROM jz_kb_documents WHERE id = ANY($1)', [ids]);
    }

    // 2. Delete disk files
    const diskDir = path.join(this.spaces.rootFor(ENTERPRISE_SPACE_SLUG), 'wiki', ...catPath.split('/').filter(Boolean));
    try {
      const files = fs.readdirSync(diskDir).filter(f => f.endsWith('.md'));
      for (const f of files) { fs.unlinkSync(path.join(diskDir, f)); }
      this.logger.log(`Cleared ${files.length} disk files from ${diskDir}`);
    } catch { /* dir may not exist */ }

    this.logger.log(`Cleared wiki under ${wikiPath}: ${ids.length} docs`);
    return { deleted: ids.length, path: wikiPath };
  }

  // ===== Category Access (Permissions) =====

  @Get(':id/access')
  async listAccess(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'kb:read');
    const { rows } = await this.db.query(
      'SELECT * FROM jz_kb_category_access WHERE category_id = $1 ORDER BY grantee_type, grantee_id', [id]);
    return rows;
  }

  @Post(':id/access')
  async grantAccess(@Req() req: any, @Param('id') id: string, @Body() body: {
    grantee_type: 'department' | 'workgroup' | 'user'; grantee_id: string; role?: string;
  }) {
    this.requirePermission(req, 'kb:write');
    const aid = crypto.randomUUID();
    await this.db.query(
      `INSERT INTO jz_kb_category_access (id, category_id, grantee_type, grantee_id, role)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (category_id, grantee_type, grantee_id) DO UPDATE SET role = $5`,
      [aid, id, body.grantee_type, body.grantee_id, body.role || 'viewer'],
    );
    return { id: aid, category_id: id, grantee_type: body.grantee_type, grantee_id: body.grantee_id, role: body.role || 'viewer' };
  }

  @Delete(':catId/access/:accessId')
  async revokeAccess(@Req() req: any, @Param('catId') catId: string, @Param('accessId') accessId: string) {
    this.requirePermission(req, 'kb:write');
    await this.db.query('DELETE FROM jz_kb_category_access WHERE id = $1 AND category_id = $2', [accessId, catId]);
    return { deleted: true };
  }
}

// ===== Synonyms Controller =====

@SkipThrottle()
@Controller('api/kb/synonyms')
export class KbSynonymController {
  constructor(
    private readonly db: DbService,
    private readonly userService: UserService,
  ) {}

  private requirePermission(req: any, perm: Permission) {
    const token = (req.headers?.authorization || '').replace('Bearer ', '');
    if (!token || !this.userService.hasPermission(token, perm)) throw new ForbiddenException('权限不足');
  }

  @Get()
  async list(@Req() req: any) {
    this.requirePermission(req, 'kb:read');
    const { rows } = await this.db.query('SELECT * FROM jz_kb_synonyms ORDER BY keyword');
    return rows;
  }

  @Put()
  async bulkUpdate(@Req() req: any, @Body() body: { synonyms: Record<string, string[]> }) {
    this.requirePermission(req, 'kb:write');
    await this.db.query('DELETE FROM jz_kb_synonyms');
    for (const [keyword, values] of Object.entries(body.synonyms || {})) {
      const id = crypto.randomUUID();
      await this.db.query(
        'INSERT INTO jz_kb_synonyms (id, keyword, synonyms) VALUES ($1, $2, $3)',
        [id, keyword, values],
      );
    }
    return { ok: true };
  }
}
