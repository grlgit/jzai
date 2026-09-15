import { Controller, Get, Post, Put, Body, Param, Req, ForbiddenException, NotFoundException } from '@nestjs/common';
import { OemService } from './oem.service';
import { UserService, Permission } from '../../user/user.service';

/** OEM 接入方管理 — 主台内部，需 sys:admin。 */
@Controller('api/admin/oem')
export class OemAdminController {
  constructor(
    private readonly oemService: OemService,
    private readonly userService: UserService,
  ) {}

  @Get('apps')
  async listApps(@Req() req: any) {
    this.requireAdmin(req);
    return this.oemService.listApps();
  }

  @Post('apps')
  async createApp(@Req() req: any, @Body() body: {
    name: string; bearerUserId: string; scope?: Permission[]; mcpBindings?: any[];
    branding?: Record<string, any>; allowedOrigins?: string[]; cachePolicy?: 'on' | 'off'; rateLimit?: any;
  }) {
    this.requireAdmin(req);
    // appSecret 仅在创建时明文返回一次
    return this.oemService.createApp(body);
  }

  @Put('apps/:id')
  async updateApp(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(req);
    const app = await this.oemService.updateApp(id, body);
    if (!app) throw new NotFoundException('接入方不存在');
    return app;
  }

  @Post('apps/:id/rotate-secret')
  async rotateSecret(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    const result = await this.oemService.rotateSecret(id);
    if (!result) throw new NotFoundException('接入方不存在');
    return result;
  }

  @Put('apps/:id/status')
  async setStatus(@Req() req: any, @Param('id') id: string, @Body() body: { status: 'active' | 'suspended' }) {
    this.requireAdmin(req);
    const app = await this.oemService.setStatus(id, body.status);
    if (!app) throw new NotFoundException('接入方不存在');
    return app;
  }

  @Get('apps/:id/usage')
  async usage(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    const app = await this.oemService.getApp(id);
    if (!app) throw new NotFoundException('接入方不存在');
    return this.oemService.getUsage(app.appId);
  }

  private requireAdmin(req: any) {
    const auth = req.headers?.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !this.userService.hasPermission(token, 'sys:admin')) {
      throw new ForbiddenException('权限不足');
    }
  }
}
