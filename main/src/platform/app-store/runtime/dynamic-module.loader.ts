import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import { AppContext } from './app-context';

export type AppDeactivateReason = 'upgrade' | 'uninstall' | 'shutdown';

export interface LoadedApp {
  appId: string;
  entryPath: string;
  moduleRef: unknown;
}

/** onDeactivate 钩子最长等待时间，超时后继续卸载并在日志中诊断 */
const DEACTIVATE_HOOK_TIMEOUT_MS = 10_000;

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
   * that returns an object with tool provider instances; async factories are awaited.
   */
  async load(appId: string, entryAbsPath: string, moduleName: string, context: AppContext): Promise<LoadedApp> {
    if (this.loaded.has(appId)) {
      this.logger.warn(`App ${appId} already loaded; reload requires unload first`);
      return this.loaded.get(appId)!;
    }

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(entryAbsPath);
    const defaultExport = mod.default ?? mod;
    const ModClass = mod[moduleName]
      ?? (defaultExport?.name === moduleName ? defaultExport : undefined);
    if (typeof ModClass?.forApp !== 'function') {
      throw new Error(`Backend export ${moduleName} must provide static forApp(ctx)`);
    }
    const moduleRef = await ModClass.forApp(context);

    const record: LoadedApp = { appId, entryPath: entryAbsPath, moduleRef };
    this.loaded.set(appId, record);
    this.logger.log(`App ${appId} backend module loaded from ${entryAbsPath}`);
    return record;
  }

  /**
   * Unload an app's backend module and evict it from require.cache.
   * Invokes the module's onDeactivate(reason) hook exactly once (with timeout)
   * before eviction. Returns requiresRestart: true because Node.js module
   * state may linger in closures.
   */
  async unload(appId: string, reason: AppDeactivateReason = 'uninstall'): Promise<{ requiresRestart: boolean }> {
    const record = this.loaded.get(appId);
    if (!record) return { requiresRestart: false };

    // 先从注册表摘除，保证钩子恰好执行一次
    this.loaded.delete(appId);

    const hook = (record.moduleRef as { onDeactivate?: (r: AppDeactivateReason) => void | Promise<void> })?.onDeactivate;
    if (typeof hook === 'function') {
      try {
        await this.withTimeout(
          Promise.resolve(hook.call(record.moduleRef, reason)),
          DEACTIVATE_HOOK_TIMEOUT_MS,
          `onDeactivate(${reason}) for ${appId}`,
        );
      } catch (err: any) {
        this.logger.error(`onDeactivate(${reason}) failed for ${appId}: ${err.message}`);
      }
    }

    // Evict all entries under the app's install directory from require.cache
    const dir = path.dirname(record.entryPath);
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(dir)) {
        delete require.cache[key];
      }
    }

    this.logger.log(`App ${appId} backend module unloaded (${reason})`);
    return { requiresRestart: true };
  }

  private withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
      ),
    ]);
  }

  isLoaded(appId: string): boolean {
    return this.loaded.has(appId);
  }

  getModuleRef(appId: string): unknown | undefined {
    return this.loaded.get(appId)?.moduleRef;
  }

  async onModuleDestroy() {
    for (const appId of [...this.loaded.keys()]) {
      await this.unload(appId, 'shutdown');
    }
  }
}

// Satisfies import reference without adding a runtime dep
interface OnModuleDestroy { onModuleDestroy(): void | Promise<void>; }
