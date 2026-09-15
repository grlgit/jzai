import { Controller, Get, Post, Body, UseGuards, Req, ForbiddenException, Logger, RawBodyRequest } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { SetupService } from './setup.service';
import { Public } from '../platform/auth/public.decorator';

@Controller('api/setup')
export class SetupController {
  private readonly logger = new Logger('NavTrace');
  constructor(private readonly setup: SetupService) {}

  /** Receive navigation trace beacons from frontend */
  @Public()
  @Post('nav-trace')
  navTrace(@Body() body: any) {
    this.logger.error(`[NAV-TRACE] ${JSON.stringify(body)}`);
    return { ok: true };
  }

  /** Get current setup status (public — drives wizard UI) */
  @Public()
  @Get('status')
  async getStatus() {
    return this.setup.getSetupStatus();
  }

  /** System health check (public — shown in wizard welcome step) */
  @Public()
  @Get('health')
  async getHealth() {
    return this.setup.getHealth();
  }

  /** Set admin password (public but phase-gated: only works when phase='registered') */
  @Public()
  @Throttle({ default: { ttl: 900000, limit: 5 } }) // 5 attempts per 15 minutes
  @Post('admin-password')
  async setAdminPassword(@Body() body: { password: string; confirmPassword: string }) {
    if (!body.password || !body.confirmPassword) {
      throw new Error('请输入密码');
    }
    if (body.password !== body.confirmPassword) {
      throw new Error('两次密码不一致');
    }
    await this.setup.setAdminPassword(body.password);
    return { success: true };
  }

  /** Mark guided config as complete (requires admin auth) */
  @Post('complete-guide')
  async completeGuide(@Req() req: any) {
    // Check admin permission
    const user = req.user;
    if (!user?.permissions?.includes('sys:admin') && user?.roleId !== 'admin') {
      throw new ForbiddenException('仅管理员可操作');
    }
    await this.setup.completeGuidedConfig();
    return { success: true };
  }
}
