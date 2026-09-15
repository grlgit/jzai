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
  async registerComplete(@Body() body: { smsCode?: string; companyName?: string; contactPerson?: string; contactPhone?: string }) {
    try {
      await this.edition.autoRegister(body.smsCode, {
        companyName: body.companyName,
        contactPerson: body.contactPerson,
        contactPhone: body.contactPhone,
      });
      return {
        success: true,
        registered: this.edition.isRegistered(),
        edition: this.edition.getEditionInfo(),
      };
    } catch (e: any) {
      throw new BadRequestException(e.message);
    }
  }

  /** Re-register after container rebuild (fingerprint mismatch) */
  @Post('re-register')
  async reRegister() {
    return this.edition.reRegister();
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
