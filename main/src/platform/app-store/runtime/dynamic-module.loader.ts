import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { AppContext } from './app-context';

export interface LoadedApp {
  appId: string;
  entryPath: string;
  moduleRef: unknown;
}

/**
 * Loads and unloads extension backend modules at runtime.
 *
 * NestJS's LazyModuleLoader works well for NestJS modules, but because
 * extension modules must also be ejectable (require.cache cleanup),
 * we use plain require() + a simple registry rather than LazyModuleLoader.
 *
 * The tradeoff: no NestJS DI tree for the extension module (they receive
 * AppContext via the static forApp(ctx) factory), but full cache control
 * for clean unloads.
 */
@Injectable()
export class DynamicModuleLoader implements OnModuleDestroy {
  private readonly logger = new Logger(DynamicModuleLoader.name);
  private readonly loaded = new Map<string, LoadedApp>();

  /**
   * Load an app's backend module.
   * Expects the module entry to export a static `forApp(ctx: AppContext)` factory
   * that returns an object with tool provider instances.
   */
  load(appId: string, entryAbsPath: string, context: AppContext): LoadedApp {
    if (this.loaded.has(appId)) {
      this.logger.warn(`App ${appId} already loaded; reload requires unload first`);
      return this.loaded.get(appId)!;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entryAbsPath);
    const ModClass = mod.default ?? mod;

    let moduleRef: unknown = ModClass;
    if (typeof ModClass?.forApp === 'function') {
      moduleRef = ModClass.forApp(context);
    }

    const record: LoadedApp = { appId, entryPath: entryAbsPath, moduleRef };
    this.loaded.set(appId, record);
    this.logger.log(`App ${appId} backend module loaded from ${entryAbsPath}`);
    return record;
  }

  /**
   * Unload an app's backend module and evict it from require.cache.
   * Returns requiresRestart: true because Node.js module state may linger in closures.
   */
  unload(appId: string): { requiresRestart: boolean } {
    const record = this.loaded.get(appId);
    if (!record) return { requiresRestart: false };

    this.loaded.delete(appId);

    // Evict all entries under the app's install directory from require.cache
    const dir = path.dirname(record.entryPath);
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(dir)) {
        delete require.cache[key];
      }
    }

    this.logger.log(`App ${appId} backend module unloaded`);
    return { requiresRestart: true };
  }

  isLoaded(appId: string): boolean {
    return this.loaded.has(appId);
  }

  getModuleRef(appId: string): unknown | undefined {
    return this.loaded.get(appId)?.moduleRef;
  }

  onModuleDestroy() {
    for (const appId of this.loaded.keys()) {
      this.unload(appId);
    }
  }
}

// Satisfies import reference without adding a runtime dep
interface OnModuleDestroy { onModuleDestroy(): void; }
