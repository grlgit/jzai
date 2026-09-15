import { Injectable, Logger } from '@nestjs/common';
import { SkillExecutorService } from '../../capability/skill/skill-executor.service';
import { ToolRegistryService } from '../../capability/tool/tool-registry.service';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { ToolBridgeService } from '../tool-bridge/tool-bridge.service';

/**
 * ToolBuilderService — legacy facade for backward compatibility.
 *
 * Tool execution has been migrated to ToolBridgeService → domain-specific ToolProviders.
 * This service now only provides:
 * 1. init() — initializes piAi and wires skill executor's callTool
 * 2. getBuiltinMap() / getAvailableToolCatalog() / getBuiltinToolsByCategory() — catalog for settings UI
 * 3. buildToolsForAgent() — delegates to ToolBridgeService (used by agent-registry.controller for tool resolution)
 */
@Injectable()
export class ToolBuilderService {
  private readonly logger = new Logger(ToolBuilderService.name);
  private piAi: any = null;

  constructor(
    private readonly skillExecutor: SkillExecutorService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly toolBridge: ToolBridgeService,
  ) {}

  async init(piAi: any, codingTools: any[]) {
    this.piAi = piAi;

    // Wire up callTool for skills: allows handler.ts to call registered MCP/Tool
    this.skillExecutor.setToolCaller(async (toolName: string, args: Record<string, any>, userId?: string) => {
      // Dynamically include all registered tool providers plus tools/mcp for individual selections
      const providerIds = this.toolBridge.getRegisteredToolIds();
      const allTools = await this.toolBridge.buildForAgent(
        [...providerIds, 'tools', 'mcp'],
        { userId, agentKey: '__skill__' }
      );
      const tool = allTools.find(t => t.name === toolName);
      if (!tool) return { content: [{ type: 'text', text: `工具 "${toolName}" 未找到` }], details: null };
      // Validate required parameters against tool schema
      const schema = tool.parameters;
      if (schema?.required?.length) {
        const missing = schema.required.filter((k: string) => !(k in args));
        if (missing.length > 0) {
          const expected = Object.keys(schema.properties || {}).join(', ');
          const received = Object.keys(args).join(', ');
          return { content: [{ type: 'text', text: `[参数错误] ${toolName}: 缺少必填参数 [${missing.join(', ')}]。期望参数: ${expected}；收到参数: ${received}` }], details: null };
        }
      }
      const result = await tool.execute(toolName, args);
      if (result?._raw) {
        const raw = result._raw;
        delete result._raw;
        if (Array.isArray(result.content)) {
          const textPart = result.content.find((c: any) => c.type === 'text');
          if (textPart) textPart.text = raw;
        }
      }
      return result;
    });
  }

  /** Catalog of builtin tool IDs with labels and groups (for settings UI) */
  private getBuiltinMap(): Record<string, { label: string; group: string }> {
    return {
      kb_mcp: { label: '企业心智MCP(原始)', group: '知识' },
      knowledge: { label: '企业心智搜索', group: '知识' },
      attachment: { label: '附件解析', group: '内置' },
      ocr: { label: 'OCR文档提取', group: '内置' },
      skills: { label: '已注册技能', group: '内置' },
      ui_control: { label: '界面控制', group: '内置' },
      fetch_url: { label: '读取网页', group: '内置' },
      analyze_har: { label: 'HAR分析', group: 'API分析' },
      test_skill: { label: '测试技能', group: '连接' },
      reload_skills: { label: '重载技能/工具/MCP', group: '连接' },
      test_connector: { label: '测试连接', group: '连接' },
      reload_connectors: { label: '重载连接', group: '连接' },
      mcp_health_check: { label: 'MCP可用性检查', group: '连接' },
      read: { label: '读取文件', group: '编码' },
      edit: { label: '编辑文件', group: '编码' },
      write: { label: '写入文件', group: '编码' },
      bash: { label: '执行命令', group: '编码' },
      grep: { label: '搜索内容', group: '编码' },
      find: { label: '查找文件', group: '编码' },
      ls: { label: '列出目录', group: '编码' },
      web_search: { label: '网页搜索', group: 'Web' },
      web_fetch: { label: '网页抓取(增强)', group: 'Web' },
      browser: { label: '浏览器自动化', group: 'Web' },
      firecrawl: { label: '深度网页抓取', group: 'Web' },
      tavily: { label: '智能搜索', group: 'Web' },
      document_extract: { label: '文档提取', group: '资料处理' },
      summarize: { label: '内容摘要', group: '资料处理' },
      image_understand: { label: '图片理解', group: '资料处理' },
      image_edit: { label: '图片编辑', group: '资料处理' },
      whisper: { label: '语音转文字', group: '资料处理' },
      code_execution: { label: '沙箱代码执行', group: '自动化' },
      taskflow: { label: '任务流编排', group: '自动化' },
      webhooks: { label: 'Webhook接收', group: '自动化' },
      skill_workshop: { label: '技能录制', group: '自动化' },
      github: { label: 'GitHub操作', group: '开发' },
      coding_agent: { label: '自主编程', group: '开发' },
      dashboard_query: { label: '数据查询', group: '数据仪表' },
      dashboard_manage: { label: '仪表盘管理', group: '数据仪表' },
      dashboard_widget: { label: '仪表盘组件', group: '数据仪表' },
      inline_chart: { label: '内联图表', group: '数据仪表' },
      save_db_connection: { label: '保存数据库连接', group: '数据库' },
      test_db_connection: { label: '测试数据库连接', group: '数据库' },
      discover_db_schema: { label: '发现数据库结构', group: '数据库' },
      search_db_schema: { label: '搜索数据库结构', group: '数据库' },
      export_excel: { label: 'Excel导出', group: '数据' },
      update_excel_cells: { label: '修改Excel', group: '数据' },
      pdf_draw_bubbles: { label: 'PDF气泡标注', group: '工程图纸' },
    };
  }

  getBuiltinToolsByCategory() {
    const builtinMap = this.getBuiltinMap();
    const groups = new Map<string, { name: string; description: string; enabled: boolean; builtin: boolean }[]>();
    for (const [id, meta] of Object.entries(builtinMap)) {
      if (!groups.has(meta.group)) groups.set(meta.group, []);
      groups.get(meta.group)!.push({ name: id, description: meta.label, enabled: true, builtin: true });
    }
    const customTools = this.toolRegistry.getAll().map(t => ({ name: t.name, description: t.description || t.name, enabled: t.enabled, builtin: false }));
    if (customTools.length) groups.set('自定义工具', customTools);
    const mcpTools = this.mcpRegistry.getAll().map(m => ({ name: m.name, description: m.description || m.name, enabled: m.enabled, builtin: false }));
    if (mcpTools.length) groups.set('MCP', mcpTools);
    return Array.from(groups.entries()).map(([category, tools]) => ({ category, tools }));
  }

  getAvailableToolCatalog() {
    const builtinMap = this.getBuiltinMap();
    const catalog: { id: string; label: string; group: string }[] = [];
    for (const [id, meta] of Object.entries(builtinMap)) {
      catalog.push({ id, ...meta });
    }
    for (const t of this.toolRegistry.getAll()) {
      catalog.push({ id: `tool:${t.name}`, label: t.description || t.name, group: '自定义工具' });
    }
    for (const m of this.mcpRegistry.getAll()) {
      if (m.status?.phase === 'building') continue;
      catalog.push({ id: `mcp:${m.name}`, label: m.description || m.name, group: 'MCP' });
    }
    return catalog;
  }

  /** @deprecated Use ToolBridgeService.buildForAgent instead. Kept for agent-registry.controller backward compat. */
  async buildToolsForAgent(toolNames: string[], userId?: string, agentKey?: string, userEmail?: string, maxToolOutputChars?: number) {
    return this.toolBridge.buildForAgent(toolNames, { userId, agentKey, userEmail }, maxToolOutputChars);
  }
}
