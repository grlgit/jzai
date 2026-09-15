import { Injectable, Logger } from '@nestjs/common';
import { AppPoolService } from './app-pool.service';
import { AppRegistryService } from './app-registry.service';

export interface AppInstance {
  appId: string;
  status: string;
  poolActive: boolean;
  installedVersion: string;
}

/**
 * Lightweight query service for runtime app instance status.
 * Reports which apps are running, have active connection pools, etc.
 */
@Injectable()
export class AppInstanceService {
  private readonly logger = new Logger(AppInstanceService.name);

  constructor(
    private readonly pools: AppPoolService,
    private readonly registry: AppRegistryService,
  ) {}

  async getAll(): Promise<AppInstance[]> {
    const records = await this.registry.findAll();
    return records.map(r => ({
      appId: r.appId,
      status: r.status,
      poolActive: this.pools.hasPool(r.appId),
      installedVersion: r.manifest?.version ?? 'unknown',
    }));
  }

  async get(appId: string): Promise<AppInstance | null> {
    const record = await this.registry.findOne(appId);
    if (!record) return null;
    return {
      appId: record.appId,
      status: record.status,
      poolActive: this.pools.hasPool(appId),
      installedVersion: record.manifest?.version ?? 'unknown',
    };
  }

  async isActive(appId: string): Promise<boolean> {
    const record = await this.registry.findOne(appId);
    return record?.status === 'active';
  }
}
