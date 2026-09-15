import { Controller, Get, Post, Put, Delete, Body, Param, Headers, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { UserService } from '../../user/user.service';

@Controller('api/dashboards')
export class DashboardController {
  constructor(
    private readonly dashboardService: DashboardService,
    private readonly userService: UserService,
  ) {}

  @Get()
  async listDashboards(@Headers('authorization') auth: string) {
    const user = this.requireUser(auth);
    return this.dashboardService.listDashboards(user.id);
  }

  @Post()
  async createDashboard(
    @Headers('authorization') auth: string,
    @Body() body: { name?: string; description?: string },
  ) {
    const user = this.requireUser(auth);
    return this.dashboardService.createDashboard(user.id, body.name || '我的仪表盘', body.description);
  }

  @Get(':id')
  async getDashboard(@Headers('authorization') auth: string, @Param('id') id: string) {
    const user = this.requireUser(auth);
    const result = await this.dashboardService.getDashboardWithWidgets(id, user.id);
    if (!result) throw new NotFoundException('仪表盘不存在');
    return result;
  }

  @Put(':id')
  async updateDashboard(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string },
  ) {
    const user = this.requireUser(auth);
    const dashboard = await this.dashboardService.updateDashboard(id, user.id, body);
    if (!dashboard) throw new NotFoundException('仪表盘不存在');
    return dashboard;
  }

  @Delete(':id')
  async deleteDashboard(@Headers('authorization') auth: string, @Param('id') id: string) {
    const user = this.requireUser(auth);
    const deleted = await this.dashboardService.deleteDashboard(id, user.id);
    if (!deleted) throw new NotFoundException('仪表盘不存在');
    return { success: true };
  }

  @Put(':id/layout')
  async saveLayout(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { layout: any[] },
  ) {
    const user = this.requireUser(auth);
    await this.dashboardService.saveLayout(id, user.id, body.layout);
    return { success: true };
  }

  // ===== Widgets =====

  @Post(':id/widgets')
  async addWidget(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Body() body: { widgetType: string; title: string; config?: any; dataSource?: any; refreshInterval?: number },
  ) {
    const user = this.requireUser(auth);
    return this.dashboardService.addWidget(id, user.id, body);
  }

  @Put(':id/widgets/:wid')
  async updateWidget(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Param('wid') wid: string,
    @Body() body: { title?: string; config?: any; dataSource?: any; refreshInterval?: number },
  ) {
    const user = this.requireUser(auth);
    const widget = await this.dashboardService.updateWidget(wid, user.id, body);
    if (!widget) throw new NotFoundException('仪表块不存在');
    return widget;
  }

  @Delete(':id/widgets/:wid')
  async deleteWidget(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Param('wid') wid: string,
  ) {
    const user = this.requireUser(auth);
    const deleted = await this.dashboardService.deleteWidget(wid, user.id);
    if (!deleted) throw new NotFoundException('仪表块不存在');
    return { success: true };
  }

  @Post(':id/widgets/:wid/refresh')
  async refreshWidget(
    @Headers('authorization') auth: string,
    @Param('id') id: string,
    @Param('wid') wid: string,
  ) {
    const user = this.requireUser(auth);
    return this.dashboardService.refreshWidgetData(wid, user.id);
  }

  private requireUser(auth: string) {
    if (!auth?.startsWith('Bearer ')) throw new UnauthorizedException();
    const user = this.userService.verifyToken(auth.slice(7));
    if (!user) throw new UnauthorizedException();
    return user;
  }
}
