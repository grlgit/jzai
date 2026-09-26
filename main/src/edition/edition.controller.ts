import { Controller, Get, Post, Body, BadRequestException, Query, ParseBoolPipe } from '@nestjs/common';
import { EditionService } from './edition.service';
import { Public } from '../platform/auth/public.decorator';

@Public()
@Controller('api/edition')
export class EditionController {
  constructor(private readonly edition: EditionService) {}

  /** Get current edition info + credits */
  @Get()
  getEditionInfo() {
    return this.edition.getEditionInfo();
  }

  /** Get credits balance (syncs with website by default) */
  @Get('credits')
  async getCredits(@Query('force', new ParseBoolPipe({ optional: true })) force = true) {
    const balance = await this.edition.syncCredits(force);
    return {
      edition: this.edition.getEdition(),
      creditsBalance: balance,
      isCommunity: this.edition.isCommunity(),
    };
  }

  /** Step 1: Register company → sends SMS verification */
  @Post('register')
  async register(@Body() dto: { companyName: string; contactPerson: string; contactPhone: string }) {
    try {
      return await this.edition.register(dto);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  /** Step 2: Verify phone SMS code */
  @Post('register/verify')
  async verify(@Body() dto: { contactPhone: string; code: string }) {
    try {
      return await this.edition.verifyPhone(dto);
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  /** Trigger auto-registration with website (with optional SMS code) */
  @Post('register/complete')
  async registerComplete(@Body() body: { smsCode?: string; code?: string; companyName?: string; contactPerson?: string; contactPhone?: string }) {
    try {
      await this.edition.autoRegister(body.smsCode ?? body.code, {
        companyName: body.companyName,
        contactPerson: body.contactPerson,
        contactPhone: body.contactPhone,
      });
      // autoRegister 失败时只返回 false 不抛错 — 必须显式确认注册结果，
      // 否则前端会误判成功进入设密码步骤，然后被 setup 阶段门拦截（"当前阶段不允许设置密码"）
      if (!this.edition.isRegistered()) {
        throw new BadRequestException('注册未完成，请检查网络连接后重试（详见后端日志）');
      }
      return {
        success: true,
        registered: this.edition.isRegistered(),
        edition: this.edition.getEditionInfo(),
      };
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      throw new BadRequestException(e.message);
    }
  }

  /** Re-activate this installation (license verification issue / manual re-verify) */
  @Post('re-register')
  async reRegister() {
    return this.edition.reactivate();
  }

  /** Renew license (admin triggers from settings panel) */
  @Post('renew')
  async renew(@Body() body: { licenseDurationMonths?: number }) {
    await this.edition.renewLicense(body.licenseDurationMonths);
    return {
      success: true,
      edition: this.edition.getEditionInfo(),
    };
  }
}
