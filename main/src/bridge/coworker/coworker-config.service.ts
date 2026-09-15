import { Injectable, Logger } from '@nestjs/common';
import { CoWorker } from './coworker.service';
import * as yaml from 'js-yaml';

/**
 * OpenClaw 核心内置工具目录（来自 tool-catalog.ts）。
 * 管理员在授权界面从此列表 + 主台自定义工具中勾选授权。
 */
export const OPENCLAW_BUILTIN_TOOLS: Array<{ id: string; label: string; section: string; description: string }> = [
  // 文件
  { id: 'read', label: '读取文件', section: '文件', description: 'Read file contents' },
  { id: 'write', label: '写入文件', section: '文件', description: 'Create or overwrite files' },
  { id: 'edit', label: '编辑文件', section: '文件', description: 'Make precise edits' },
  { id: 'apply_patch', label: '补丁应用', section: '文件', description: 'Patch files' },
  // 运行时
  { id: 'exec', label: '执行命令', section: '运行时', description: 'Execute shell commands' },
  { id: 'process', label: '进程管理', section: '运行时', description: 'Manage processes' },
  { id: 'code_execution', label: '沙箱代码执行', section: '运行时', description: 'Run sandboxed remote analysis' },
  // Web
  { id: 'web_search', label: '网页搜索', section: 'Web', description: 'Search the web' },
  { id: 'web_fetch', label: '网页抓取', section: 'Web', description: 'Fetch web content' },
  { id: 'x_search', label: 'X/Twitter搜索', section: 'Web', description: 'Search X posts' },
  // 记忆
  { id: 'memory_search', label: '记忆搜索', section: '记忆', description: 'Semantic search' },
  { id: 'memory_get', label: '读取记忆', section: '记忆', description: 'Read memory files' },
  // 会话
  { id: 'sessions_list', label: '会话列表', section: '会话', description: 'List sessions' },
  { id: 'sessions_history', label: '会话历史', section: '会话', description: 'Session history' },
  { id: 'sessions_send', label: '发送到会话', section: '会话', description: 'Send to sessions' },
  { id: 'sessions_spawn', label: '生成子智能体', section: '会话', description: 'Spawn sub-agents' },
  { id: 'subagents', label: '子智能体管理', section: '会话', description: 'Manage sub-agents' },
  // UI/浏览器
  { id: 'browser', label: '浏览器控制', section: 'UI', description: 'Control web browser' },
  { id: 'canvas', label: 'Canvas画布', section: 'UI', description: 'Control Canvas surfaces' },
  // 消息
  { id: 'message', label: '发送消息', section: '消息', description: 'Send messages to channels' },
  // 自动化
  { id: 'cron', label: '定时任务', section: '自动化', description: 'Schedule automated tasks' },
  { id: 'gateway', label: '网关控制', section: '自动化', description: 'Gateway control' },
  // 设备
  { id: 'nodes', label: '设备节点', section: '设备', description: 'Nodes + devices' },
  // 媒体：均需模型/服务商具备对应能力，否则 OpenClaw 运行时不会挂载该工具
  // （表现为 tools.allow contains unknown entries 警告 + 工具实际缺失）
  { id: 'image', label: '图片理解', section: '媒体', description: 'Image understanding（需模型支持视觉）' },
  { id: 'image_generate', label: '图片生成', section: '媒体', description: 'Image generation（需配置图片服务商）' },
  { id: 'music_generate', label: '音乐生成', section: '媒体', description: 'Music generation（需配置音乐服务商）' },
  { id: 'video_generate', label: '视频生成', section: '媒体', description: 'Video generation（需配置视频服务商）' },
  { id: 'tts', label: '文字转语音', section: '媒体', description: 'Text-to-speech（需配置 TTS 服务商）' },
];

/** 主台工具在能力目录中以一个合成 MCP server 的形式呈现（运行时确实经 MCP 代理触达）。 */
export const HOST_TOOL_SERVER_ID = 'jianzhi-host';
/** 知识库/自定义工具 MCP server。 */
export const KB_TOOL_SERVER_ID = 'jianzhi-kb';
/** 非 OpenClaw 内置工具在 jz_coworkers.tools 中的统一前缀。 */
export const JIANZHI_TOOL_PREFIX = 'jianzhi_';

/** 主台工具分组名展示归一（email 分组为历史小写英文，其余均为中文）。 */
function normalizeHostGroup(group: string): string {
  return group?.toLowerCase() === 'email' ? '邮件' : group || '其他';
}

/**
 * plugins.allow 全量白名单(OpenClaw plugin id,非 npm 包名)。
 * OpenClaw 默认 bundledDiscovery:"allowlist" 模式下,未列出的插件(含内置)会被
 * not-in-allowlist 挡掉;allow 为空则所有已发现的外部插件都会自动加载。
 * 因此现场在用的 6 个内置插件须一并列入;新增内置插件时同步更新此处。
 * 目标:放行个人微信 openclaw-weixin + 见智桥 jianzhi-bridge + 6 个内置插件,
 * 阻止企业微信残留 wecom-openclaw-plugin 等未授权插件自动加载。
 */
const PLUGIN_ALLOWLIST = [
  'openclaw-weixin', // 个人微信(外部,@tencent-weixin/openclaw-weixin)
  'jianzhi-bridge', // 见智审计/回传桥(内置,enabledByDefault:false)
  'duckduckgo', // 网页搜索(内置,无 key provider,供 web_search 工具使用)
  'browser',
  'device-pair',
  'file-transfer',
  'memory-core',
  'phone-control',
  'talk-voice',
];

/**
 * Generates OpenClaw YAML configuration from CoWorker definition.
 * Sensitive fields use ${ENV_VAR} placeholders — never embedded in plain text.
 */
@Injectable()
export class CoWorkerConfigService {
  private readonly logger = new Logger(CoWorkerConfigService.name);

  /**
   * Generate the full openclaw.yaml content for a CoWorker.
   */
  private buildConfigObject(cw: CoWorker, mainUrl: string): Record<string, any> {
    const config: Record<string, any> = {
      agents: {
        defaults: {
          // 模型格式：provider-id/model-id
          model: 'jianzhi-proxy/auto',
          maxConcurrent: 1,
          // 人格指令不写在这里。较新版 OpenClaw 移除了 systemPromptOverride，
          // agents.defaults 是 strict schema —— 写入未知键会让整份配置校验失败（exit 78）。
          // 人格通过 workspace 根目录的 SOUL.md 下发，见 generateSoulMarkdown()。
          // OpenClaw 的文件操作根目录。指向容器内 /workspace，由部署包 bind-mount 到
          // 用户指定的宿主目录（OPENCLAW_WORKDIR），使 OpenClaw 可读写用户本地业务文件。
          workspace: '/workspace',
          // 记忆系统 embedding 提供者。OpenClaw 默认找 openai provider 的 API key，
          // 但 CoWorker 只有 jianzhi-proxy（chat），导致 memory sync 全部失败。
          // 显式配置 remote.baseUrl + remote.apiKey 把 embedding 请求路由到主台代理，
          // remote 的凭证检查优先级高于 provider 默认值，无需额外 OpenAI key。
          memorySearch: {
            provider: 'openai',
            model: 'text-embedding-3-small',
            remote: {
              baseUrl: '${JIANZHI_MAIN_URL}/api/cw/llm/v1',
              apiKey: '${JIANZHI_CW_TOKEN}',
            },
          },
        },
      },
      models: {
        // OpenClaw 新格式：providers 是一个对象（record），provider ID 作为 key
        providers: {
          'jianzhi-proxy': {
            // 使用 api 而不是 type
            api: 'openai-completions',
            baseUrl: '${JIANZHI_MAIN_URL}/api/cw/llm/v1',
            apiKey: '${JIANZHI_CW_TOKEN}',
            // models 数组中每个模型需要 id 和 name 字段
            models: [
              {
                id: 'auto',
                name: 'Auto Model',
              },
            ],
          },
        },
      },
      // MCP 服务器配置：见智知识库（jianzhi-kb）通过通用 MCP 端点暴露
      // 使用 streamable-http 传输，OpenClaw 将 POST 到 /api/cw/mcp 并在请求体中指定 method
      mcp: {
        servers: {
          'jianzhi-kb': {
            transport: 'streamable-http',
            url: '${JIANZHI_MAIN_URL}/api/cw/mcp',
            headers: {
              Authorization: 'Bearer ${JIANZHI_CW_TOKEN}',
            },
          },
        },
      },
      // Unified tool authorization: tools.allow is the whitelist of ALL tools
      // (both OpenClaw builtins AND main platform custom tools).
      // Only tools in this list can be used. Admin controls the full list.
      tools: this.buildToolPolicy(cw),
      // 微信（WeChat）预装：启用腾讯外部通道插件 @tencent-weixin/openclaw-weixin。
      // 首启由 entrypoint 安装插件本体，用户经 `channels login --channel openclaw-weixin` 扫码绑定。
      plugins: {
        // 全量白名单:空 allow 会让所有已发现的外部插件(如企业微信残留 wecom-openclaw-plugin)
        // 自动加载。显式列出信任插件,既挡掉残留,又避免误关内置插件(allowlist 模式下内置也受限)。
        allow: PLUGIN_ALLOWLIST,
        entries: {
          'openclaw-weixin': { enabled: true },
          // 网页搜索 provider（无 key，内置）。供 web_search 工具使用。
          'duckduckgo': { enabled: true },
          // 见智审计/回传桥（运行时打包插件）。mainUrl 和 token 由 generateConfigJson 直接嵌入。
          'jianzhi-bridge': {
            enabled: true,
            config: {
              mainUrl: '${JIANZHI_MAIN_URL}',
              token: '${JIANZHI_CW_TOKEN}',
              coworkerId: cw.id,
              reportInterval: 30000,
              configCheckInterval: 60000,
            },
          },
        },
      },
      gateway: {
        mode: 'local',
        port: 18789,
        // 使用 lan 模式而不是 0.0.0.0
        bind: 'lan',
      },
      session: {
        dmScope: 'per-account-channel-peer',
        // 使用 reset.idleMinutes 而不是 idleResetMinutes
        reset: {
          mode: 'idle',
          idleMinutes: 60,
        },
      },
    };

    // Merge wechat config if present
    if (cw.wechatConfig && Object.keys(cw.wechatConfig).length > 0) {
      config.channels = {
        wechat: {
          enabled: true,
          ...cw.wechatConfig,
        },
      };
    }

    // Merge any custom config overrides（先剔除已知非法/废弃字段，避免覆盖新格式模板后被 OpenClaw strict schema 拒绝）
    if (cw.configOverrides && Object.keys(cw.configOverrides).length > 0) {
      this.deepMerge(config, this.sanitizeOverrides(cw.configOverrides));
    }

    return config;
  }

  /** openclaw.yaml — human-readable reference copy. */
  generateConfig(cw: CoWorker, mainUrl: string): string {
    return yaml.dump(this.buildConfigObject(cw, mainUrl), { indent: 2, lineWidth: 120, noRefs: true });
  }

  /**
   * openclaw.json — the config OpenClaw actually loads.
   * Now uses API key instead of environment variable placeholder for CoWorker authentication.
   * The API key is directly embedded in the config, no runtime replacement needed.
   */
  generateConfigJson(cw: CoWorker, mainUrl: string, apiKey?: string): string {
    const config = this.buildConfigObject(cw, mainUrl);

    // Embed API key directly in config (no ${JIANZHI_CW_TOKEN} placeholder)
    if (apiKey) {
      if (config.models?.providers?.['jianzhi-proxy']) {
        config.models.providers['jianzhi-proxy'].apiKey = apiKey;
      }
      if (config.mcp?.servers?.['jianzhi-kb']) {
        config.mcp.servers['jianzhi-kb'].headers = {
          ...config.mcp.servers['jianzhi-kb'].headers,
          Authorization: `Bearer ${apiKey}`,
        };
      }
      if (config.plugins?.entries?.['jianzhi-bridge']?.config) {
        config.plugins.entries['jianzhi-bridge'].config = {
          ...config.plugins.entries['jianzhi-bridge'].config,
          token: apiKey,
        };
      }
      if (config.agents?.defaults?.memorySearch?.remote) {
        config.agents.defaults.memorySearch.remote.apiKey = apiKey;
      }
    }

    return JSON.stringify(config, null, 2);
  }

  /**
   * Render the CoWorker persona as SOUL.md content.
   * OpenClaw reads SOUL.md from the workspace root (agents.defaults.workspace) on session init.
   * Using `writeFileIfMissing` (flag "wx"), openclaw never overwrites a pre-existing SOUL.md,
   * so writing it ourselves before gateway start is the version-stable persona channel.
   */
  generateSoulMarkdown(cw: CoWorker): string {
    const soul = (cw.soul || '').trim();
    if (!soul) return '';
    return soul;
  }

  /**
   * Generate docker-compose.yml for the CoWorker deployment package.
   */
  generateDockerCompose(cw: CoWorker): string {
    const compose = {
      version: '3.8',
      services: {
        openclaw: {
          // 版本一致性：不用 openclaw/openclaw:latest（会随 Docker Hub 漂移）。
          // 运行时 = 基础 node 镜像 + 挂载"从见智服务器下载的锁定版 OpenClaw 资产"（./openclaw-runtime）。
          image: 'node:22-slim',
          working_dir: '/app',
          container_name: `cw-${cw.id.slice(0, 8)}`,
          restart: 'unless-stopped',
          ports: ['18789:18789'],
          volumes: [
            // install 脚本从见智下载并解压的锁定版 OpenClaw 预构建资产。
            './openclaw-runtime:/app:ro',
            './config:/app/config:ro',
            './skills:/app/skills:ro',
            './scripts/entrypoint.sh:/app/entrypoint.sh:ro',
            // 见智桥插件（打包产物）→ OpenClaw 外部插件发现目录（state-dir/extensions）。
            './extensions/jianzhi-bridge:/home/node/.openclaw/extensions/jianzhi-bridge:ro',
            'claw-data:/home/node/.openclaw',
            // 用户指定的宿主目录 → 容器内 /workspace（OpenClaw 文件操作根）。
            // 用户把待处理的业务文件放到该目录，OpenClaw 即可访问；不在容器内，重建/升级不丢。
            '${OPENCLAW_WORKDIR:-./workspace}:/workspace',
          ],
          // 首启：注入 token、安装微信插件；随后启动 Gateway。
          entrypoint: ['bash', '/app/entrypoint.sh'],
          env_file: ['.env'],
          environment: [
            'NODE_ENV=production',
          ],
          security_opt: ['no-new-privileges:true'],
          cap_drop: ['NET_RAW', 'NET_ADMIN'],
        },
      },
      volumes: {
        'claw-data': {},
      },
    };
    return yaml.dump(compose, { indent: 2, lineWidth: 120, noRefs: true });
  }

  /**
   * Generate .env.template with placeholder variables.
   */
  generateEnvTemplate(cw: CoWorker, mainUrl: string): string {
    const lines = [
      '# 见智主台连接配置（必填）',
      `JIANZHI_MAIN_URL=${mainUrl}`,
      'JIANZHI_CW_TOKEN=<从主台获取的CoWorker令牌>',
      `JIANZHI_COWORKER_ID=${cw.id}`,
      '',
      '# OpenClaw 工作目录（必填）：指向你本机存放"待处理业务文件"的目录（绝对路径）。',
      '# OpenClaw 会把此目录挂到容器内 /workspace，可读写这里的文件；不在容器内，升级/重建不丢。',
      '# 例：OPENCLAW_WORKDIR=/Users/you/coworker-files  或  D:\\coworker-files',
      'OPENCLAW_WORKDIR=./workspace',
      '',
      '# 微信配置（如需启用微信频道）',
      '# WECHAT_ENABLED=true',
      '',
    ];
    return lines.join('\n');
  }

  /**
   * Generate a README with setup instructions.
   */
  generateReadme(cw: CoWorker): string {
    return `# ${cw.name} — CoWorker 部署包

## 快速启动

1. 编辑 \`.env\` 文件：
   \`\`\`
   JIANZHI_CW_TOKEN=<从主台获取>
   # 指向你本机存放"待处理业务文件"的目录（绝对路径），OpenClaw 将可读写此处文件
   OPENCLAW_WORKDIR=/绝对路径/coworker-files
   \`\`\`

2. 一键安装启动（会从见智服务器下载锁定版 OpenClaw 运行时并启动）：
   \`\`\`bash
   bash scripts/install.sh        # Windows: scripts\\install.ps1
   \`\`\`
   OpenClaw 运行时**从见智服务器获取**（非 GitHub/DockerHub），确保所有用户版本一致。

3. 查看日志：
   \`\`\`bash
   docker compose logs -f
   \`\`\`

## 无 Docker？用原生方式

\`\`\`bash
bash scripts/install-native.sh    # Windows: scripts\\install-native.ps1
\`\`\`
需 Node.js 22+；同样从见智下载锁定版运行时，直接以 Node 运行（无需容器），并引导扫码。

## 工作目录（重要）

\`OPENCLAW_WORKDIR\` 指向的宿主目录会挂载到容器内 \`/workspace\`，这是 OpenClaw 的文件操作根目录：
- 把需要 AI 员工处理的本地文件放到该目录，即可让它读取/处理；
- 该目录在容器外，升级或重建实例都不会丢失。

## 微信登录（扫码绑定）

容器启动后执行（终端会打印二维码，用手机微信扫描）：
\`\`\`bash
docker compose exec openclaw openclaw channels login --channel openclaw-weixin
\`\`\`
新联系人首次消息需审批：
\`\`\`bash
docker compose exec openclaw openclaw pairing list openclaw-weixin
docker compose exec openclaw openclaw pairing approve openclaw-weixin <CODE>
\`\`\`

## 停止

\`\`\`bash
docker compose down
\`\`\`

## 配置更新

管理员在主台修改配置后，CoWorker 会自动热刷新，无需重启。
`;
  }

  /**
   * Build the tool policy for OpenClaw config.
   * tools.allow = whitelist of ALL authorized tools (builtins + main platform custom).
   * If CoWorker has no tools specified, default to a safe preset.
   */
  private buildToolPolicy(cw: CoWorker): Record<string, any> {
    // jianzhi-kb__* 让 OpenClaw 工具策略放行 jianzhi-kb MCP 服务器的全部工具。
    // 不加此通配，OpenClaw 既不创建 MCP 运行时（优化门检测 __ 不通过），
    // 也无法匹配 jianzhi-kb__user_info 等带服务器前缀的工具名——
    // 即便主台 tools/list 正确返回了工具，模型也看不到。
    // 服务端 tools/list 已按 allowedTools 过滤，此处通配仅解除 OpenClaw 侧拦截。

    // OpenClaw 运行所必需的内置工具——无论管理员在 UI 勾选了什么，
    // 这些工具必须出现在 tools.allow 中，否则 agent 无法发消息/搜记忆/管会话。
    const REQUIRED_BUILTINS = [
      'read', 'write', 'edit', 'exec',
      'web_search', 'web_fetch',
      'memory_search', 'memory_get', 'message',
      'sessions_list', 'sessions_send',
    ];

    if (cw.tools.length === 0) {
      return {
        allow: [
          ...REQUIRED_BUILTINS, 'session_status',
          'jianzhi-kb__*',
          'jianzhi-host__*',
        ],
      };
    }

    // 合并去重：管理员选的工具 + 必需内置
    const merged = [...new Set([...REQUIRED_BUILTINS, ...cw.tools])];
    return { allow: [...merged, 'jianzhi-kb__*', 'jianzhi-host__*'] };
  }

  /**
   * Get the full tool catalog for admin authorization UI.
   * Merges OpenClaw builtins + main platform custom tools.
   */
  getToolCatalog(mainPlatformTools?: Array<{ name: string; description: string }>): Array<{
    section: string;
    tools: Array<{ id: string; label: string; description: string; source: 'openclaw' | 'main' }>;
  }> {
    const sections = new Map<string, Array<{ id: string; label: string; description: string; source: 'openclaw' | 'main' }>>();

    // OpenClaw builtins
    for (const t of OPENCLAW_BUILTIN_TOOLS) {
      if (!sections.has(t.section)) sections.set(t.section, []);
      sections.get(t.section)!.push({ id: t.id, label: t.label, description: t.description, source: 'openclaw' });
    }

    // Main platform custom tools (prefixed with jianzhi_)
    if (mainPlatformTools?.length) {
      const key = '主台工具';
      if (!sections.has(key)) sections.set(key, []);
      for (const t of mainPlatformTools) {
        sections.get(key)!.push({ id: `jianzhi_${t.name}`, label: t.name, description: t.description, source: 'main' });
      }
    }

    return Array.from(sections.entries()).map(([section, tools]) => ({ section, tools }));
  }

  /**
   * Full capability catalog for the admin authorization UI (three tabs: builtin / mcp / skills).
   * - builtin: OpenClaw builtins grouped by section.
   * - mcp: MCP servers, incl. 见智 主台自定义工具 (as the `jianzhi-kb` server).
   * - skills: skill definitions.
   * P1 note: `builtinTools` will come from `workspace/.openclaw/tools-manifest.json`
   * (extracted at OpenClaw download/upgrade); falls back to OPENCLAW_BUILTIN_TOOLS constant.
   */
  getCapabilityCatalog(
    mainPlatformTools: Array<{ name: string; description: string }>,
    skills: Array<{ name: string; description: string; metadata?: Record<string, string>; hasHandler?: boolean }>,
    builtinTools?: Array<{ id: string; label: string; section: string; description: string }>,
    hostTools?: Array<{ id: string; label: string; group: string }>,
    mcpRegistryServers?: Array<{ name: string; description: string; tools: Array<{ name: string; description: string }>; enabled: boolean; handlerCode?: string }>,
  ): {
    builtin: Array<{ section: string; tools: Array<{ id: string; label: string; description: string }> }>;
    mcp: Array<{ serverId: string; serverName: string; source: 'kb' | 'host' | 'registry'; description: string; tools: Array<{ name: string; description: string }> }>;
    skills: Array<{ name: string; description: string; metadata?: Record<string, string>; hasHandler?: boolean }>;
  } {
    const source = builtinTools?.length ? builtinTools : OPENCLAW_BUILTIN_TOOLS;
    const sections = new Map<string, Array<{ id: string; label: string; description: string }>>();
    for (const t of source) {
      if (!sections.has(t.section)) sections.set(t.section, []);
      sections.get(t.section)!.push({ id: t.id, label: t.label, description: t.description });
    }

    // 主台工具拆分：MCP 工具（连接大师，id='mcp'）进 mcp[jianzhi-host]，
    // 其余主台工具（数据库/Excel/PDF/邮件）进 builtin 的「主台工具」分区。
    // 不拆分会导致 MCP 服务 tab 混入全部主台工具，用户无法区分连接大师与普通工具。
    if (hostTools?.length) {
      const otherHostTools = hostTools.filter(t => t.id !== 'mcp');
      if (otherHostTools.length) {
        if (!sections.has('主台工具')) sections.set('主台工具', []);
        for (const t of otherHostTools) {
          sections.get('主台工具')!.push({ id: t.id, label: t.label, description: `${normalizeHostGroup(t.group)}/${t.label}` });
        }
      }
    }

    const builtin = Array.from(sections.entries()).map(([section, tools]) => ({ section, tools }));

    const mcp: Array<{ serverId: string; serverName: string; source: 'kb' | 'host' | 'registry'; description: string; tools: Array<{ name: string; description: string }> }> = [];

    if (hostTools?.length) {
      const mcpHostTools = hostTools.filter(t => t.id === 'mcp');
      if (mcpHostTools.length) {
        mcp.push({
          serverId: HOST_TOOL_SERVER_ID,
          serverName: '主台MCP连接',
          source: 'host',
          description: '见智连接大师创建的内部系统MCP连接',
          tools: mcpHostTools.map(t => ({ name: t.id, description: `${normalizeHostGroup(t.group)}/${t.label}` })),
        });
      }
    }

    // 连接面板中注册的 MCP 服务器（DB 连接、纯 MCP 连接）。
    // 每个已启用且有 handlerCode 的服务器作为独立条目，支持逐连接授权。
    if (mcpRegistryServers?.length) {
      for (const server of mcpRegistryServers) {
        if (!server.enabled || !server.tools?.length || !server.handlerCode) continue;
        mcp.push({
          serverId: `mcp-${server.name}`,
          serverName: server.name,
          source: 'registry',
          description: server.description || server.name,
          tools: server.tools.map(t => ({ name: t.name, description: t.description })),
        });
      }
    }

    if (mainPlatformTools.length) {
      mcp.push({
        serverId: KB_TOOL_SERVER_ID,
        serverName: '见智知识库',
        source: 'kb',
        description: '见智主台知识库与自定义工具',
        tools: mainPlatformTools.map(t => ({ name: t.name, description: t.description })),
      });
    }

    return { builtin, mcp, skills };
  }

  /**
   * 把管理界面写入的 capabilities 派生为扁平的 tools 白名单 + skills 镜像。
   * capabilities 是唯一事实来源；tools 是 buildToolPolicy 与 MCP 鉴权实际消费的派生产物。
   *
   * 三个 id 命名空间：
   * - builtin  → 裸 id（read / exec），OpenClaw 直接识别
   * - 主台工具 → jianzhi_<id>
   * - 知识库   → jianzhi_<name>
   */
  deriveTools(
    cap: {
      builtin?: string[];
      mcp?: Array<{ serverId: string; serverName?: string; tools?: string[] }>;
      skills?: string[];
    } | null | undefined,
    registry: { builtinIds: Set<string>; hostIds: Set<string>; kbNames: Set<string>; skillNames?: Set<string>; mcpServerTools?: Map<string, Set<string>> },
  ): { tools: string[]; skills: string[]; rejected: string[] } {
    const tools = new Set<string>();
    const skills = new Set<string>();
    const rejected: string[] = [];

    for (const id of cap?.builtin ?? []) {
      if (registry.builtinIds.has(id)) tools.add(id);
      else if (registry.hostIds.has(id)) tools.add(`${JIANZHI_TOOL_PREFIX}${id}`);
      else rejected.push(id);
    }

    for (const entry of cap?.mcp ?? []) {
      // MCP 注册表服务器（连接面板中的 DB 连接、纯 MCP 连接）。
      // 工具名格式为 mcp_{serverName}_{toolName}，与 McpAdapterService.createTools 一致。
      if (entry.serverId.startsWith('mcp-')) {
        const serverName = entry.serverId.slice(4);
        const serverToolNames = registry.mcpServerTools?.get(serverName);
        if (!serverToolNames) {
          for (const name of entry.tools ?? []) rejected.push(`${entry.serverId}/${name}`);
          if (!entry.tools?.length) rejected.push(`${entry.serverId}/*`);
          continue;
        }
        const selected = entry.tools?.length ? entry.tools : Array.from(serverToolNames);
        for (const toolName of selected) {
          if (serverToolNames.has(toolName)) {
            tools.add(`mcp_${serverName}_${toolName}`);
          } else {
            rejected.push(`${entry.serverId}/${toolName}`);
          }
        }
        continue;
      }

      const known =
        entry.serverId === HOST_TOOL_SERVER_ID ? registry.hostIds :
        entry.serverId === KB_TOOL_SERVER_ID ? registry.kbNames :
        null;

      if (!known) {
        for (const name of entry.tools ?? []) rejected.push(`${entry.serverId}/${name}`);
        if (!entry.tools?.length) rejected.push(`${entry.serverId}/*`);
        continue;
      }

      // 空 tools 数组语义为「该 server 全部工具」（UI 按此渲染），派生时显式展开，不存通配符。
      const selected = entry.tools?.length ? entry.tools : Array.from(known);
      for (const name of selected) {
        if (known.has(name)) tools.add(`${JIANZHI_TOOL_PREFIX}${name}`);
        else rejected.push(`${entry.serverId}/${name}`);
      }
    }

    for (const name of cap?.skills ?? []) {
      if (!registry.skillNames || registry.skillNames.has(name)) skills.add(name);
      else rejected.push(`skill/${name}`);
    }

    this.warnIdCollisions(registry);

    return {
      tools: Array.from(tools).sort(),
      skills: Array.from(skills).sort(),
      rejected,
    };
  }

  /**
   * 命名空间碰撞会让授权静默错位：主台/知识库同名会塌缩成同一个 jianzhi_x
   * （tools/call 主台优先），主台 id 与内置 id 同名会让裸 id 与前缀 id 指向不同实现。
   */
  private warnIdCollisions(registry: { builtinIds: Set<string>; hostIds: Set<string>; kbNames: Set<string> }): void {
    const hostVsKb = Array.from(registry.hostIds).filter(id => registry.kbNames.has(id));
    if (hostVsKb.length) {
      this.logger.warn(`工具 id 碰撞（主台 ↔ 知识库，主台优先）: ${hostVsKb.join(', ')}`);
    }
    const hostVsBuiltin = Array.from(registry.hostIds).filter(id => registry.builtinIds.has(id));
    if (hostVsBuiltin.length) {
      this.logger.warn(`工具 id 碰撞（主台 ↔ OpenClaw 内置）: ${hostVsBuiltin.join(', ')}`);
    }
  }

  /**
   * 存量数据兼容：只有扁平 tools、没有 capabilities 的老行，按当前目录反推 capabilities
   * 供编辑器预勾选。仅用于读侧，不落库（SQL 迁移无法感知主台目录，故不做迁移）。
   */
  synthesizeCapabilities(
    tools: string[],
    skills: string[],
    registry: { builtinIds: Set<string>; hostIds: Set<string>; mcpServerTools?: Map<string, Set<string>> },
  ): { builtin: string[]; mcp: Array<{ serverId: string; serverName: string; tools: string[] }>; skills: string[] } {
    const builtin: string[] = [];
    const hostNames: string[] = [];
    const kbNames: string[] = [];
    const registryServerTools = new Map<string, string[]>(); // serverName → toolNames

    // 按 serverName 长度降序，优先匹配最长前缀（避免 erp 与 erp_v2 歧义）。
    const sortedServers = registry.mcpServerTools
      ? Array.from(registry.mcpServerTools.entries()).sort((a, b) => b[0].length - a[0].length)
      : [];

    for (const t of tools) {
      if (t.startsWith('mcp_') && t !== 'mcp') {
        // MCP 注册表工具：mcp_{server}_{tool} → 反推到 mcp-{server} 条目
        let matched = false;
        for (const [serverName, toolNames] of sortedServers) {
          const prefix = `mcp_${serverName}_`;
          if (t.startsWith(prefix)) {
            const toolName = t.slice(prefix.length);
            if (toolNames.has(toolName)) {
              if (!registryServerTools.has(serverName)) registryServerTools.set(serverName, []);
              registryServerTools.get(serverName)!.push(toolName);
              matched = true;
              break;
            }
          }
        }
        if (matched) continue;
        // 未匹配的 mcp_* 工具（可能是已删除的连接），跳过
        continue;
      }

      if (t.startsWith(JIANZHI_TOOL_PREFIX)) {
        const name = t.slice(JIANZHI_TOOL_PREFIX.length);
        if (registry.hostIds.has(name)) {
          hostNames.push(name);
        } else {
          kbNames.push(name);
        }
      } else if (registry.builtinIds.has(t)) {
        builtin.push(t);
      }
    }

    const mcp: Array<{ serverId: string; serverName: string; tools: string[] }> = [];
    if (hostNames.length) mcp.push({ serverId: HOST_TOOL_SERVER_ID, serverName: '主台MCP连接', tools: hostNames });
    for (const [serverName, toolNames] of registryServerTools) {
      mcp.push({ serverId: `mcp-${serverName}`, serverName, tools: toolNames });
    }
    if (kbNames.length) mcp.push({ serverId: KB_TOOL_SERVER_ID, serverName: '见智知识库', tools: kbNames });

    return { builtin, mcp, skills: skills ?? [] };
  }

  private deepMerge(target: any, source: any): void {
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        if (!target[key]) target[key] = {};
        this.deepMerge(target[key], source[key]);
      } else {
        target[key] = source[key];
      }
    }
  }

  /**
   * 剔除 configOverrides 中会被 OpenClaw 2026.5.x strict schema 拒绝的字段,并告警。
   * 在 deepMerge 之前调用:保留 buildConfigObject 模板自带的正确字段,只忽略 overrides 的非法部分,
   * 从而既"放行"又不把脏配置下发到客户端。不修改入参(深拷贝)。
   */
  private sanitizeOverrides(overrides: Record<string, any>): Record<string, any> {
    const cleaned: Record<string, any> = JSON.parse(JSON.stringify(overrides));
    const dropped: string[] = [];
    const drop = (path: string, parent: any, key: string, hint?: string) => {
      if (parent && typeof parent === 'object' && key in parent) {
        dropped.push(hint ? `${path} (${hint})` : path);
        delete parent[key];
      }
    };

    // 顶层废弃键
    for (const k of ['configLock', 'jianzhi']) drop(`(top-level)${k}`, cleaned, k);

    // session.idleResetMinutes → 应为 session.reset.idleMinutes
    drop('session.idleResetMinutes', cleaned?.session, 'idleResetMinutes', 'use session.reset.idleMinutes');

    // skills.paths
    drop('skills.paths', cleaned?.skills, 'paths');

    // agents.defaults 是 strict schema；人格指令必须通过 workspace/SOUL.md 下发。
    drop('agents.defaults.systemPrompt', cleaned?.agents?.defaults, 'systemPrompt', 'use SOUL.md');
    drop('agents.defaults.systemPromptOverride', cleaned?.agents?.defaults, 'systemPromptOverride', 'use SOUL.md');

    // models.providers 必须是 record(对象),不能是数组
    if (cleaned?.models?.providers !== undefined &&
        (typeof cleaned.models.providers !== 'object' || Array.isArray(cleaned.models.providers))) {
      drop('models.providers', cleaned.models, 'providers', 'must be record/object, not array');
    }

    // gateway.bind 枚举
    const BIND_OK = ['auto', 'lan', 'loopback', 'custom', 'tailnet'];
    if (cleaned?.gateway?.bind !== undefined && !BIND_OK.includes(cleaned.gateway.bind)) {
      drop('gateway.bind', cleaned.gateway, 'bind', `allowed: ${BIND_OK.join('/')}`);
    }

    // mcp.servers[*].transport 枚举
    const TP_OK = ['sse', 'streamable-http'];
    if (cleaned?.mcp?.servers && typeof cleaned.mcp.servers === 'object') {
      for (const [sid, srv] of Object.entries(cleaned.mcp.servers)) {
        const tp = (srv as any)?.transport;
        if (tp !== undefined && !TP_OK.includes(tp)) {
          drop(`mcp.servers.${sid}.transport`, srv as any, 'transport', `allowed: ${TP_OK.join('/')}`);
        }
      }
    }

    if (dropped.length) {
      this.logger.warn(`configOverrides 剔除非法/废弃字段: ${dropped.join('; ')}`);
    }
    return cleaned;
  }
}
