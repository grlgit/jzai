/**
 * manifest.json 类型（与平台 main/src/platform/app-store/validators/manifest.schema.ts 同步维护）。
 * 注意：本文件为手工同步副本，平台 schema 演进时随 SDK 版本一起更新。
 */

export interface I18nString {
  zh: string;
  en?: string;
}

export interface PanelDeclaration {
  /** 须 {nsPrefix}[A-Z] 开头，如 schedMain */
  id: string;
  name: I18nString;
  icon?: string;
  groupName?: string;
  sortOrder?: number;
  permission?: string;
  /** dist 内的 ESM 路径，如 dist/pages/MyPanel.js */
  entryComponent?: string;
  agentId?: string;
  messageSchema?: string;
  keepAlive?: boolean;
}

export interface ToolProviderDeclaration {
  class: string;
  /** 须 {nsPrefix}_* 且总长 ≤ 64 */
  toolIds: string[];
  group?: string;
  /** 各工具输出截断上限（≤512000），default 键为兜底 */
  tokenLimits?: Record<string, number>;
}

export interface ControllerDeclaration {
  class: string;
  /** 允许经 invoke 入口调用的方法白名单，格式 "ClassName.methodName" */
  handlers: string[];
  basePath?: string;
}

export interface ConfigField {
  key: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'secret';
  label: I18nString;
  required?: boolean;
  default?: unknown;
  min?: number;
  max?: number;
  options?: string[];
}

export interface AppManifest {
  manifestVersion: '1.0';
  /** 反向域名，全局唯一；com.jianzhi.* / com.menhu.* 为首方保留 */
  appId: string;
  /** ^[a-z][a-z0-9-]{2,31}$，用于文件路径 */
  shortName: string;
  /** ^[a-z][a-z0-9]{1,5}$，全部标识符（工具/面板/agent/权限）的命名空间前缀 */
  nsPrefix: string;
  name: I18nString;
  /** semver */
  version: string;
  description?: I18nString;
  /** 开发者署名，显示在安装详情中 */
  author?: string;
  license?: string;
  icon?: string;
  tags?: string[];
  engines?: { jianzhi?: string };
  database?: {
    /** ^app_[a-z][a-z0-9_]{2,47}$ */
    schemaName: string;
    sharedTablesRead?: string[];
    statementTimeoutMs?: number;
    poolMax?: number;
  };
  permissions?: Array<{
    /** 须 {nsPrefix}:{name} */
    id: string;
    label: I18nString;
    default?: 'user' | 'admin' | 'none';
  }>;
  platformCapabilities?: string[];
  configSchema?: { fields: ConfigField[] };
  migrations?: Array<{ version: number; file: string; down?: string }>;
  agents?: Array<{ file: string }>;
  skills?: Array<{ dir: string; tokenLimit?: number }>;
  backend?: {
    entry: string;
    module: string;
    toolProviders?: ToolProviderDeclaration[];
    controllers?: ControllerDeclaration[];
  };
  panels?: PanelDeclaration[];
  agentDelegation?: Array<{
    targetAgent: string;
    keywords: string[];
    fromAgent?: string;
    description?: string;
  }>;
  /** 声明要经 ctx.tools.call 调用的平台内置工具（分级白名单内） */
  usesPlatformTools?: string[];
  /**
   * APP 知识空间声明（T2）：安装/激活时按声明创建 APP 空间。
   * 声明 [{}] = 单空间 app-{appId}；带 slug = app-{appId}-{slug} 多空间。
   */
  knowledge?: {
    spaces?: Array<{ slug?: string; name?: string }>;
  };
}
