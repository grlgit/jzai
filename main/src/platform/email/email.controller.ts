import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, Req, BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { EmailService } from './email.service';
import { UserService } from '../../user/user.service';

@Controller('api/email')
@UseGuards(JwtAuthGuard)
export class EmailController {
  constructor(
    private readonly emailService: EmailService,
    private readonly userService: UserService,
  ) {}

  private requireAdmin(req: any) {
    const token = req.headers?.authorization?.replace('Bearer ', '');
    if (!token || !this.userService.hasPermission(token, 'sys:admin' as any)) {
      throw new ForbiddenException('需要管理员权限');
    }
  }

  // ── 邮件服务器 API ───────────────────────────────────────────────────────

  @Get('servers')
  async getAllServers(@Req() req: any) {
    this.requireAdmin(req);
    return this.emailService.getAllServers();
  }

  @Get('servers/available')
  async getAvailableServers() {
    return this.emailService.getAvailableServers();
  }

  @Post('servers')
  async createServer(@Req() req: any, @Body() body: any) {
    this.requireAdmin(req);
    const userId = req.user?.id;
    return this.emailService.createServer(body, userId);
  }

  @Put('servers/:id')
  async updateServer(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requireAdmin(req);
    return this.emailService.updateServer(id, body);
  }

  @Delete('servers/:id')
  async deleteServer(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    await this.emailService.deleteServer(id);
    return { success: true };
  }

  @Post('servers/:id/test')
  async testServer(@Req() req: any, @Param('id') id: string) {
    this.requireAdmin(req);
    return this.emailService.testServer(id);
  }

  // ── 邮箱账号 API ───────────────────────────────────────────────────────

  @Get('accounts')
  async getUserAccounts(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User not authenticated');
    return this.emailService.getUserAccounts(userId);
  }

  @Post('accounts')
  async createAccount(@Req() req: any, @Body() body: any) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User not authenticated');

    if (!body.label || !body.email_address || !body.server_id || !body.password) {
      throw new BadRequestException('Missing required fields: label, email_address, server_id, password');
    }

    return this.emailService.createAccount(body, userId);
  }

  @Put('accounts/:id')
  async updateAccount(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User not authenticated');
    return this.emailService.updateAccount(id, body, userId);
  }

  @Delete('accounts/:id')
  async deleteAccount(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User not authenticated');
    await this.emailService.deleteAccount(id, userId);
    return { success: true };
  }

  @Post('accounts/:id/test')
  async testAccount(@Req() req: any, @Param('id') id: string) {
    const userId = req.user?.id;
    if (!userId) throw new BadRequestException('User not authenticated');
    return this.emailService.testAccount(id, userId);
  }
}
