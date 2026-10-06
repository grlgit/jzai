import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { DbService } from '../db/db.service';
import { WorkspaceService } from '../workspace/workspace.service';

export interface KbSpace {
  id: string;
  name: string;
  slug: string;
  type: 'normal' | 'app';
  subtype: 'enterprise' | 'personal' | null;
  owner_app_id: string | null;
  owner_user_id: string | null;
  description: string | null;
  config: Record<string, any>;
}

export const ENTERPRISE_SPACE_SLUG = 'ent-default';

/**
 * SpacesService — 知识空间解析与可见性。
 *
 * 空间类型（migration 044）：
 *  - normal/enterprise：企业空间（ent-default），分类授权控制
 *  - normal/personal：个人空间（u-{userId}），仅本人可见
 *  - app：APP 空间（app-{appId}[-{name}]），普通用户不可见，管理员仅查看，APP 自身读写
 */
@Injectable()
export class SpacesService {
  private readonly logger = new Logger(SpacesService.name);

  constructor(
    private readonly db: DbService,
    private readonly workspace: WorkspaceService,
  ) {}

  /** 知识库工作区根目录 */
  get kbRoot(): string {
    return this.workspace.getKnowledgeBaseDir();
  }

  /** 空间磁盘根目录 */
  rootFor(slug: string): string {
    return path.join(this.kbRoot, 'spaces', slug);
  }

  /** 解析空间（slug 或 id；'default' 为企业空间别名，兼容旧调用） */
  async resolve(slugOrId: string): Promise<KbSpace | null> {
    const slug = !slugOrId || slugOrId === 'default' ? ENTERPRISE_SPACE_SLUG : slugOrId;
    const { rows } = await this.db.query(
      'SELECT * FROM jz_kb_spaces WHERE slug = $1 OR id = $1',
      [slug],
    );
    return rows[0] || null;
  }

  /** 确保空间磁盘目录存在 */
  ensureDirs(slug: string): void {
    const root = this.rootFor(slug);
    fs.mkdirSync(path.join(root, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(root, 'wiki'), { recursive: true });
  }

  /** 确保企业空间存在（启动时调用） */
  async ensureEnterpriseSpace(): Promise<KbSpace> {
    const existing = await this.resolve(ENTERPRISE_SPACE_SLUG);
    if (existing) {
      this.ensureDirs(existing.slug);
      return existing;
    }
    const { rows } = await this.db.query(
      "INSERT INTO jz_kb_spaces (name, slug, type, subtype, description) " +
        "VALUES ('企业知识库', $1, 'normal', 'enterprise', '默认企业空间') " +
        'ON CONFLICT (slug) DO NOTHING RETURNING *',
      [ENTERPRISE_SPACE_SLUG],
    );
    const space = rows[0] || (await this.resolve(ENTERPRISE_SPACE_SLUG));
    this.ensureDirs(ENTERPRISE_SPACE_SLUG);
    return space;
  }

  /** 确保个人空间存在（u-{userId}） */
  async ensurePersonalSpace(userId: string): Promise<KbSpace> {
    const slug = `u-${userId}`;
    const existing = await this.resolve(slug);
    if (existing) {
      this.ensureDirs(slug);
      return existing;
    }
    const { rows } = await this.db.query(
      'INSERT INTO jz_kb_spaces (name, slug, type, subtype, owner_user_id) ' +
        'VALUES ($1, $2, $3, $4, $5) ON CONFLICT (slug) DO NOTHING RETURNING *',
      [`个人空间-${userId.slice(0, 8)}`, slug, 'normal', 'personal', userId],
    );
    const space = rows[0] || (await this.resolve(slug));
    this.ensureDirs(slug);
    return space;
  }

  /** 创建 APP 空间（APP 安装时调用） */
  async ensureAppSpace(appId: string, name?: string, subSlug?: string): Promise<KbSpace> {
    const slug = subSlug ? `app-${appId}-${subSlug}` : `app-${appId}`;
    const existing = await this.resolve(slug);
    if (existing) {
      this.ensureDirs(slug);
      return existing;
    }
    const { rows } = await this.db.query(
      'INSERT INTO jz_kb_spaces (name, slug, type, owner_app_id) ' +
        'VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING RETURNING *',
      [name || `APP 空间-${appId}`, slug, 'app', appId],
    );
    const space = rows[0] || (await this.resolve(slug));
    this.ensureDirs(slug);
    return space;
  }

  /**
   * 用户可见性判定。
   * @param isAdmin 是否平台管理员（sys:admin / kb:admin）
   */
  canRead(space: KbSpace, userId: string, isAdmin: boolean): boolean {
    if (space.type === 'app') return isAdmin; // APP 空间：管理员仅查看
    if (space.subtype === 'personal') return space.owner_user_id === userId;
    return true; // enterprise：全员可读（分类授权在文档层过滤）
  }

  /** APP 空间对任何主台用户均不可写（仅 APP 身份可写，由工具链判定） */
  canWrite(space: KbSpace, userId: string, isAdmin: boolean): boolean {
    if (space.type === 'app') return false;
    if (space.subtype === 'personal') return space.owner_user_id === userId;
    return true; // enterprise 写权限由 kb:write 权限点在控制器层判定
  }

  /** 用户可见的空间列表（带文档计数） */
  async listVisible(userId: string, isAdmin: boolean): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT s.*, ' +
        "(SELECT count(*)::int FROM jz_kb_documents d WHERE d.space_id = s.id AND d.source_kind != 'wiki' AND d.status != 'failed') AS source_count, " +
        "(SELECT count(*)::int FROM jz_kb_documents d WHERE d.space_id = s.id AND d.source_kind = 'wiki' AND d.status != 'failed') AS wiki_page_count " +
        'FROM jz_kb_spaces s ORDER BY s.created_at, s.slug',
    );
    return rows
      .filter((s: KbSpace) => this.canRead(s, userId, isAdmin))
      .map((s: any) => ({
        id: s.slug, // 兼容旧 API：kb_id 使用 slug
        space_id: s.id,
        user_id: userId,
        name: s.name,
        slug: s.slug,
        type: s.type,
        subtype: s.subtype,
        description: s.description,
        source_count: s.source_count ?? 0,
        wiki_page_count: s.wiki_page_count ?? 0,
        created_at: s.created_at,
        updated_at: null,
      }));
  }
}
