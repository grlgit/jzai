import { Controller, Get, Post, Put, Delete, Body, Param, Req, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { UserService, Permission } from './user.service';
import { Public } from '../platform/auth/public.decorator';
import { Audit } from '../common/audit.interceptor';

import { DbService } from '../db/db.service';
import * as crypto from 'crypto';

@Controller('api')
export class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly db: DbService,
  ) {}

  // ===== Auth =====

  @Public()
  @Post('auth/login')
  async login(@Req() req: any, @Body() body: { account?: string; email?: string; password: string }) {
    const account = body.account || body.email || '';
    const ip = req.ip;
    const ua = req.headers?.['user-agent'] || null;
    try {
      const result = await this.userService.login(account, body.password);
      // Audit: successful login (fire-and-forget)
      this.writeAudit(result.user.id, result.user.username, 'login', 'auth', null, null, ip, ua);
      return result;
    } catch (e: any) {
      // Audit: failed login
      this.writeAudit(null, account, 'login_failed', 'auth', null, { reason: e.message }, ip, ua);
      throw new UnauthorizedException(e.message);
    }
  }

  @Get('auth/me')
  async me(@Req() req: any) {
    return this.userService.verifyTokenFull(this.extractToken(req));
  }

  @Public()
  @Post('auth/refresh')
  async refresh(@Body() body: { refreshToken: string }) {
    if (!body.refreshToken) throw new UnauthorizedException('Missing refresh token');
    const result = await this.userService.consumeRefreshToken(body.refreshToken);
    if (!result) throw new UnauthorizedException('Invalid or expired refresh token');
    return result;
  }

  @Post('auth/logout')
  async logout(@Body() body: { refreshToken?: string }) {
    if (body.refreshToken) {
      await this.userService.revokeRefreshToken(body.refreshToken);
    }
    return { success: true };
  }

  // ===== Users =====

  @Get('users')
  listUsers(@Req() req: any) {
    this.requirePermission(req, 'cfg:users');
    return this.userService.listUsers();
  }

  @Audit('create_user', 'user')
  @Post('users')
  async createUser(@Req() req: any, @Body() body: { name: string; username?: string; email: string; password: string; roleId?: string }) {
    this.requirePermission(req, 'cfg:users');
    try {
      return await this.userService.createUser(body.name, body.email, body.password, body.roleId, body.username);
    } catch (e: any) {
      throw new UnauthorizedException(e.message);
    }
  }

  @Audit('update_user', 'user')
  @Put('users/:id')
  async updateUser(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requirePermission(req, 'cfg:users');
    return this.userService.updateUser(id, body);
  }

  @Audit('delete_user', 'user')
  @Delete('users/:id')
  deleteUser(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cfg:users');
    return { deleted: this.userService.deleteUser(id) };
  }

  // ===== Roles =====

  @Get('roles')
  listRoles(@Req() req: any) {
    this.requirePermission(req, 'cfg:users');
    return this.userService.listRoles();
  }

  @Audit('create_role', 'role')
  @Post('roles')
  createRole(@Req() req: any, @Body() body: { name: string; description: string; permissions: Permission[] }) {
    this.requirePermission(req, 'cfg:users');
    return this.userService.createRole(body.name, body.description, body.permissions);
  }

  @Audit('update_role', 'role')
  @Put('roles/:id')
  updateRole(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requirePermission(req, 'cfg:users');
    return this.userService.updateRole(id, body);
  }

  @Audit('delete_role', 'role')
  @Delete('roles/:id')
  deleteRole(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cfg:users');
    const deleted = this.userService.deleteRole(id);
    if (!deleted) throw new ForbiddenException('无法删除系统角色或正在使用的角色');
    return { deleted };
  }

  @Get('permissions')
  listPermissions(@Req() req: any) {
    this.requirePermission(req, 'cfg:users');
    return this.userService.getAllPermissions();
  }

  // ===== Departments =====

  @Get('departments')
  async listDepartments(@Req() req: any) {
    this.requirePermission(req, 'cfg:users');
    const { rows } = await this.db.query('SELECT * FROM jz_departments ORDER BY sort_order, name');
    return rows;
  }

  @Post('departments')
  async createDepartment(@Req() req: any, @Body() body: { name: string; slug: string; parent_id?: string; head_user_id?: string }) {
    this.requirePermission(req, 'cfg:users');
    const id = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO jz_departments (id, name, slug, parent_id, head_user_id) VALUES ($1, $2, $3, $4, $5)',
      [id, body.name, body.slug, body.parent_id || null, body.head_user_id || null],
    );
    const { rows } = await this.db.query('SELECT * FROM jz_departments WHERE id = $1', [id]);
    return rows[0];
  }

  @Put('departments/:id')
  async updateDepartment(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requirePermission(req, 'cfg:users');
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    for (const key of ['name', 'slug', 'parent_id', 'head_user_id', 'sort_order']) {
      if (body[key] !== undefined) { fields.push(`${key} = $${idx}`); values.push(body[key] || null); idx++; }
    }
    if (fields.length === 0) return { updated: false };
    values.push(id);
    await this.db.query(`UPDATE jz_departments SET ${fields.join(', ')} WHERE id = $${idx}`, values);
    const { rows } = await this.db.query('SELECT * FROM jz_departments WHERE id = $1', [id]);
    return rows[0];
  }

  @Delete('departments/:id')
  async deleteDepartment(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cfg:users');
    await this.db.query('DELETE FROM jz_departments WHERE id = $1', [id]);
    return { deleted: true };
  }

  @Get('departments/:id/members')
  async listDeptMembers(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cfg:users');
    const { rows } = await this.db.query(
      `SELECT dm.*, u.name as user_name, u.email as user_email
       FROM jz_department_members dm
       JOIN jz_users u ON dm.user_id = u.id
       WHERE dm.department_id = $1 ORDER BY u.name`, [id]);
    return rows;
  }

  @Post('departments/:id/members')
  async addDeptMember(@Req() req: any, @Param('id') id: string, @Body() body: { user_id: string; role?: string }) {
    this.requirePermission(req, 'cfg:users');
    const mid = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO jz_department_members (id, department_id, user_id, role) VALUES ($1, $2, $3, $4)',
      [mid, id, body.user_id, body.role || 'member'],
    );
    return { id: mid, department_id: id, user_id: body.user_id, role: body.role || 'member' };
  }

  @Delete('departments/:deptId/members/:memberId')
  async removeDeptMember(@Req() req: any, @Param('deptId') deptId: string, @Param('memberId') memberId: string) {
    this.requirePermission(req, 'cfg:users');
    await this.db.query('DELETE FROM jz_department_members WHERE id = $1 AND department_id = $2', [memberId, deptId]);
    return { deleted: true };
  }

  // ===== Workgroups =====

  @Get('workgroups')
  async listWorkgroups(@Req() req: any) {
    this.requirePermission(req, 'cfg:users');
    const { rows } = await this.db.query('SELECT * FROM jz_workgroups ORDER BY name');
    return rows;
  }

  @Post('workgroups')
  async createWorkgroup(@Req() req: any, @Body() body: { name: string; slug: string; description?: string }) {
    this.requirePermission(req, 'cfg:users');
    const id = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO jz_workgroups (id, name, slug, description) VALUES ($1, $2, $3, $4)',
      [id, body.name, body.slug, body.description || null],
    );
    const { rows } = await this.db.query('SELECT * FROM jz_workgroups WHERE id = $1', [id]);
    return rows[0];
  }

  @Delete('workgroups/:id')
  async deleteWorkgroup(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cfg:users');
    await this.db.query('DELETE FROM jz_workgroups WHERE id = $1', [id]);
    return { deleted: true };
  }

  @Get('workgroups/:id/members')
  async listWgMembers(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cfg:users');
    const { rows } = await this.db.query(
      `SELECT wm.*, u.name as user_name, u.email as user_email
       FROM jz_workgroup_members wm
       JOIN jz_users u ON wm.user_id = u.id
       WHERE wm.workgroup_id = $1 ORDER BY u.name`, [id]);
    return rows;
  }

  @Post('workgroups/:id/members')
  async addWgMember(@Req() req: any, @Param('id') id: string, @Body() body: { user_id: string }) {
    this.requirePermission(req, 'cfg:users');
    const mid = crypto.randomUUID();
    await this.db.query(
      'INSERT INTO jz_workgroup_members (id, workgroup_id, user_id) VALUES ($1, $2, $3)',
      [mid, id, body.user_id],
    );
    return { id: mid, workgroup_id: id, user_id: body.user_id };
  }

  @Delete('workgroups/:wgId/members/:memberId')
  async removeWgMember(@Req() req: any, @Param('wgId') wgId: string, @Param('memberId') memberId: string) {
    this.requirePermission(req, 'cfg:users');
    await this.db.query('DELETE FROM jz_workgroup_members WHERE id = $1 AND workgroup_id = $2', [memberId, wgId]);
    return { deleted: true };
  }

  // ===== Helpers =====

  private writeAudit(userId: string | null, userName: string | null, action: string, resource: string, resourceId: string | null, detail: any, ip: string, ua: string | null) {
    this.db.query(
      `INSERT INTO jz_audit_log (user_id, user_name, action, resource, resource_id, detail, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, userName, action, resource, resourceId, detail ? JSON.stringify(detail) : null, ip, ua],
    ).catch((e) => console.error(`[Audit] Write failed: ${e.message}`));
  }

  private extractToken(req: any): string {
    const auth = req.headers?.authorization || '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : '';
  }

  private requirePermission(req: any, permission: Permission) {
    const token = this.extractToken(req);
    if (!token || !this.userService.hasPermission(token, permission)) {
      throw new ForbiddenException('权限不足');
    }
  }
}
