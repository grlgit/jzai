/**
 * 后端契约：模块入口、AppContext、ToolProvider。
 *
 * 加载流程：平台 DynamicModuleLoader require(dist/backend/index.js)，
 * 取导出类的 static forApp(ctx) 返回值：
 *   { toolProviders: ToolProvider[], controllers?: { [ClassName]: instance } }
 */

// ---------------------------------------------------------------------------
// AppContext —— 应用访问平台的唯一通道
// ---------------------------------------------------------------------------

export interface LlmCallOptions {
  prompt: string;
  system?: string;
  level?: 'default' | 'coding' | 'reasoning' | 'summary';
}

export interface AppContext {
  readonly appId: string;
  readonly userId?: string;

  /** 安装时填写的配置（configSchema；secret 字段已解密为真值） */
  readonly config: Record<string, unknown>;

  /** 应用专属 schema 的数据库查询（裸表名即可，search_path 已固定） */
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (client: any) => Promise<T>): Promise<T>;

  /** 经平台 ModelRouter 的 LLM 调用（走平台计量） */
  readonly llm: {
    call(opts: LlmCallOptions): Promise<{ text: string; usage?: unknown }>;
  };

  /** 应用目录沙箱文件访问（{workspace}/app-store/{shortName}，防穿越） */
  readonly workspace: {
    getAppDir(): string;
    readFile(p: string): Promise<Buffer>;
    writeFile(p: string, data: Buffer): Promise<void>;
  };

  /** 自动带 [app:{appId}] 前缀；可经 GET /api/app-store/apps/:id/logs 查看 */
  readonly logger: {
    log(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };

  /** 调用平台内置工具（仅限 manifest.usesPlatformTools 白名单内声明的） */
  readonly tools: {
    call(name: string, params: unknown): Promise<unknown>;
  };
}

// ---------------------------------------------------------------------------
// ToolProvider —— 注册给 agent 的工具
// ---------------------------------------------------------------------------

export interface ToolCatalogEntry {
  id: string;
  label: string;
  description?: string;
  group?: string;
  /** JSON Schema（typebox 或普通对象均可） */
  parameters?: unknown;
}

export interface ToolContext {
  userId?: string;
  agentKey?: string;
  userEmail?: string;
  piAi?: unknown;
}

export interface ToolInstance {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema 参数定义 */
  parameters: unknown;
  /** 平台以 (toolId, args) 调用 */
  execute: (id: string, args: any) => Promise<any>;
}

export interface ToolProvider {
  readonly toolIds: string[];
  readonly tokenLimits?: Record<string, number>;
  getCatalog(): ToolCatalogEntry[];
  createTools(ctx: ToolContext): Promise<ToolInstance[]>;
}

// ---------------------------------------------------------------------------
// 模块入口契约
// ---------------------------------------------------------------------------

export interface AppModuleShape {
  toolProviders: ToolProvider[];
  /** key 必须与 manifest backend.controllers[].class 一致 */
  controllers?: Record<string, unknown>;
}

export interface AppModuleClass {
  forApp(ctx: AppContext): AppModuleShape | Promise<AppModuleShape>;
}
