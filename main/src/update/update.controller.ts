import { Controller, Get, Post, Req, ForbiddenException } from '@nestjs/common';
import { UpdateService } from './update.service';
import { UserService } from '../user/user.service';

@Controller('api/update')
export class UpdateController {
  constructor(
    private readonly update: UpdateService,
    private readonly userService: UserService,
  ) {}

  /** Current version + cached update info */
  @Get('current')
  getCurrent() {
    return {
      version: this.update.getCurrentVersion(),
      update: this.update.getCachedUpdate(),
    };
  }

  /** Actively check for updates */
  @Get('check')
  async check(@Req() req: any) {
    this.requireAdmin(req);
    return this.update.checkUpdate();
  }

  /** 检查最新版本（用于"升级到最新"功能） */
  @Get('check-latest')
  async checkLatest(@Req() req: any) {
    this.requireAdmin(req);
    return this.update.checkLatest();
  }

  /** Start update (async — returns immediately, poll /status for progress) */
  @Post('apply')
  apply(@Req() req: any) {
    this.requireAdmin(req);
    return this.update.startApply();
  }

  /** 升级到最新版本（全量升级，跳过中间版本） */
  @Post('apply-latest')
  applyLatest(@Req() req: any) {
    this.requireAdmin(req);
    return this.update.startApplyLatest();
  }

  /** Get real-time update progress */
  @Get('status')
  getStatus() {
    return this.update.getProgress();
  }

  private requireAdmin(req: any) {
    const auth = req.headers?.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || !this.userService.hasPermission(token, 'sys:admin')) {
      throw new ForbiddenException('仅管理员可操作');
    }
  }
}
