import { Injectable } from '@nestjs/common';
import { ToolProvider } from './tool-provider.interface';

export interface RegisteredProvider {
  appId: string;
  provider: ToolProvider;
}

export type TokenLimitMap = Record<string, number>;

/**
 * Runtime registry for tool providers contributed by installed apps.
 *
 * L2: registry exists but may be empty; built-in providers remain static.
 * L3: AppInstallService registers app providers here after DynamicModuleLoader.load().
 */
@Injectable()
export class DynamicToolProviderRegistry {
  private readonly byApp = new Map<string, RegisteredProvider[]>();
  private readonly tokenLimits = new Map<string, number>();
  private readonly ownerApps = new Map<string, string>();

  register(appId: string, providers: ToolProvider[], tokenLimits: TokenLimitMap = {}): void {
    const registered: RegisteredProvider[] = [];
    for (const provider of providers) {
      registered.push({ appId, provider });
      for (const toolId of provider.toolIds) {
        this.ownerApps.set(toolId, appId);
      }
      if (provider.tokenLimits) {
        for (const [toolName, limit] of Object.entries(provider.tokenLimits)) {
          this.tokenLimits.set(toolName, limit);
          this.ownerApps.set(toolName, appId);
        }
      }
    }
    this.registerTokenLimits(appId, tokenLimits);
    this.byApp.set(appId, registered);
  }

  /**
   * Register token limits for app-owned tools that are NOT created by a provider
   * (e.g. skill tools `skill_<name>` created by SkillToolProvider).
   */
  registerTokenLimits(appId: string, tokenLimits: TokenLimitMap): void {
    for (const [toolName, limit] of Object.entries(tokenLimits)) {
      this.tokenLimits.set(toolName, limit);
      this.ownerApps.set(toolName, appId);
    }
  }

  unregister(appId: string): void {
    // 按归属整体清理：provider 工具、provider.tokenLimits、registerTokenLimits
    // 注册的 skill 工具，都通过 ownerApps 标了归属，一次扫净。
    for (const [toolName, owner] of this.ownerApps) {
      if (owner === appId) {
        this.ownerApps.delete(toolName);
        this.tokenLimits.delete(toolName);
      }
    }
    this.byApp.delete(appId);
  }

  getAll(): ToolProvider[] {
    const result: ToolProvider[] = [];
    for (const registered of this.byApp.values()) {
      result.push(...registered.map(r => r.provider));
    }
    return result;
  }

  getTokenLimit(toolName: string): number | undefined {
    return this.tokenLimits.get(toolName);
  }

  getOwnerApp(toolName: string): string | undefined {
    return this.ownerApps.get(toolName);
  }
}
