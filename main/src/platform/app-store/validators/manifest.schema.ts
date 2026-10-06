import { z } from 'zod';

const i18nStringSchema = z.object({
  zh: z.string().min(1),
  en: z.string().optional(),
});

const panelSchema = z.object({
  id: z.string(),
  name: i18nStringSchema,
  icon: z.string().optional(),
  groupName: z.string().optional(),
  sortOrder: z.number().int().optional(),
  permission: z.string().optional(),
  entryComponent: z.string().optional(),
  agentId: z.string().optional(),
  messageSchema: z.string().optional(),
  keepAlive: z.boolean().optional(),
});

const migrationEntrySchema = z.object({
  version: z.number().int().positive(),
  file: z.string(),
  down: z.string().optional(),
});

const toolProviderSchema = z.object({
  class: z.string(),
  toolIds: z.array(z.string()),
  group: z.string().optional(),
  tokenLimits: z.record(z.string(), z.number().int().positive().max(512000)).optional(),
  /** 逐工具权限声明：toolId → manifest.permissions[].id（PLAT-010） */
  permissions: z.record(z.string(), z.string()).optional(),
  /** 声明这些工具经 MCP facade 对外暴露（仅首方 appId 可通过校验）。缺省 false */
  mcpExposed: z.boolean().optional(),
});

const controllerSchema = z.object({
  class: z.string(),
  /** 允许经 invoke 入口调用的方法白名单，格式 "ClassName.methodName" */
  handlers: z.array(z.string()).min(1),
  basePath: z.string().optional(),
  /** 逐 handler 权限声明："ClassName.methodName" → manifest.permissions[].id（PLAT-010） */
  permissions: z.record(z.string(), z.string()).optional(),
});

const configFieldSchema = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
  type: z.enum(['string', 'number', 'boolean', 'enum', 'secret']),
  label: i18nStringSchema,
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string()).optional(),
});

const agentDelegationSchema = z.object({
  targetAgent: z.string(),
  keywords: z.array(z.string()).min(1),
  fromAgent: z.string().default('main'),
  description: z.string().optional(),
});

/**
 * 伴随服务声明（PLAT-016）：APP 包携带的长驻服务制品，由平台在安装/激活时拉起、
 * 健康检查、随 deactivate/upgrade/uninstall 回收。制品是 APP 内容，不进标准产品。
 *
 * - runtime=process：依赖已存在于平台运行环境时直接 spawn（cwd 为包内相对目录）；
 * - runtime=container：docker 可用时以包内 Dockerfile 构建或指定镜像跑 sidecar 容器；
 * - 模板变量：command/env/inject 中可用 {port}（process=平台分配的 loopback 端口，
 *   container=containerPort）与 {host}（process=127.0.0.1，container=容器名）；
 * - env 值 {secret:<key>} 复用 configSchema secret 字段的 credential store 语义；
 * - inject 的 "config.<key>" 在激活时把实际 endpoint 写入 APP config（运行时注入，不落库）。
 */
const companionServiceSchema = z.object({
  id: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
  runtime: z.enum(['process', 'container']),
  /** 包内相对目录（process=工作目录；container=构建上下文，须含 Dockerfile 当未指定 image） */
  cwd: z.string(),
  /** process 形态必填；支持 {port}/{host} 模板 */
  command: z.array(z.string()).optional(),
  /** container 形态：预构建镜像（与 Dockerfile 构建二选一） */
  image: z.string().optional(),
  /** container 形态：容器内服务端口 */
  containerPort: z.number().int().positive().max(65535).optional(),
  env: z.record(z.string(), z.string()).optional(),
  health: z
    .object({
      path: z.string().regex(/^\//).default('/health'),
      intervalSec: z.number().positive().max(300).optional().default(5),
      timeoutSec: z.number().positive().max(600).optional().default(60),
    })
    .optional(),
  inject: z.record(z.string().regex(/^config\.[a-zA-Z][a-zA-Z0-9_]{0,31}$/), z.string()).optional(),
  resources: z
    .object({
      cpuMillis: z.number().int().positive().max(64000).optional(),
      memoryMb: z.number().int().positive().max(65536).optional(),
    })
    .optional(),
  /** 崩溃重启上限（默认 5，指数退避） */
  maxRestarts: z.number().int().positive().max(20).optional().default(5),
});

export const AppManifestSchema = z.object({
  manifestVersion: z.literal('1.0'),
  appId: z.string().regex(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*){2,}$/),
  shortName: z.string().regex(/^[a-z][a-z0-9-]{2,31}$/),
  nsPrefix: z
    .string()
    .regex(/^[a-z][a-z0-9]{1,5}$/)
    .refine(v => !['jz', 'skill', 'mcp', 'tool'].includes(v), {
      message: 'nsPrefix must not be jz/skill/mcp/tool',
    }),
  name: i18nStringSchema,
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: i18nStringSchema.optional(),
  author: z.string().optional(),
  license: z.string().optional(),
  /** 需要订阅 License 才能运行（无有效 License 安装后进入 license_expired 状态） */
  requiresLicense: z.boolean().optional(),
  icon: z.string().optional(),
  tags: z.array(z.string()).optional(),
  engines: z
    .object({
      jianzhi: z.string().optional(),
    })
    .optional(),
  database: z
    .object({
      schemaName: z
        .string()
        .regex(/^app_[a-z][a-z0-9_]{2,47}$/)
        .refine(v => !['public', 'pg_catalog', 'information_schema'].includes(v), {
          message: 'schemaName must not be reserved',
        }),
      sharedTablesRead: z.array(z.string()).optional(),
      statementTimeoutMs: z.number().int().positive().max(60000).optional().default(30000),
      poolMax: z.number().int().positive().max(5).optional().default(3),
    })
    .optional(),
  permissions: z
    .array(
      z.object({
        id: z.string(),
        label: i18nStringSchema,
        default: z.enum(['user', 'admin', 'none']).optional(),
      }),
    )
    .optional(),
  platformCapabilities: z.array(z.string()).optional(),
  configSchema: z
    .object({
      fields: z.array(configFieldSchema),
    })
    .optional(),
  migrations: z.array(migrationEntrySchema).optional(),
  /** 声明要经 ctx.tools.call 调用的平台内置工具（须在平台分级白名单内，validator 校验） */
  usesPlatformTools: z.array(z.string()).optional(),
  agents: z.array(z.object({ file: z.string() })).optional(),
  skills: z
    .array(
      z.object({
        dir: z.string(),
        /** 该技能注册为 skill_<dir名> 工具后的输出截断上限（默认 20000） */
        tokenLimit: z.number().int().positive().max(512000).optional(),
      }),
    )
    .optional(),
  backend: z
    .object({
      entry: z.string(),
      module: z.string(),
      toolProviders: z.array(toolProviderSchema).optional(),
      controllers: z.array(controllerSchema).optional(),
    })
    .optional(),
  panels: z.array(panelSchema).optional(),
  agentDelegation: z.array(agentDelegationSchema).optional(),
  /** 伴随服务声明（PLAT-016） */
  services: z.array(companionServiceSchema).optional(),
  /**
   * APP 知识空间声明（T2）：安装/激活时按声明创建 APP 空间（ensureAppSpace）。
   * 空数组或缺省字段 = 不声明（不建）；声明 [{}] = 单空间 app-{appId}；
   * 带 slug = app-{appId}-{slug} 多空间。
   */
  knowledge: z
    .object({
      spaces: z.array(
        z.object({
          slug: z
            .string()
            .regex(/^[a-z][a-z0-9-]{0,31}$/)
            .optional(),
          name: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

export type AppManifest = z.infer<typeof AppManifestSchema>;
