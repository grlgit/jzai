import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ToolProvider, ToolCatalogEntry, ToolContext, ToolInstance } from '../../agent/tool-bridge/tool-provider.interface';
import { AutomationService } from '../automation/automation.service';
import { ContextManagerService } from '../../agent/context/context-manager.service';
import { AgentRegistryService } from '../../agent/core/agent-registry.service';

/** Binary extensions that read tool should reject */
const BINARY_EXTS = new Set([
  '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico',
  '.zip', '.gz', '.tar', '.rar', '.7z', '.exe', '.dll', '.so', '.dylib',
  '.bin', '.dat', '.db', '.sqlite', '.woff', '.woff2', '.ttf', '.otf',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.xlsx', '.xls', '.docx',
  '.doc', '.pptx', '.ppt',
]);

/** Script extensions that write tool redirects to user workspace */
const SCRIPT_EXTS = new Set(['.py', '.sh', '.js', '.ts', '.rb', '.pl', '.bat', '.ps1']);

/**
 * SystemToolProvider — built-in system tools (coding, UI, code execution, etc.).
 * Coding tools (read/edit/write/bash/grep/find/ls) are wrappers around piAi's
 * built-in coding tools provided via ctx.piAi.
 */
@Injectable()
export class SystemToolProvider implements ToolProvider {
  private readonly logger = new Logger(SystemToolProvider.name);

  readonly toolIds = [
    'read', 'edit', 'write', 'bash', 'grep', 'find', 'ls',
    'ui_control', 'code_execution', 'coding_agent', 'attachment',
  ];

  constructor(
    private readonly automationService: AutomationService,
    private readonly contextManager: ContextManagerService,
    private readonly registry: AgentRegistryService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'read',           label: '读取文件',       group: '内置' },
      { id: 'edit',           label: '编辑文件',       group: '内置' },
      { id: 'write',          label: '写入文件',       group: '内置' },
      { id: 'bash',           label: '执行命令',       group: '内置' },
      { id: 'grep',           label: '搜索内容',       group: '内置' },
      { id: 'find',           label: '查找文件',       group: '内置' },
      { id: 'ls',             label: '列出目录',       group: '内置' },
      { id: 'ui_control',     label: '界面控制',       group: '内置' },
      { id: 'code_execution', label: '沙箱代码执行',   group: '内置' },
      { id: 'coding_agent',   label: '自主编程',       group: '内置' },
      { id: 'attachment',     label: '附件解析',       group: '内置' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const tools: ToolInstance[] = [];

    // ── Coding tools (read/edit/write/bash/grep/find/ls) ──────────
    // These come from piAi's built-in coding tools via ctx.piAi
    const codingTools: any[] = ctx.piAi?.codingTools ?? ctx.piAi?.getDefaultTools?.() ?? [];

    for (const name of ['read', 'edit', 'write', 'bash', 'grep', 'find', 'ls'] as const) {
      const tool = codingTools.find((t: any) => t.name === name);
      if (!tool) continue;

      if (name === 'read') {
        // Protect read from binary files
        tools.push({
          ...tool,
          execute: async (toolCallId: string, args: any, signal?: any, onUpdate?: any) => {
            const filePath = args.path || args.filePath || args.file_path || '';
            const ext = path.extname(filePath).toLowerCase();
            if (BINARY_EXTS.has(ext)) {
              return {
                content: [{ type: 'text' as const, text: `无法读取二进制文件 "${path.basename(filePath)}"。请改用 document_extract 工具来提取 PDF/图片内容。` }],
              };
            }
            return tool.execute(toolCallId, args, signal, onUpdate);
          },
        });
      } else if (name === 'write' && ctx.userId) {
        // Redirect script files to user workspace dir
        const userScriptsDir = path.join(process.cwd(), 'workspace', ctx.userId, 'scripts');
        tools.push({
          ...tool,
          execute: async (toolCallId: string, args: any, signal?: any, onUpdate?: any) => {
            const filePath = args.filePath || args.file_path || '';
            const ext = path.extname(filePath).toLowerCase();
            if (SCRIPT_EXTS.has(ext) && !path.isAbsolute(filePath)) {
              if (!fs.existsSync(userScriptsDir)) fs.mkdirSync(userScriptsDir, { recursive: true });
              const redirected = path.join(userScriptsDir, path.basename(filePath));
              args = { ...args, filePath: redirected, file_path: redirected };
            }
            return tool.execute(toolCallId, args, signal, onUpdate);
          },
        });
      } else {
        tools.push(tool);
      }
    }

    // ── ui_control ────────────────────────────────────────────────
    const Type = ctx.piAi?.Type;
    if (Type) {
      tools.push(this.buildUiControlTool(Type, ctx));
      tools.push(this.buildCodeExecutionTool(Type));
      tools.push(this.buildCodingAgentTool(Type));
    }

    // ── attachment ─────────────────────────────────────────────────
    tools.push(this.buildAttachmentTool(ctx));

    return tools;
  }

  // ─── private builders ───────────────────────────────────────────

  private buildAttachmentTool(ctx: ToolContext): ToolInstance {
    const parseTool = this.automationService.getParseAttachmentTool();
    const Type = ctx.piAi?.Type;
    return {
      name: parseTool.name,
      label: parseTool.description.split('\n')[0],
      description: parseTool.description,
      parameters: Type
        ? Type.Object({
            filePath: Type.String(),
            hint: Type.Optional(Type.String()),
            templateKey: Type.Optional(Type.String()),
          })
        : {},
      execute: async (toolCallId: string, args: any) => {
        const result = await parseTool.execute(toolCallId, args);
        return {
          content: result.content.map((c: any) => ({ type: 'text' as const, text: c.text })),
          details: { parsedData: (result as any).parsedData, rawFields: (result as any).rawFields },
        };
      },
    };
  }

  private buildUiControlTool(Type: any, ctx: ToolContext): ToolInstance {
    return {
      name: 'ui_control',
      label: '界面控制',
      description: '控制系统界面。action: navigate(面板ID), switch_agent(智能体ID), open_url(仅限用户配置的快捷链接), learn(名称), recall(关键词), form_fill(面板ID+data)。注意：open_url 仅允许打开用户已注册的快捷链接，不可打开任意外部网址。',
      parameters: Type.Object({
        action: Type.String(),
        target: Type.String(),
        data: Type.Optional(Type.Object({
          click: Type.Optional(Type.String()),
          fields: Type.Optional(Type.Record(Type.String(), Type.String())),
          forwardMessage: Type.Optional(Type.String({ description: 'switch_agent 时转发给目标智能体的用户消息' })),
        })),
      }),
      execute: async (_id: string, args: { action: string; target: string; data?: any }) => {
        const labels: Record<string, string> = {
          kb: '企业心智', cw: 'CoWorker管理', dashboard: '数据仪表',
          skills: '技能管理', connectors: '连接管理', agents: '智能体管理',
          users: '用户管理', cfg: '设置',
        };

        if (args.action === 'learn') {
          const pageCtx = ctx.agentKey ? this.contextManager.getPageContext(ctx.agentKey) : undefined;
          if (!pageCtx?.panel && !pageCtx?.nav) {
            return { content: [{ type: 'text' as const, text: '无法识别当前页面' }], details: null };
          }
          const userId = ctx.userId || 'anonymous';
          const memory = await this.contextManager.loadPageMemory(userId);
          memory[args.target] = {
            panel: pageCtx.panel || pageCtx.nav || '',
            title: pageCtx.title || '',
            nav: pageCtx.nav || '',
            url: pageCtx.url || '',
            labels: pageCtx.labels || [],
            savedAt: new Date().toISOString(),
          };
          await this.contextManager.savePageMemory(userId, memory);
          return { content: [{ type: 'text' as const, text: `已记住页面: "${args.target}" → ${pageCtx.title || pageCtx.panel}` }], details: null };
        }

        if (args.action === 'recall') {
          const userId = ctx.userId || 'anonymous';
          const memory = await this.contextManager.loadPageMemory(userId);
          const kw = args.target.toLowerCase();
          const matches = Object.entries(memory).filter(([name, info]: [string, any]) =>
            name.toLowerCase().includes(kw) ||
            info.title?.toLowerCase().includes(kw) ||
            (info.labels || []).some((l: string) => l.toLowerCase().includes(kw)),
          );
          if (!matches.length) {
            return { content: [{ type: 'text' as const, text: `没有找到与"${args.target}"相关的页面记忆。` }], details: null };
          }
          const list = matches.map(([n, i]: [string, any]) => `- "${n}" → ${i.panel}`).join('\n');
          return { content: [{ type: 'text' as const, text: `找到以下页面记忆：\n${list}` }], details: { matches: Object.fromEntries(matches) } };
        }

        if (args.action === 'form_fill') {
          return {
            content: [{ type: 'text' as const, text: `正在打开${labels[args.target] || args.target}` }],
            details: { __action: true, actionType: 'form_fill', actionData: { target: args.target, click: args.data?.click, fields: args.data?.fields } },
          };
        }

        // open_url: only allow internal paths
        if (args.action === 'open_url') {
          const isInternal = args.target in labels || args.target.startsWith('/') || !args.target.includes('://');
          if (!isInternal) {
            return { content: [{ type: 'text' as const, text: '安全限制：不允许自动打开外部网址。如需访问请告知用户链接地址，由用户自行打开。' }], details: null };
          }
        }

        if (args.action === 'switch_agent') {
          // Abort current agent and forward user message to target agent
          const pageCtx = ctx.agentKey ? this.contextManager.getPageContext(ctx.agentKey) : undefined;
          return {
            content: [{ type: 'text' as const, text: `正在转交给 ${args.target} 处理...` }],
            details: {
              __abort: true,
              __abortMessage: '',
              __action: true, actionType: 'switch_agent',
              actionData: { target: args.target, forwardMessage: args.data?.forwardMessage },
            },
          };
        }

        const msg = args.action === 'navigate'
          ? `已打开${labels[args.target] || args.target}`
          : args.action === 'open_url'
            ? `已在新标签页打开: ${args.target}`
            : `执行操作: ${args.action} → ${args.target}`;
        return { content: [{ type: 'text' as const, text: msg }], details: { __action: true, actionType: args.action, actionData: { target: args.target } } };
      },
    };
  }

  private buildCodeExecutionTool(Type: any): ToolInstance {
    return {
      name: 'code_execution',
      label: '沙箱代码执行',
      description: '在安全沙箱中执行代码（JavaScript/TypeScript）。适合数据分析、计算、格式转换等任务。',
      parameters: Type.Object({
        code: Type.String({ description: '要执行的代码' }),
        language: Type.Optional(Type.String({ description: '语言: javascript(默认) 或 typescript' })),
      }),
      execute: async (_id: string, args: { code: string; language?: string }) => {
        try {
          const fn = new Function('require', `
            const console = { log: (...a) => __output.push(a.map(String).join(' ')), error: (...a) => __output.push('[ERROR] ' + a.map(String).join(' ')) };
            const __output = [];
            ${args.code}
            return __output.join('\\n');
          `);
          const result = fn(require);
          return { content: [{ type: 'text' as const, text: `## 执行结果\n\n\`\`\`\n${result || '(无输出)'}\n\`\`\`` }], details: null };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `执行错误: ${err.message}` }], details: null };
        }
      },
    };
  }

  private buildCodingAgentTool(Type: any): ToolInstance {
    return {
      name: 'coding_agent',
      label: '自主编程',
      description: '自主编程智能体：分析需求→阅读代码→编写代码→验证。可以独立完成编码任务并报告结果。适合代码生成、Bug 修复、重构等。',
      parameters: Type.Object({
        task: Type.String({ description: '编程任务描述' }),
        workDir: Type.Optional(Type.String({ description: '工作目录' })),
        language: Type.Optional(Type.String({ description: '编程语言偏好' })),
      }),
      execute: async (_id: string, args: { task: string; workDir?: string; language?: string }) => {
        return {
          content: [{ type: 'text' as const, text: `## 编程任务\n\n任务: ${args.task}\n工作目录: ${args.workDir || '当前目录'}\n语言: ${args.language || '自动识别'}\n\n请使用 read、edit、write、bash 等工具完成此编程任务。` }],
          details: { task: args.task, workDir: args.workDir },
        };
      },
    };
  }
}
