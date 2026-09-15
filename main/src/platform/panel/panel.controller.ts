import { Controller, Get, Put, Delete, Body, Headers, UnauthorizedException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PanelService } from './panel.service';
import { UserService } from '../../user/user.service';
import * as fs from 'fs';
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
