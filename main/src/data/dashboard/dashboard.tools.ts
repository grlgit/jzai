import { Injectable } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { DashboardService } from './dashboard.service';
import { AgentPoolService } from '../../agent/core/agent-pool.service';
import { SessionService } from '../../agent/session/session.service';

@Injectable()
export class DashboardToolProvider implements ToolProvider {
  readonly toolIds = ['dashboard_query', 'dashboard_manage', 'dashboard_widget', 'inline_chart'];

  constructor(
    private readonly dashboardService: DashboardService,
    private readonly agentPool: AgentPoolService,
    private readonly sessionService: SessionService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'dashboard_query', label: '数据查询', group: '数据仪表' },
      { id: 'dashboard_manage', label: '仪表盘管理', group: '数据仪表' },
      { id: 'dashboard_widget', label: '仪表盘组件', group: '数据仪表' },
      { id: 'inline_chart', label: '内联图表', group: '数据仪表' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const tools: ToolInstance[] = [];

    // dashboard_query
    tools.push({
      name: 'dashboard_query',
      label: '数据查询',
      description: '查询企业数据。支持 SQL 查询系统内置库（只读）、查询「连接」（数据库连接，query_type=mcp）和静态数据。',
      parameters: Type.Object({
        query_type: Type.Union([Type.Literal('sql'), Type.Literal('mcp'), Type.Literal('static')]),
        sql: Type.Optional(Type.String({ description: 'SQL 查询语句（仅 SELECT）' })),
        mcp_name: Type.Optional(Type.String({ description: '「连接」名称（query_type=mcp 时必填），如 db-MOM-dev' })),
        params: Type.Optional(Type.Any({ description: '查询参数' })),
        data: Type.Optional(Type.Any({ description: '静态数据' })),
      }),
      execute: async (_id: string, args: any) => {
        try {
          const result = await this.dashboardService.executeDataSource(
            { type: args.query_type, query: args.sql, mcp_name: args.mcp_name, params: args.params, data: args.data },
            ctx?.userId || '',
          );
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }], details: null };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `查询失败: ${err.message}` }], details: null };
        }
      },
    });

    // dashboard_manage
    tools.push({
      name: 'dashboard_manage',
      label: '仪表盘管理',
      description: '创建、列出、更新、删除用户的数据仪表盘。theme 为视觉主题：light（白风格，默认）/ dark（黑风格·大屏·反白）。',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('create'), Type.Literal('list'), Type.Literal('update'), Type.Literal('delete')]),
        dashboard_id: Type.Optional(Type.String({ description: '仪表盘ID（更新/删除时必填）' })),
        name: Type.Optional(Type.String({ description: '仪表盘名称（创建/更新时可选）' })),
        description: Type.Optional(Type.String({ description: '仪表盘描述（更新时可选）' })),
        theme: Type.Optional(Type.Union([Type.Literal('light'), Type.Literal('dark')])),
      }),
      execute: async (_id: string, args: any) => {
        const userId = ctx?.userId || '';
        try {
          if (args.action === 'list') {
            const dashboards = await this.dashboardService.listDashboards(userId);
            return { content: [{ type: 'text' as const, text: JSON.stringify(dashboards, null, 2) }], details: null };
          }
          if (args.action === 'create') {
            const dashboard = await this.dashboardService.createDashboard(userId, args.name || '我的仪表盘', undefined, args.theme);
            return { content: [{ type: 'text' as const, text: `仪表盘已创建: ${dashboard.name} (ID: ${dashboard.id}, 主题: ${dashboard.theme === 'dark' ? '黑' : '白'})` }], details: { dashboard } };
          }
          if (args.action === 'update') {
            if (!args.dashboard_id) return { content: [{ type: 'text' as const, text: '请提供 dashboard_id' }], details: null };
            const dashboard = await this.dashboardService.updateDashboard(args.dashboard_id, userId, {
              name: args.name, description: args.description, theme: args.theme,
            });
            return { content: [{ type: 'text' as const, text: `仪表盘已更新: ${dashboard.name}` }], details: { dashboard } };
          }
          if (args.action === 'delete') {
            if (!args.dashboard_id) return { content: [{ type: 'text' as const, text: '请提供 dashboard_id' }], details: null };
            await this.dashboardService.deleteDashboard(args.dashboard_id, userId);
            return { content: [{ type: 'text' as const, text: '仪表盘已删除' }], details: null };
          }
          return { content: [{ type: 'text' as const, text: `未知操作: ${args.action}` }], details: null };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `操作失败: ${err.message}` }], details: null };
        }
      },
    });

    // dashboard_widget
    tools.push({
      name: 'dashboard_widget',
      label: '仪表盘组件',
      description: '在仪表盘上添加、更新或删除数据组件（仪表块）。\n数据源类型：\n- static: 直接传入数据\n- sql: 查询系统内置数据库\n- mcp: 通过「连接」取数（数据库连接 db-* 用 query 传 SQL；其它连接用 tool+params 调任意工具）',
      parameters: Type.Object({
        action: Type.Union([Type.Literal('add'), Type.Literal('update'), Type.Literal('remove')]),
        dashboard_id: Type.String({ description: '目标仪表盘ID' }),
        widget_id: Type.Optional(Type.String({ description: '仪表块ID（更新/删除时必填）' })),
        widget_type: Type.Optional(Type.Union([
          Type.Literal('metric_card'), Type.Literal('pie'), Type.Literal('bar'),
          Type.Literal('line'), Type.Literal('curve'), Type.Literal('radar'), Type.Literal('table'),
        ])),
        title: Type.Optional(Type.String()),
        config: Type.Optional(Type.Any({ description: 'ECharts 配置' })),
        data_source: Type.Optional(Type.Object({
          type: Type.Union([Type.Literal('sql'), Type.Literal('static'), Type.Literal('mcp')]),
          query: Type.Optional(Type.String({ description: 'SQL 查询语句（sql 类型 / mcp 数据库连接用）' })),
          mcp_name: Type.Optional(Type.String({ description: '「连接」名称（mcp 类型必填），如 db-MOM-dev' })),
          tool: Type.Optional(Type.String({ description: '连接的工具名（mcp 类型可选，缺省 execute_query）' })),
          params: Type.Optional(Type.Any({ description: '工具参数（mcp 类型指定 tool 时用）' })),
          data: Type.Optional(Type.Any()),
        })),
        refresh_interval: Type.Optional(Type.Number({ description: '刷新间隔（秒），0 = 不自动刷新' })),
      }),
      execute: async (_id: string, args: any) => {
        const userId = ctx?.userId || '';
        try {
          if (args.action === 'add') {
            const widget = await this.dashboardService.addWidget(args.dashboard_id, userId, {
              widgetType: args.widget_type, title: args.title || '', config: args.config,
              dataSource: args.data_source, refreshInterval: args.refresh_interval,
            });
            if (!widget) throw new Error('仪表创建失败');
            // Bind this session to the widget for future editing
            if (ctx?.agentKey) {
              const sid = this.agentPool.getSessionId(ctx.agentKey);
              if (sid) this.sessionService.bindSkill(sid, `widget:${widget.id}`).catch(() => {});
            }
            return { content: [{ type: 'text' as const, text: `仪表已添加: "${widget.title}" (ID: ${widget.id})` }], details: {
              widget,
              __action: true, actionType: 'ui_hook',
              actionData: { panel: 'dashboard', hook: 'refresh', params: { dashboardId: args.dashboard_id } },
            } };
          }
          if (args.action === 'update') {
            if (!args.widget_id) return { content: [{ type: 'text' as const, text: '请提供 widget_id' }], details: null };
            const widget = await this.dashboardService.updateWidget(args.widget_id, userId, {
              title: args.title, config: args.config, dataSource: args.data_source, refreshInterval: args.refresh_interval,
            });
            if (!widget) return { content: [{ type: 'text' as const, text: '仪表块不存在' }], details: null };
            return { content: [{ type: 'text' as const, text: `仪表块已更新: "${widget.title}"` }], details: { widget } };
          }
          if (args.action === 'remove') {
            if (!args.widget_id) return { content: [{ type: 'text' as const, text: '请提供 widget_id' }], details: null };
            await this.dashboardService.deleteWidget(args.widget_id, userId);
            return { content: [{ type: 'text' as const, text: '仪表块已删除' }], details: null };
          }
          return { content: [{ type: 'text' as const, text: `未知操作: ${args.action}` }], details: null };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `操作失败: ${err.message}` }], details: null };
        }
      },
    });

    // inline_chart
    tools.push({
      name: 'inline_chart',
      label: '内联图表',
      description: '在对话消息中嵌入图表。返回的内容会被前端渲染为交互式图表。支持类型：pie（饼图）、bar（柱状图）、line（折线图）、curve（曲线图）、radar（雷达图）、metric_card（指标卡）。',
      parameters: Type.Object({
        chart_type: Type.Union([
          Type.Literal('pie'), Type.Literal('bar'), Type.Literal('line'),
          Type.Literal('curve'), Type.Literal('radar'), Type.Literal('metric_card'),
        ]),
        title: Type.String({ description: '图表标题' }),
        data: Type.Any({ description: '图表数据（ECharts 格式）' }),
        config: Type.Optional(Type.Any({ description: '额外配置（颜色、图例等）' })),
      }),
      execute: async (_id: string, args: { chart_type: string; title: string; data: any; config?: any }) => {
        const chartSpec = JSON.stringify({ type: args.chart_type, title: args.title, data: args.data, config: args.config || {} });
        const markdown = '```chart\n' + chartSpec + '\n```';
        return { content: [{ type: 'text' as const, text: markdown }], details: null };
      },
    });

    return tools;
  }
}
