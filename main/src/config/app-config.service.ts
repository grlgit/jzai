import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class AppConfigService implements OnModuleInit {
  private readonly logger = new Logger(AppConfigService.name);
  private systemConfig: Record<string, any> = {};
  private modelConfig: Record<string, any> = {};
  private watchers: fs.FSWatcher[] = [];

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit() {
    this.loadSystemConfig();
    this.loadModelConfig();
    this.watchFiles();
  }

  /** Get a nested config value using dot notation, e.g. 'knowledgeBase.mcpEndpoint' */
  get<T = any>(key: string, defaultValue?: T): T {
    // First try env vars (underscore-separated)
    const envKey = key.replace(/\./g, '_').toUpperCase();
    const envVal = this.configService.get(envKey);
    if (envVal !== undefined) return envVal as T;

    // Then try system config
    const parts = key.split('.');
    let val: any = this.systemConfig;
    for (const p of parts) {
      if (val == null || typeof val !== 'object') { val = undefined; break; }
      val = val[p];
    }
    if (val !== undefined) return val as T;

    return defaultValue as T;
  }

  /** Get the full system config object */
  getSystemConfig(): Record<string, any> {
    return { ...this.systemConfig };
  }

  /** Get the full model config object */
  getModelConfig(): Record<string, any> {
    return { ...this.modelConfig };
  }

  /** Get env var with fallback (delegate to NestJS ConfigService) */
  getEnv<T = string>(key: string, defaultValue?: T): T {
    return this.configService.get(key, defaultValue as any) as T;
  }

  private getConfigDir(): string {
    return path.join(process.cwd(), 'config');
  }

  private loadSystemConfig() {
    const filePath = path.join(this.getConfigDir(), 'system.json');
    try {
      this.systemConfig = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.logger.log('Loaded system.json');
    } catch {
      this.systemConfig = {};
      this.logger.warn('system.json not found, using defaults');
    }
  }

  private loadModelConfig() {
    const filePath = path.join(this.getConfigDir(), 'models.json');
    try {
      this.modelConfig = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.logger.log('Loaded models.json');
    } catch {
      this.modelConfig = {};
    }
  }

  private watchFiles() {
    const configDir = this.getConfigDir();
    for (const file of ['system.json', 'models.json']) {
      const filePath = path.join(configDir, file);
      if (!fs.existsSync(filePath)) continue;
      try {
        const watcher = fs.watch(filePath, () => {
          this.logger.log(`Config file changed: ${file}, reloading...`);
          if (file === 'system.json') this.loadSystemConfig();
          else this.loadModelConfig();
        });
        this.watchers.push(watcher);
      } catch {
        // watch may fail on some platforms, non-critical
      }
    }
  }

  onModuleDestroy() {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
