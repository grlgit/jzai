import { Controller, Get, Post, Put, Delete, Body, Query, Param, ParseIntPipe } from '@nestjs/common';
import { ModelRouterService, ProviderConfig } from './model-router.service';

@Controller('api/models')
export class ModelRouterController {
  constructor(private readonly modelRouter: ModelRouterService) {}

  @Get('discover')
  async discover(
    @Query('provider') provider: string,
    @Query('endpoint') endpoint?: string,
    @Query('apiKey') apiKey?: string,
  ) {
    return this.modelRouter.discoverModels(provider, endpoint, apiKey);
  }

  @Get('stats')
  getStats() {
    return this.modelRouter.getStats();
  }

  @Get('config')
  getConfig() {
    return this.modelRouter.getConfig();
  }

  @Post('config')
  updateConfig(@Body() body: ModelConfigUpdate) {
    this.modelRouter.updateConfig(body);
    return { success: true, config: this.modelRouter.getConfig() };
  }

  // Provider CRUD endpoints
  @Get('providers')
  getProviders() {
    return this.modelRouter.getProviders();
  }

  @Get('providers/:id')
  getProvider(@Param('id') id: string) {
    const provider = this.modelRouter.getProvider(id);
    if (!provider) {
      return { error: 'Provider not found' };
    }
    return provider;
  }

  @Put('providers/:id')
  upsertProvider(@Param('id') id: string, @Body() body: UpsertProviderDto) {
    const provider = this.modelRouter.upsertProvider({ ...body, id });
    return { success: true, provider };
  }

  @Delete('providers/:id')
  deleteProvider(@Param('id') id: string) {
    const deleted = this.modelRouter.deleteProvider(id);
    if (!deleted) {
      return { success: false, error: 'Cannot delete preset provider or provider not found' };
    }
    return { success: true };
  }

  @Post('providers/:id/reset')
  resetProvider(@Param('id') id: string) {
    const provider = this.modelRouter.resetProvider(id);
    if (!provider) {
      return { success: false, error: 'Preset provider not found' };
    }
    return { success: true, provider };
  }
}

export interface ModelConfigUpdate {
  localEndpoint?: string;
  localModel?: string;
  cloudProvider?: string;
  cloudModel?: string;
  cloudApiKey?: string;
  cloudSource?: 'self' | 'official';
  budgetLimit?: number;
  overLimitAction?: string;
  providers?: Record<string, ProviderConfig>;
}

export interface UpsertProviderDto {
  name: string;
  baseUrl: string;
  modelsPath: string;
}
