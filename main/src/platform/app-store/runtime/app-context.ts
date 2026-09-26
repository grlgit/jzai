import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import type { PoolClient } from 'pg';
import { AppPoolService } from '../services/app-pool.service';
import { AppLogService } from '../services/app-log.service';
import type { AppPlatformFacade } from '../services/app-platform.service';
import type { AppConnectionClient } from '../../../agent/tool-bridge/tool-provider.interface';
import { WorkspaceService } from '../../../workspace/workspace.service';
import { ModelRouterService } from '../../../model-router/model-router.service';
import { loadPiAi } from '../../../pi';

export interface LlmCallOptions {
  prompt: string;
  system?: string;
  level?: 'default' | 'coding' | 'reasoning' | 'summary' | 'vision';
  /** 图片输入（视觉模型）：base64 编码图片 + MIME。与 prompt 组成图文混合消息。 */
  images?: Array<{ data: string; mimeType: string }>;
}

export interface LlmResult {
  text: string;
  usage?: unknown;
}

export interface AppContextDeps {
  pools: AppPoolService;
  /** jz_installed_apps.config（secret 字段已解析为真值） */
  config?: Record<string, unknown>;
  workspace?: WorkspaceService;
  /** 应用 shortName，用于定位 {workspace}/app-store/{shortName} */
  shortName?: string;
  modelRouter?: ModelRouterService;
  logBuffer?: AppLogService;
  /** manifest.usesPlatformTools 声明（tools.call 的调用白名单） */
  usesPlatformTools?: string[];
  /** 平台工具执行器（由 activation 经 ToolBridgeService.callTool 注入） */
  toolExecutor?: (toolId: string, params: unknown) => Promise<unknown>;
  /** 按 bindingId 调用用户授权连接；后台调用每次解析持久 service principal */
  connections?: AppConnectionClient;
  /** 首方运行时通道（仅声明 appstore:* 的首方包注入，见 AppPlatformService.buildFacade） */
  platform?: AppPlatformFacade;
}

/**
 * AppContext is injected into extension backend modules via the `forApp(ctx)` static factory.
 * It is the ONLY channel through which app code accesses the platform:
 * own-schema DB pool, resolved config, metered LLM, sandboxed file workspace,
 * and a buffered logger.
 */
export class AppContext {
  /** 自动带 [app:{appId}] 前缀，同时写入应用日志环形缓冲 */
  readonly logger: { log(msg: string): void; warn(msg: string): void; error(msg: string): void };

  constructor(
    readonly appId: string,
    readonly userId: string | undefined,
    private readonly deps: AppContextDeps,
  ) {
    const nestLogger = new Logger(`[app:${appId}]`);
    const write = (level: 'log' | 'warn' | 'error', msg: string) => {
      nestLogger[level](msg);
      this.deps.logBuffer?.append(this.appId, level, msg);
    };
    this.logger = {
      log: m => write('log', m),
      warn: m => write('warn', m),
      error: m => write('error', m),
    };
  }

  /** 安装时填写的配置（configSchema；secret 字段已解密为真值） */
  get config(): Record<string, unknown> {
    return this.deps.config ?? {};
  }

  async query(sql: string, params?: unknown[]) {
    return this.deps.pools.getPool(this.appId)!.query(sql, params as any[]);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return this.deps.pools.transaction(this.appId, fn);
  }

  /** 经平台 ModelRouter 的 LLM 调用（用量按 appId 记日志）；images 提供时走视觉模型（level='vision'） */
  readonly llm = {
    call: async (opts: LlmCallOptions): Promise<LlmResult> => {
      if (!this.deps.modelRouter) throw new Error('LLM service not available');
      const model = this.deps.modelRouter.resolveModelForLevel(opts.level ?? 'default');
      const pi = await loadPiAi();
      const userContent: string | any[] = opts.images?.length
        ? [
            ...opts.images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mimeType })),
            { type: 'text', text: opts.prompt },
          ]
        : opts.prompt;
      const context: { systemPrompt?: string; messages: any[] } = {
        messages: [{ role: 'user', content: userContent, timestamp: Date.now() }],
      };
      if (opts.system) context.systemPrompt = opts.system;
      // 鉴权：与 DynamicAgentService 同源（ModelRouter.getLlmAuthToken），否则官方/自购云端报 No API key
      const apiKey = this.deps.modelRouter.getLlmAuthToken((model as any).provider);
      const msg = await pi.completeSimple(model as any, context as any, apiKey ? { apiKey } : undefined);
      if (msg.stopReason === 'error') {
        throw new Error(msg.errorMessage || 'LLM call failed');
      }
      const text = (msg.content as any[])
        .filter(c => c?.type === 'text')
        .map(c => c.text)
        .join('');
      this.logger.log(`llm.call level=${opts.level ?? 'default'} usage=${JSON.stringify(msg.usage ?? {})}`);
      return { text, usage: msg.usage };
    },
  };

  /**
   * 调用平台内置工具（通道②）。
   * 仅限 manifest.usesPlatformTools 白名单内声明的工具，未声明即拒绝。
   */
  readonly tools = {
    call: async (name: string, params: unknown): Promise<unknown> => {
      if (!(this.deps.usesPlatformTools ?? []).includes(name)) {
        throw new Error(
          `Platform tool "${name}" is not declared in manifest.usesPlatformTools (app ${this.appId})`,
        );
      }
      if (!this.deps.toolExecutor) throw new Error('Platform tool executor not available');
      this.logger.log(`tools.call ${name}`);
      return this.deps.toolExecutor(name, params);
    },
  };

  get connections(): AppConnectionClient {
    if (!this.deps.connections) throw new Error('Connection binding service not available');
    return this.deps.connections;
  }

  /**
   * 首方运行时通道（D5 运行时半）。
   * 仅当 manifest 声明 appstore:* 且为首方 appId 时由 activation 注入；
   * 普通扩展包访问为 undefined——不得假定其存在。
   */
  get platform(): AppPlatformFacade | undefined {
    return this.deps.platform;
  }

  /** 应用目录 {workspace}/app-store/{shortName} 内的沙箱文件访问（防穿越） */
  readonly workspace = {
    getAppDir: (): string => {
      const ws = this.requireWorkspace();
      return path.join(ws.getRoot(), 'app-store', this.deps.shortName ?? this.appId);
    },
    readFile: async (p: string): Promise<Buffer> => {
      return fs.promises.readFile(this.resolveInAppDir(p));
    },
    writeFile: async (p: string, data: Buffer): Promise<void> => {
      const target = this.resolveInAppDir(p);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, data);
    },
  };

  private requireWorkspace(): WorkspaceService {
    if (!this.deps.workspace) throw new Error('Workspace service not available');
    return this.deps.workspace;
  }

  private resolveInAppDir(p: string): string {
    const base = path.resolve(this.workspace.getAppDir());
    const resolved = path.resolve(base, p);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error(`Path escapes app dir: ${p}`);
    }
    return resolved;
  }
}
