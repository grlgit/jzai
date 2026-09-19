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

export type InvocationPrincipalType = 'user' | 'delegated' | 'service' | 'dev-mcp' | 'system';

export interface InvocationPrincipal {
  readonly type: InvocationPrincipalType;
  readonly principalId: string;
  readonly userId?: string;
  readonly roleIds: readonly string[];
  readonly departmentIds: readonly string[];
  readonly permissions: readonly string[];
  readonly scopes: readonly string[];
  readonly origin: string;
  readonly delegatedBy?: string;
  readonly servicePrincipalId?: string;
  readonly tokenId?: string;
  readonly issuedAt: number;
  readonly expiresAt?: number;
}

export interface AppConnectionBinding {
  readonly id: string;
  readonly appId: string;
  readonly connectionName: string;
  readonly toolName: string;
  readonly inputSchemaDigest: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly servicePrincipalId?: string;
  readonly enabled: boolean;
}

export interface AppConnectionDescriptor extends AppConnectionBinding {
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown;
  readonly schemaCurrent: boolean;
}

export interface AppConnectionClient {
  listBindings(): Promise<AppConnectionDescriptor[]>;
  describe(bindingId: string): Promise<AppConnectionDescriptor>;
  invoke(bindingId: string, params: unknown): Promise<unknown>;
}

export interface AppPlatformToolClient {
  call(name: string, params: unknown): Promise<unknown>;
}

export interface AppInvocationContext {
  readonly appId: string;
  readonly requestId: string;
  readonly principal?: InvocationPrincipal;
  readonly userId?: string;
  readonly roleIds: readonly string[];
  readonly permissions: readonly string[];
  readonly tools: AppPlatformToolClient;
  readonly connections: AppConnectionClient;
}

export interface LlmCallOptions {
  prompt: string;
  system?: string;
  level?: 'default' | 'coding' | 'reasoning' | 'summary';
}

export interface QueryResultField {
  name: string;
  tableID: number;
  columnID: number;
  dataTypeID: number;
  dataTypeSize: number;
  dataTypeModifier: number;
  format: string;
}

/** Mirrors the observable result shape returned by pg Pool.query(). */
export interface QueryResult<T = any> {
  command: string;
  rowCount: number | null;
  oid: number;
  rows: T[];
  fields: QueryResultField[];
}

export interface QueryClient {
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface AppContext {
  readonly appId: string;
  readonly userId?: string;

  /** 安装时填写的配置（configSchema；secret 字段已解密为真值） */
  readonly config: Record<string, unknown>;

  /** 应用专属 schema 的数据库查询（裸表名即可，search_path 已固定） */
  query<T = any>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T>(fn: (client: QueryClient) => Promise<T>): Promise<T>;

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

  /** 按管理员配置的 bindingId 调用连接；后台执行使用绑定的可撤销 service principal */
  readonly connections: AppConnectionClient;
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
  principal?: InvocationPrincipal;
  userId?: string;
  agentKey?: string;
  userEmail?: string;
  piAi?: unknown;
  connections?: AppConnectionClient;
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

export type AppDeactivateReason = 'upgrade' | 'uninstall' | 'shutdown';

export interface AppModuleShape {
  toolProviders: ToolProvider[];
  /** key 必须与 manifest backend.controllers[].class 一致 */
  controllers?: Record<string, unknown>;
  /** 激活完成、工具已注册后调用，可异步（worker 恢复、lease 重建等） */
  onActivate?(): void | Promise<void>;
  /**
   * 停用前调用（升级/卸载/平台退出）。平台先进入 draining 拒绝新调用，
   * 再等待本钩子完成（有超时）；应停止 timer/worker、排空在途任务。
   */
  onDeactivate?(reason: AppDeactivateReason): void | Promise<void>;
}

export interface AppModuleClass {
  forApp(ctx: AppContext): AppModuleShape | Promise<AppModuleShape>;
}
