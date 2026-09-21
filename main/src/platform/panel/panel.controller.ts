import { Controller, Get, Put, Delete, Body, Headers, Req, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PanelService } from './panel.service';
import { UserService } from '../../user/user.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SYSTEM_CONFIG_PATH = path.join(process.cwd(), 'config', 'system.json');

@Controller('api')
export class PanelController {
  constructor(
    private readonly panelService: PanelService,
    private readonly userService: UserService,
  ) {}

  @Get('panels')
  async listPanels() {
    return this.panelService.listPanels();
  }

  @Get('sidebar')
  async getSidebar(@Headers('authorization') auth: string) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    const permissions = user.role?.permissions || [];
    return this.panelService.getUserSidebar(user.id, permissions);
  }

  @Put('sidebar')
  async saveSidebar(
    @Headers('authorization') auth: string,
    @Body() body: { items: { panelId: string; visible: boolean; groupName: string; sortOrder: number; customName?: string; customIcon?: string }[] },
  ) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    const panelIds = (body.items || []).map(i => i.panelId);
    if (panelIds.length > 0) {
      const systemPanels = await this.panelService.getSystemPanelIds(panelIds);
      if (systemPanels.length > 0) {
        throw new BadRequestException(`系统面板不可修改: ${systemPanels.join(', ')}`);
      }
    }
    await this.panelService.saveUserSidebar(user.id, body.items);
    return { success: true };
  }

  @Delete('sidebar')
  async resetSidebar(@Headers('authorization') auth: string) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    await this.panelService.resetUserSidebar(user.id);
    return { success: true };
  }

  // ===== Shortcuts =====

  @Get('shortcuts')
  async getShortcuts(@Headers('authorization') auth: string) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    const permissions = user.role?.permissions || [];
    return this.panelService.getUserShortcuts(user.id, permissions);
  }

  @Put('shortcuts')
  async saveShortcuts(
    @Headers('authorization') auth: string,
    @Body() body: { items: { id: string; name: string; icon: string; type: string; target: string; sortOrder: number }[] },
  ) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    await this.panelService.saveUserShortcuts(user.id, body.items);
    return { success: true };
  }

  @Delete('shortcuts')
  async resetShortcuts(@Headers('authorization') auth: string) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    await this.panelService.resetUserShortcuts(user.id);
    return { success: true };
  }

  // ===== Suggestions =====

  @Get('suggestions')
  async getSuggestions(@Headers('authorization') auth: string) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    return this.panelService.getUserSuggestions(user.id);
  }

  @Put('suggestions')
  async saveSuggestions(
    @Headers('authorization') auth: string,
    @Body() body: { items: { text: string }[] },
  ) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    this.panelService.saveUserSuggestions(user.id, body.items);
    return { success: true };
  }

  @Delete('suggestions')
  async clearSuggestions(@Headers('authorization') auth: string) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    this.panelService.clearUserSuggestions(user.id);
    return { success: true };
  }

  // ===== System Config =====

  @Get('system-config')
  getSystemConfig(@Headers('authorization') auth: string) {
    this.requireAdmin(auth);
    try {
      return JSON.parse(fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf-8'));
    } catch {
      return {};
    }
  }

  @Put('system-config')
  saveSystemConfig(@Headers('authorization') auth: string, @Body() body: Record<string, any>) {
    this.requireAdmin(auth);
    fs.writeFileSync(SYSTEM_CONFIG_PATH, JSON.stringify(body, null, 2), 'utf-8');
    return { success: true, message: '配置已保存，部分配置需要重启后端生效' };
  }

  // ===== Mobile Access =====

  /** 移动访问地址：已配置返回配置值，否则按当前请求端口 + 服务器局域网 IP 自动探测 */
  @Get('mobile-access')
  getMobileAccess(@Headers('authorization') auth: string, @Req() req: any) {
    const user = this.extractUser(auth);
    if (!user) throw new UnauthorizedException();
    let configured = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf-8'));
      configured = cfg.mobileAccessUrl || '';
    } catch {}
    if (configured) return { url: configured, configured: true };

    const host: string = req.headers?.host || '';
    const port = host.includes(':') ? host.split(':').pop() : '';
    const proto = req.headers?.['x-forwarded-proto'] || 'http';
    const ip = this.detectLanIp();
    const url = ip ? `${proto}://${ip}${port ? `:${port}` : ''}` : '';
    return { url, configured: false };
  }

  @Put('mobile-access')
  saveMobileAccess(@Headers('authorization') auth: string, @Body() body: { url?: string }) {
    this.requireAdmin(auth);
    let cfg: Record<string, any> = {};
    try {
      cfg = JSON.parse(fs.readFileSync(SYSTEM_CONFIG_PATH, 'utf-8'));
    } catch {}
    const url = (body?.url || '').trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//.test(url)) {
      throw new BadRequestException('地址需以 http:// 或 https:// 开头');
    }
    if (url) cfg.mobileAccessUrl = url;
    else delete cfg.mobileAccessUrl;
    fs.writeFileSync(SYSTEM_CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
    return { success: true };
  }

  private detectLanIp(): string | null {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family === 'IPv4' && !info.internal) return info.address;
      }
    }
    return null;
  }

  private extractUser(auth: string) {
    if (!auth?.startsWith('Bearer ')) return null;
    return this.userService.verifyToken(auth.slice(7));
  }

  private requireAdmin(auth: string) {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) throw new UnauthorizedException();
    if (!this.userService.hasPermission(token, 'sys:admin')) throw new ForbiddenException('需要管理员权限');
  }
}
