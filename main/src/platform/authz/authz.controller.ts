import { Controller, Get, Put, Post, Param, Body, Req, BadRequestException, ForbiddenException } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { createUserPrincipal, InvocationPrincipal } from '../app-store/runtime/invocation-principal';
import { ResourceMetaService, ResourceType } from './resource-meta.service';
import { ResourceGrantService, ResourceGrant } from './resource-grant.service';
import { ResourceAccessService } from './resource-access.service';

const RESOURCE_TYPES: ResourceType[] = ['agent', 'skill', 'connector', 'tool', 'panel', 'app'];

/**
 * 通用资源授权 API（P1）。前端 GrantEditor 的后端。
 *   GET  /api/authz/:type/:id/grants    读取 meta + 授权列表（canGrant）
 *   PUT  /api/authz/:type/:id/grants    整体替换授权（canGrant）
 *   GET  /api/authz/:type/:id/subjects  可授权对象（用户/角色/部门）
 *   POST /api/authz/:type/:id/share     用户类资源分享（owner 专用）
 */
@Controller('api/authz')
export class AuthzController {
  constructor(
    private readonly meta: ResourceMetaService,
    private readonly grants: ResourceGrantService,
    private readonly access: ResourceAccessService,
    private readonly db: DbService,
  ) {}

  private principalOf(req: any): InvocationPrincipal {
    return createUserPrincipal(req.user, 'http:authz');
  }

  private parseType(t: string): ResourceType {
    if (!RESOURCE_TYPES.includes(t as ResourceType)) {
      throw new BadRequestException(`未知资源类型: ${t}`);
    }
    return t as ResourceType;
  }

  @Get(':type/:id/grants')
  async getGrants(@Param('type') type: string, @Param('id') id: string, @Req() req: any) {
    const t = this.parseType(type);
    const p = this.principalOf(req);
    await this.access.assertCanGrant(t, id, p);
    const [meta, grants] = await Promise.all([
      this.meta.get(t, id),
      this.grants.listGrants(t, id),
    ]);
    return { meta: meta ?? null, grants };
  }

  @Put(':type/:id/grants')
  async putGrants(
    @Param('type') type: string, @Param('id') id: string,
    @Body() body: { grants: Omit<ResourceGrant, 'resourceType' | 'resourceId'>[] },
    @Req() req: any,
  ) {
    const t = this.parseType(type);
    const p = this.principalOf(req);
    await this.access.assertCanGrant(t, id, p);
    if (!Array.isArray(body?.grants)) throw new BadRequestException('grants 必须是数组');
    const full: ResourceGrant[] = body.grants.map(g => ({
      ...g, resourceType: t, resourceId: id,
    }));
    await this.grants.replaceGrants(t, id, full, p.userId);
    return { success: true, count: full.filter(g => g.level !== 'none').length };
  }

  /** 可授权对象清单：GrantEditor 的用户/角色/部门选择器数据源 */
  @Get(':type/:id/subjects')
  async getSubjects(@Param('type') type: string, @Param('id') id: string, @Req() req: any) {
    const t = this.parseType(type);
    await this.access.assertCanGrant(t, id, this.principalOf(req));
    const [users, roles, departments] = await Promise.all([
      this.db.query(`SELECT id, name, username FROM jz_users WHERE status = 'active' ORDER BY name`),
      this.db.query(`SELECT id, name FROM jz_roles ORDER BY name`),
      this.db.query(`SELECT id, name FROM jz_departments ORDER BY sort_order, name`),
    ]);
    return { users: users.rows, roles: roles.rows, departments: departments.rows };
  }

  /** 用户类资源分享：owner 把资源分享给指定用户（写 user grant） */
  @Post(':type/:id/share')
  async share(
    @Param('type') type: string, @Param('id') id: string,
    @Body() body: { userIds: string[] },
    @Req() req: any,
  ) {
    const t = this.parseType(type);
    const p = this.principalOf(req);
    const m = await this.meta.get(t, id);
    if (!m || m.scope !== 'user') throw new BadRequestException('仅用户类资源支持分享');
    if (m.ownerUserId !== p.userId) throw new ForbiddenException('仅创建者可分享');
    if (!Array.isArray(body?.userIds) || body.userIds.length === 0) {
      throw new BadRequestException('userIds 不能为空');
    }
    for (const uid of body.userIds) {
      await this.grants.setGrant(
        { resourceType: t, resourceId: id, targetType: 'user', targetId: uid, level: 'user' },
        p.userId,
      );
    }
    return { success: true, shared: body.userIds.length };
  }
}
