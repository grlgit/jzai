import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { InvocationContextFactory } from './runtime/invocation-context.factory';
import { AppServicePrincipalService } from './services/app-service-principal.service';

@Controller('api/app-store/apps/:appId/service-principals')
export class AppServicePrincipalController {
  constructor(
    private readonly servicePrincipals: AppServicePrincipalService,
    private readonly invocationContexts: InvocationContextFactory,
  ) {}

  @Get()
  async list(@Param('appId') appId: string, @Req() req: any) {
    this.requireAdmin(req);
    return this.servicePrincipals.list(appId);
  }

  @Post()
  async create(
    @Param('appId') appId: string,
    @Body() body: { name: string; scopes: string[]; expiresAt?: string },
    @Req() req: any,
  ) {
    const actor = this.requireAdmin(req);
    return this.servicePrincipals.create(appId, body, actor);
  }

  @Delete(':principalId')
  async revoke(
    @Param('appId') appId: string,
    @Param('principalId') principalId: string,
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    await this.servicePrincipals.revoke(appId, principalId);
    return { ok: true };
  }

  @Post(':principalId/delegations')
  async createDelegation(
    @Param('appId') appId: string,
    @Param('principalId') principalId: string,
    @Body() body: { userId: string; scopes: string[]; expiresAt: string },
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    return this.servicePrincipals.createDelegation(appId, principalId, body);
  }

  @Delete('delegations/:delegationId')
  async revokeDelegation(
    @Param('appId') appId: string,
    @Param('delegationId') delegationId: string,
    @Req() req: any,
  ) {
    this.requireAdmin(req);
    await this.servicePrincipals.revokeDelegation(appId, delegationId);
    return { ok: true };
  }

  private requireAdmin(req: any) {
    const principal = this.invocationContexts.fromRequest(req, 'app-service-principal-admin');
    if (!principal?.permissions.includes('sys:admin')) {
      throw new ForbiddenException('sys:admin permission required');
    }
    return principal;
  }
}
