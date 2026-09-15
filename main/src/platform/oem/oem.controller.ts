import { Controller, Post, Get, Body, BadRequestException } from '@nestjs/common';
import { OemService } from './oem.service';
import { Public } from '../auth/public.decorator';

/**
 * OEM 对外接口 — 供第三方系统的【后端】调用（app_secret 不进浏览器）。
 * 用 app 凭据换取短时 scoped token，前端再用它初始化嵌入。
 */
@Controller('api/oem')
export class OemController {
  constructor(private readonly oemService: OemService) {}

  @Public()
  @Post('token')
  async issueToken(@Body() body: {
    app_id?: string; app_secret?: string; external_uid?: string; external_name?: string;
  }) {
    if (!body?.app_id || !body?.app_secret) throw new BadRequestException('缺少 app_id 或 app_secret');
    if (!body.external_uid) throw new BadRequestException('缺少 external_uid');
    return this.oemService.issueToken({
      appId: body.app_id,
      appSecret: body.app_secret,
      externalUid: body.external_uid,
      externalName: body.external_name,
    });
  }

  @Public()
  @Get('health')
  health() {
    return { ok: true };
  }
}
