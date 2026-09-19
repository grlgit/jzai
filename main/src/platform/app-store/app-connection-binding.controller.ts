import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { AppConnectionBindingService } from './services/app-connection-binding.service';
import type { CreateAppConnectionBinding } from './services/app-connection-binding.service';
import { InvocationContextFactory } from './runtime/invocation-context.factory';

@Controller('api/app-store/apps/:appId/connection-bindings')
export class AppConnectionBindingController {
  constructor(
    private readonly bindings: AppConnectionBindingService,
    private readonly invocationContexts: InvocationContextFactory,
  ) {}

  @Get()
  async list(@Param('appId') appId: string, @Req() req: any) {
    this.requireAdmin(req);
    return this.bindings.listBindings(appId);
  }

  @Post()
  async create(
    @Param('appId') appId: string,
    @Body() body: CreateAppConnectionBinding,
    @Req() req: any,
  ) {
    const principal = this.requireAdmin(req);
    return this.bindings.createBinding(appId, body, principal);
  }

  @Get(':bindingId')
  async describe(
    @Param('appId') appId: string,
    @Param('bindingId') bindingId: string,
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    return this.bindings.describeBinding(appId, bindingId);
  }

  @Delete(':bindingId')
  async remove(
    @Param('appId') appId: string,
    @Param('bindingId') bindingId: string,
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    await this.bindings.deleteBinding(appId, bindingId);
    return { ok: true };
  }

  @Patch(':bindingId/status')
  async setStatus(
    @Param('appId') appId: string,
    @Param('bindingId') bindingId: string,
    @Body() body: { enabled: boolean },
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    return this.bindings.setEnabled(appId, bindingId, body.enabled === true);
  }

  @Get(':bindingId/grants')
  async listGrants(
    @Param('appId') appId: string,
    @Param('bindingId') bindingId: string,
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    return this.bindings.listGrants(appId, bindingId);
  }

  @Post(':bindingId/grants')
  async setGrant(
    @Param('appId') appId: string,
    @Param('bindingId') bindingId: string,
    @Body() body: {
      targetType: 'user' | 'role' | 'department';
      targetId: string;
      effect: 'allow' | 'deny';
    },
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    return this.bindings.setGrant(appId, bindingId, body);
  }

  @Delete(':bindingId/grants/:targetType/:targetId')
  async removeGrant(
    @Param('appId') appId: string,
    @Param('bindingId') bindingId: string,
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    await this.bindings.deleteGrant(appId, bindingId, targetType, targetId);
    return { ok: true };
  }

  @Post(':bindingId/invoke')
  async invoke(
    @Param('appId') appId: string,
    @Param('bindingId') bindingId: string,
    @Body() body: { params?: unknown },
    @Req() req: any,
  ) {
    const principal = this.invocationContexts.fromRequest(req, `app-connection:${appId}`);
    return this.bindings.invoke(appId, bindingId, body?.params ?? {}, principal);
  }

  private requireAdmin(req: any) {
    const principal = this.invocationContexts.fromRequest(req, 'app-connection-admin');
    if (!principal?.permissions.includes('sys:admin')) {
      throw new ForbiddenException('sys:admin permission required');
    }
    return principal;
  }
}
