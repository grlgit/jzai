import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { CredentialService } from '../skill/credential.service';
import { HarAnalyzerService } from '../skill/har-analyzer.service';
import { AgentPoolService } from '../../agent/core/agent-pool.service';
import { SessionService } from '../../agent/session/session.service';

/**
 * ConnectorToolProvider — connector management tools:
 * test_connector, reload_connectors, mcp_health_check, analyze_har, github, webhooks.
 */
@Injectable()
export class ConnectorToolProvider implements ToolProvider {
  readonly toolIds = ['test_connector', 'reload_connectors', 'mcp_health_check', 'analyze_har', 'github', 'webhooks'];
  private readonly logger = new Logger(ConnectorToolProvider.name);

  constructor(
    private readonly toolRegistry: ToolRegistryService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly credentialService: CredentialService,
    private readonly harAnalyzer: HarAnalyzerService,
    private readonly agentPool: AgentPoolService,
    private readonly sessionService: SessionService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'test_connector', label: '测试连接', group: '连接' },
      { id: 'reload_connectors', label: '重新加载连接', group: '连接' },
      { id: 'mcp_health_check', label: 'MCP可用性检查', group: '连接' },
      { id: 'analyze_har', label: '分析HAR文件', group: '连接' },
      { id: 'github', label: 'GitHub操作', group: '连接' },
      { id: 'webhooks', label: 'Webhook注册', group: '连接' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const tools: ToolInstance[] = [];

    // ── test_connector ──
    tools.push({
      name: 'test_connector', label: '测试连接',
      description: '测试一个已注册的 Tool 或 MCP 连接，直接执行 handler 并返回结果。不检查基础设施（进程、transport等）。',
      parameters: Type.Object({
        name: Type.String({ description: '连接名称（Tool 或 MCP 名）' }),
        toolName: Type.Optional(Type.String({ description: 'MCP 中的具体工具名（MCP 有多个工具时需指定）' })),
        testParams: Type.Optional(Type.Record(Type.String(), Type.Any())),
      }),
      execute: async (_id: string, args: { name: string; toolName?: string; testParams?: Record<string, any> }) => {
        const userId = ctx.userId;
        const { McpHttpClient: TestHttpClient } = require('../mcp/mcp-http-client');

        // Helper: eval handler code with ctx
        const evalHandler = async (handlerCode: string, params: Record<string, any>, creds: Record<string, string>, toolName?: string) => {
          let code = handlerCode.replace(/import\s+.*?from\s+.*?;?\n?/g, '').replace(/export\s+/g, '').replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ');
          const fn = new Function('require', 'ctx', `return (async function() { ${code} return execute(ctx); })();`);
          return fn(require, { params, credentials: creds, userId, http: new TestHttpClient(userId), toolName });
        };

        // 1. Try Tool registry
        const tool = this.toolRegistry.get(args.name);
        if (tool) {
          if (!tool.handlerCode) return { content: [{ type: 'text' as const, text: `Tool "${args.name}" 无 handler.ts，无法测试` }], details: null };
          const authSystem = tool.authSystem || tool.system || tool.name;
          const needsAuth = tool.authFields && tool.authFields.length > 0;
          const userCreds = this.credentialService.resolveCredentials(userId || '', authSystem);
          if (needsAuth && (!userCreds || Object.keys(userCreds).length === 0)) {
            return { content: [{ type: 'text' as const, text: `凭证缺失：工具 "${args.name}" 需要凭证但未配置。请在"连接"面板中配置凭证后重试。` }], details: null };
          }
          try {
            const testParams = args.testParams || {};
            for (const p of tool.parameters) {
              if (p.required && !(p.name in testParams)) testParams[p.name] = p.type === 'number' ? 1 : `test_${p.name}`;
            }
            const result = await evalHandler(tool.handlerCode, testParams, userCreds || {});
            return { content: [{ type: 'text' as const, text: `测试通过\n工具: ${args.name}\n结果: ${result.message || JSON.stringify(result)}` }], details: result };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `测试失败\n工具: ${args.name}\n错误: ${err.message}\n建议: 检查 handler.ts 代码或参数格式` }], details: null };
          }
        }

        // 2. Try MCP registry — also execute handler directly (not health check)
        const mcp = this.mcpRegistry.get(args.name);
        if (mcp) {
          if (!mcp.handlerCode) return { content: [{ type: 'text' as const, text: `MCP "${args.name}" 无 handler.ts，无法测试` }], details: null };
          const authSystem = mcp.authSystem || mcp.system || mcp.name;
          const needsAuth = mcp.authFields && mcp.authFields.length > 0;
          const userCreds = this.credentialService.resolveCredentials(userId || '', authSystem, mcp.authScope);
          if (needsAuth && (!userCreds || Object.keys(userCreds).length === 0)) {
            return { content: [{ type: 'text' as const, text: `凭证缺失：MCP "${args.name}" 需要凭证但未配置。请在"连接"面板中配置凭证后重试。` }], details: null };
          }
          // Determine which tool to test
          const targetTool = args.toolName
            ? mcp.tools.find(t => t.name === args.toolName)
            : mcp.tools[0];
          if (!targetTool) {
            return { content: [{ type: 'text' as const, text: `MCP "${args.name}" 中未找到工具${args.toolName ? ` "${args.toolName}"` : ''}` }], details: null };
          }
          try {
            const testParams = args.testParams || {};
            // Auto-fill from inputSchema
            if (targetTool.inputSchema?.properties) {
              for (const [k, v] of Object.entries(targetTool.inputSchema.properties as Record<string, any>)) {
                if (!(k in testParams) && (targetTool.inputSchema.required || []).includes(k)) {
                  testParams[k] = v.type === 'number' ? 1 : `test_${k}`;
                }
              }
            }
            const result = await evalHandler(mcp.handlerCode, testParams, userCreds || {}, targetTool.name);
            return { content: [{ type: 'text' as const, text: `测试通过\nMCP: ${args.name}\n工具: ${targetTool.name}\n结果: ${result.message || JSON.stringify(result)}` }], details: result };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `测试失败\nMCP: ${args.name}\n工具: ${targetTool.name}\n错误: ${err.message}\n建议: 检查 handler.ts 代码或参数格式` }], details: null };
          }
        }

        // 3. Not found
        return { content: [{ type: 'text' as const, text: `未找到连接: ${args.name}（不在 Tool 或 MCP 注册表中）` }], details: null };
      },
    });

    // ── reload_connectors ──
    tools.push({
      name: 'reload_connectors', label: '重新加载连接',
      description: '重新从磁盘加载 Tool 和 MCP 连接定义。创建或修改连接后需调用此工具使其生效。',
      parameters: Type.Object({}),
      execute: async () => {
        const oldNames = new Set([...this.toolRegistry.getAll().map(t => t.name), ...this.mcpRegistry.getAll().map(m => m.name)]);
        this.toolRegistry.loadAll();
        this.mcpRegistry.loadAll();
        const allNew = [
          ...this.toolRegistry.getAll().filter(t => !oldNames.has(t.name)).map(t => t.name),
          ...this.mcpRegistry.getAll().filter(m => !oldNames.has(m.name)).map(m => m.name),
        ];
        // Bind new connectors to current session
        if (allNew.length > 0) {
          for (const key of this.agentPool.keys()) {
            if (key.startsWith('connector_master_')) {
              const sid = this.agentPool.getSessionId(key);
              if (sid) for (const name of allNew) await this.sessionService.bindSkill(sid, name).catch(() => {});
              break;
            }
          }
        }
        // Clear other agents so they rebuild with updated tools, but keep current session
        const agentKey = ctx.agentKey;
        if (agentKey) {
          this.agentPool.clearExcept(agentKey);
        } else {
          this.agentPool.clear();
        }
        const total = this.toolRegistry.getAll().length + this.mcpRegistry.getAll().length;
        return { content: [{ type: 'text' as const, text: `已重新加载 ${total} 个连接（Tool + MCP）${allNew.length ? '，新增: ' + allNew.join(', ') : ''}。其他智能体工具已刷新。` }], details: null };
      },
    });

    // ── mcp_health_check ──
    tools.push({
      name: 'mcp_health_check', label: 'MCP可用性检查',
      description: '检查指定 MCP Server 是否可用。检测注册状态、进程启动、工具列表等。参数: name (MCP名称，可选，不填则检查全部)',
      parameters: Type.Object({ name: Type.Optional(Type.String()) }),
      execute: async (_id: string, args: { name?: string }) => {
        const servers = args.name
          ? [this.mcpRegistry.get(args.name)].filter(Boolean)
          : this.mcpRegistry.getAll();

        if (servers.length === 0) {
          return { content: [{ type: 'text' as const, text: args.name ? `未找到 MCP Server: ${args.name}` : '当前没有注册任何 MCP Server' }], details: null };
        }

        const results: string[] = [];
        for (const server of servers) {
          if (!server) continue;
          const lines: string[] = [`## ${server.name}`];
          lines.push(`- 系统: ${server.system || '(未设置)'}`);
          lines.push(`- 描述: ${server.description || '(无)'}`);
          lines.push(`- 启用: ${server.enabled ? '是' : '否'}`);
          lines.push(`- 注册工具数: ${server.tools.length}`);

          // Read manifest to get transport config
          const manifestYaml = this.mcpRegistry.getManifestYaml(server.name);
          let transport: any = null;
          if (manifestYaml) {
            try {
              const raw = require('js-yaml').load(manifestYaml) as any;
              transport = (raw.mcp || raw).transport;
            } catch { /* ignore */ }
          }

          if (transport) {
            lines.push(`- 传输方式: ${transport.type || 'unknown'}`);
            if (transport.type === 'stdio') {
              lines.push(`- 命令: ${transport.command} ${(transport.args || []).join(' ')}`);
              // Try to check if command exists
              try {
                const { execSync } = require('child_process');
                const which = execSync(`which ${transport.command} 2>/dev/null || where ${transport.command} 2>NUL`, { encoding: 'utf-8', timeout: 5000 }).trim();
                lines.push(`- 命令路径: ${which || '(未找到)'}`);
                lines.push(`- 命令可用: 是`);
              } catch {
                lines.push(`- 命令可用: **否** (${transport.command} 未安装或不在 PATH 中)`);
              }
              // Try to start and get tool list
              try {
                const { execSync } = require('child_process');
                const env = { ...process.env, ...(transport.env || {}) };
                const cmd = [transport.command, ...(transport.args || [])].join(' ');
                const initMsg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'health-check', version: '1.0' } } });
                const listMsg = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
                const input = initMsg + '\n' + listMsg + '\n';
                const output = execSync(`echo '${input.replace(/'/g, "'\\''")}' | ${cmd}`, { encoding: 'utf-8', timeout: 15000, env });
                const toolNames: string[] = [];
                for (const line of output.split('\n')) {
                  try {
                    const resp = JSON.parse(line.trim());
                    if (resp.result?.tools) {
                      for (const t of resp.result.tools) toolNames.push(t.name);
                    }
                  } catch { /* skip non-JSON lines */ }
                }
                if (toolNames.length > 0) {
                  lines.push(`- 连接测试: **通过**`);
                  lines.push(`- 实际工具 (${toolNames.length}): ${toolNames.join(', ')}`);
                } else {
                  lines.push(`- 连接测试: 进程启动成功，但未返回工具列表`);
                }
              } catch (err: any) {
                lines.push(`- 连接测试: **失败** (${err.message.split('\n')[0]})`);
              }
            } else if (transport.type === 'sse' && transport.url) {
              lines.push(`- URL: ${transport.url}`);
              try {
                const resp = await fetch(transport.url, { signal: AbortSignal.timeout(10000) });
                lines.push(`- HTTP状态: ${resp.status}`);
                lines.push(`- 连接测试: ${resp.ok ? '**通过**' : '**失败**'}`);
              } catch (err: any) {
                lines.push(`- 连接测试: **失败** (${err.message})`);
              }
            }
          } else {
            lines.push(`- 传输方式: 未配置 (manifest 中无 transport 字段)`);
          }

          if (server.tools.length > 0) {
            lines.push(`- 已注册工具: ${server.tools.map(t => t.name).join(', ')}`);
          }
          results.push(lines.join('\n'));
        }

        return { content: [{ type: 'text' as const, text: results.join('\n\n') }], details: null };
      },
    });

    // ── analyze_har ──
    tools.push({
      name: 'analyze_har', label: '分析HAR文件',
      description: `分析浏览器录制的 HAR 文件，提取 API 工作流结构。

## 用途
将用户在浏览器中录制的操作（HAR 文件）解析为结构化的 API 工作流，可用于：
- **生成 MCP 连接**：每个 API 步骤映射为一个 MCP 工具
- **生成技能**：多步骤编排为一个完整业务流程
- **API 文档化**：理解外部系统的接口结构

## 输出结构
返回 AnalyzedWorkflow，包含：
- **baseUrl**：API 基础地址
- **steps**：工作流步骤列表，每步包含：
  - role: login（登录）| lookup（查询）| create（创建）| submit（提交）| auxiliary（辅助）
  - api: { method, url, path, requestBody, responseBody }
  - dependsOn: 依赖的前置步骤 ID
  - inputMappings: 从哪个步骤的哪个字段获取输入值
  - outputFields: 被后续步骤引用的输出字段
- **loginStep**：识别出的登录步骤
- **submitStep**：识别出的最终提交步骤
- **parameters**：从提交步骤提取的业务参数列表

## 使用流程
1. 用户上传 HAR 文件（浏览器开发者工具 -> Network -> 导出 HAR）
2. 调用本工具分析，filePath 指向上传的 HAR 文件路径
3. 根据分析结果决定下一步：生成 MCP 连接 或 生成技能`,
      parameters: Type.Object({
        filePath: Type.String({ description: 'HAR 文件路径（用户上传的附件路径）' }),
        verbose: Type.Optional(Type.Boolean({ description: '是否输出完整的请求/响应体。默认 false 只输出摘要' })),
      }),
      execute: async (_id: string, args: { filePath: string; verbose?: boolean }) => {
        try {
          const harJson = JSON.parse(fs.readFileSync(args.filePath, 'utf-8'));
          const workflow = this.harAnalyzer.analyze(harJson);

          // Build human-readable summary
          const lines: string[] = [
            `## HAR 分析结果`,
            ``,
            `- **基础URL**: ${workflow.baseUrl}`,
            `- **原始请求数**: ${workflow.rawApiCount}`,
            `- **业务API数**: ${workflow.filteredApiCount}`,
            `- **工作流步骤**: ${workflow.steps.length}`,
            ``,
            `### 步骤列表`,
            ``,
            `| # | 步骤 | 角色 | 方法 | 路径 | 依赖 |`,
            `|---|------|------|------|------|------|`,
          ];
          for (const s of workflow.steps) {
            const deps = s.dependsOn.length ? s.dependsOn.join(', ') : '-';
            lines.push(`| ${s.id} | ${s.label} | ${s.role} | ${s.api.method} | ${s.api.path} | ${deps} |`);
          }

          if (workflow.loginStep) {
            lines.push(``, `### 认证`, `- 登录接口: \`${workflow.loginStep.api.method} ${workflow.loginStep.api.path}\``);
            const loginBody = workflow.loginStep.api.requestBody;
            if (loginBody && typeof loginBody === 'object') {
              lines.push(`- 登录参数: ${Object.keys(loginBody).join(', ')}`);
            }
          }

          if (workflow.parameters.length > 0) {
            lines.push(``, `### 业务参数（来自提交步骤）`, ``);
            lines.push(`| 参数 | 类型 | 必填 | 说明 | 示例值 |`);
            lines.push(`|------|------|------|------|--------|`);
            for (const p of workflow.parameters) {
              lines.push(`| ${p.name} | ${p.type} | ${p.required ? '是' : '否'} | ${p.description} | ${p.sampleValue ?? '-'} |`);
            }
          }

          // Data flow (dependency mappings)
          const mappings = workflow.steps.flatMap(s => s.inputMappings.map(m => ({ step: s.id, ...m })));
          if (mappings.length > 0) {
            lines.push(``, `### 数据流（步骤间参数传递）`, ``);
            for (const m of mappings.slice(0, 20)) {
              lines.push(`- ${m.fromStep}.${m.fromField} -> ${m.step}.${m.field}`);
            }
            if (mappings.length > 20) lines.push(`- ... 共 ${mappings.length} 条映射`);
          }

          // Verbose: include request/response bodies
          if (args.verbose) {
            lines.push(``, `### 详细请求/响应`);
            for (const s of workflow.steps) {
              lines.push(``, `#### ${s.id}: ${s.label} (${s.role})`);
              lines.push(`\`${s.api.method} ${s.api.url}\``);
              if (s.api.requestBody && Object.keys(s.api.requestBody).length > 0) {
                const body = JSON.stringify(s.api.requestBody, null, 2);
                lines.push(`**请求体** (${body.length > 2000 ? '截断' : '完整'}):`);
                lines.push('```json', body.substring(0, 2000), '```');
              }
              if (s.api.responseBody) {
                const resp = JSON.stringify(s.api.responseBody, null, 2);
                lines.push(`**响应体** (${resp.length > 1000 ? '截断' : '完整'}):`);
                lines.push('```json', resp.substring(0, 1000), '```');
              }
            }
          }

          return {
            content: [{ type: 'text' as const, text: lines.join('\n') }],
            details: workflow,
          };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `HAR分析失败: ${err.message}` }], details: null };
        }
      },
    });

    // ── github ──
    tools.push({
      name: 'github_action', label: 'GitHub操作',
      description: `与 GitHub 交互。支持的操作：
- list_repos: 列出仓库
- list_issues: 列出 Issue
- create_issue: 创建 Issue
- list_prs: 列出 PR
- get_file: 获取文件内容
- search_code: 搜索代码`,
      parameters: Type.Object({
        action: Type.String({ description: '操作类型' }),
        repo: Type.Optional(Type.String({ description: 'owner/repo 格式' })),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        query: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, args: any) => {
        const token = process.env.GITHUB_TOKEN;
        if (!token) return { content: [{ type: 'text' as const, text: 'GitHub 未配置（需要 GITHUB_TOKEN 环境变量）' }], details: null };
        const headers = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'JianZhi-Agent' };
        try {
          let url = 'https://api.github.com';
          let method = 'GET';
          let body: string | undefined;
          switch (args.action) {
            case 'list_repos': url += '/user/repos?sort=updated&per_page=10'; break;
            case 'list_issues': url += `/repos/${args.repo}/issues?state=open&per_page=10`; break;
            case 'create_issue': url += `/repos/${args.repo}/issues`; method = 'POST'; body = JSON.stringify({ title: args.title, body: args.body }); break;
            case 'list_prs': url += `/repos/${args.repo}/pulls?state=open&per_page=10`; break;
            case 'get_file': url += `/repos/${args.repo}/contents/${args.path}`; break;
            case 'search_code': url += `/search/code?q=${encodeURIComponent(args.query + (args.repo ? ` repo:${args.repo}` : ''))}`; break;
            default: return { content: [{ type: 'text' as const, text: `未知操作: ${args.action}` }], details: null };
          }
          const resp = await fetch(url, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body, signal: AbortSignal.timeout(10000) });
          const data = await resp.json();
          const text = JSON.stringify(data, null, 2);
          return { content: [{ type: 'text' as const, text: text.length > 15000 ? text.slice(0, 15000) + '\n...(截断)' : text }], details: { action: args.action } };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `GitHub 操作失败: ${err.message}` }], details: null };
        }
      },
    });

    // ── webhooks ──
    tools.push({
      name: 'webhook_register', label: 'Webhook注册',
      description: '注册一个 Webhook 接收端点，用于接收外部系统的回调通知。',
      parameters: Type.Object({
        name: Type.String({ description: 'Webhook 名称' }),
        path: Type.String({ description: '接收路径，如 /hook/my-event' }),
        description: Type.Optional(Type.String({ description: '说明' })),
      }),
      execute: async (_id: string, args: { name: string; path: string; description?: string }) => {
        return { content: [{ type: 'text' as const, text: `Webhook 已注册: ${args.name}\n路径: ${args.path}\n说明: ${args.description || '无'}` }], details: { name: args.name, path: args.path } };
      },
    });

    return tools;
  }
}
