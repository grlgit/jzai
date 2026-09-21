import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { randomUUID } from 'crypto';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { McpRunnerService } from '../../capability/mcp/mcp-runner.service';

export interface Dashboard {
  id: string;
  userId: string;
  name: string;
  description: string;
  layout: any[];
  theme: 'light' | 'dark';
  isDefault: boolean;
  shared?: boolean;      // true = 来自他人分享（只读）
  ownerName?: string;    // shared 时的创建者姓名
  createdAt: Date;
  updatedAt: Date;
}

export interface DashboardWidget {
  id: string;
  dashboardId: string;
  userId: string;
  widgetType: string;
  title: string;
  config: any;
  dataSource: any;
  refreshInterval: number;
  cachedData: any;
  cachedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class DashboardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DashboardService.name);
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DbService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly mcpRunner: McpRunnerService,
  ) {}

  // ===== 服务端定时刷新（sweeper）=====
  // 此前 refresh_interval 仅驱动前端 setInterval，页面关闭后数据即停更。
  // sweeper 每 60s 扫描到期 widget 并重执行数据源更新缓存，使"生成一次、永久动态刷新"成立。

  onModuleInit() {
    this.sweepTimer = setInterval(() => this.sweepStaleWidgets().catch(() => {}), 60_000);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  /** 扫描 refresh_interval>0 且缓存已过期（或从未缓存）的 widget，重执行并更新缓存 */
  async sweepStaleWidgets(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT id, user_id AS "userId", data_source AS "dataSource"
       FROM jz_dashboard_widgets
       WHERE refresh_interval > 0
         AND (cached_at IS NULL OR cached_at + (refresh_interval || ' seconds')::interval < NOW())
       LIMIT 50`,
    );
    let refreshed = 0;
    for (const w of rows) {
      if (!w.dataSource?.type) continue;
      try {
        const data = await this.executeDataSource(w.dataSource, w.userId);
        await this.db.query(
          'UPDATE jz_dashboard_widgets SET cached_data = $1, cached_at = NOW() WHERE id = $2',
          [JSON.stringify(data), w.id],
        );
        refreshed++;
      } catch (err: any) {
        this.logger.warn(`sweeper 刷新 widget ${w.id} 失败: ${err.message}`);
        // 失败也推进 cached_at，避免每次扫描都重试同一个坏 widget（下个周期仍会到期重试）
        await this.db.query('UPDATE jz_dashboard_widgets SET cached_at = NOW() WHERE id = $1', [w.id]).catch(() => {});
      }
    }
    if (refreshed > 0) this.logger.log(`sweeper 刷新 ${refreshed}/${rows.length} 个到期 widget`);
    return refreshed;
  }

  /** 主题值归一化：LLM/用户可能传 'Dark'、'深色'、'黑色' 等，统一折叠为 light|dark */
  private normalizeTheme(t: any): 'light' | 'dark' {
    const s = String(t ?? '').trim().toLowerCase();
    return (s === 'dark' || s.includes('黑') || s.includes('深')) ? 'dark' : 'light';
  }

  /** 保存即校验：mcp 数据源的连接必须真实存在，避免连接删除/改名后静默失效 */
  private assertDataSourceValid(dataSource: any): void {
    if (dataSource?.type === 'mcp') {
      if (!dataSource.mcp_name) throw new Error('MCP 数据源需要 mcp_name');
      if (!this.mcpRegistry.get(dataSource.mcp_name)) {
        throw new Error(`连接 "${dataSource.mcp_name}" 不存在，请在「连接」面板确认名称`);
      }
    }
  }

  // ===== 权限：创建者隔离 + 分享只读 =====

  /** 创建者本人，或被分享用户（只读） */
  private async canAccess(id: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM jz_dashboards d
       WHERE d.id = $1 AND (d.user_id = $2
         OR EXISTS (SELECT 1 FROM jz_dashboard_shares s WHERE s.dashboard_id = d.id AND s.shared_with = $2))
       LIMIT 1`,
      [id, userId],
    );
    return rows.length > 0;
  }

  /** 写操作仅创建者 */
  private async assertOwner(id: string, userId: string): Promise<void> {
    const { rows } = await this.db.query('SELECT user_id FROM jz_dashboards WHERE id = $1', [id]);
    if (!rows[0]) throw new Error('仪表盘不存在');
    if (rows[0].user_id !== userId) throw new Error('仅看板所有者可编辑（该看板为分享只读）');
  }

  // ===== Shares =====

  async listShares(dashboardId: string, userId: string): Promise<any[]> {
    await this.assertOwner(dashboardId, userId);
    const { rows } = await this.db.query(
      `SELECT s.shared_with AS "userId", u.name, u.username, s.created_at AS "createdAt"
       FROM jz_dashboard_shares s LEFT JOIN jz_users u ON u.id = s.shared_with
       WHERE s.dashboard_id = $1 ORDER BY s.created_at`,
      [dashboardId],
    );
    return rows;
  }

  async addShare(dashboardId: string, userId: string, targetUserId: string): Promise<void> {
    await this.assertOwner(dashboardId, userId);
    if (targetUserId === userId) throw new Error('不能分享给自己');
    const { rows } = await this.db.query('SELECT id FROM jz_users WHERE id = $1', [targetUserId]);
    if (!rows[0]) throw new Error('目标用户不存在');
    await this.db.query(
      'INSERT INTO jz_dashboard_shares (dashboard_id, owner_id, shared_with) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [dashboardId, userId, targetUserId],
    );
  }

  async removeShare(dashboardId: string, userId: string, targetUserId: string): Promise<void> {
    await this.assertOwner(dashboardId, userId);
    await this.db.query(
      'DELETE FROM jz_dashboard_shares WHERE dashboard_id = $1 AND shared_with = $2',
      [dashboardId, targetUserId],
    );
  }

  // ===== Dashboards =====

  async listDashboards(userId: string): Promise<Dashboard[]> {
    // 自建（shared=false）∪ 被分享（shared=true，带创建者姓名），统一按创建时间倒排
    const { rows } = await this.db.query(
      `SELECT d.id, d.user_id AS "userId", d.name, d.description, d.layout, d.theme,
              d.is_default AS "isDefault", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
              FALSE AS shared, NULL::text AS "ownerName"
       FROM jz_dashboards d WHERE d.user_id = $1
       UNION ALL
       SELECT d.id, d.user_id, d.name, d.description, d.layout, d.theme,
              d.is_default, d.created_at, d.updated_at,
              TRUE, u.name
       FROM jz_dashboards d
       JOIN jz_dashboard_shares s ON s.dashboard_id = d.id AND s.shared_with = $1
       LEFT JOIN jz_users u ON u.id = d.user_id
       ORDER BY 8 DESC`,
      [userId],
    );
    return rows;
  }

  async createDashboard(userId: string, name: string, description = '', theme: 'light' | 'dark' = 'light'): Promise<Dashboard> {
    const id = randomUUID();
    // If user has no dashboards, make this the default
    const { rows: existing } = await this.db.query(
      'SELECT COUNT(*)::int AS count FROM jz_dashboards WHERE user_id = $1', [userId],
    );
    const isDefault = existing[0].count === 0;

    await this.db.query(
      `INSERT INTO jz_dashboards (id, user_id, name, description, is_default, theme)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, userId, name, description, isDefault, this.normalizeTheme(theme)],
    );
    return this.getDashboard(id, userId);
  }

  async getDashboard(id: string, userId: string): Promise<Dashboard> {
    // 读路径：创建者或被分享人均可；写路径另由 assertOwner 把关
    const { rows } = await this.db.query(
      `SELECT d.id, d.user_id AS "userId", d.name, d.description, d.layout, d.theme,
              d.is_default AS "isDefault", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
              (d.user_id <> $2) AS shared, u.name AS "ownerName"
       FROM jz_dashboards d LEFT JOIN jz_users u ON u.id = d.user_id
       WHERE d.id = $1 AND (d.user_id = $2
         OR EXISTS (SELECT 1 FROM jz_dashboard_shares s WHERE s.dashboard_id = d.id AND s.shared_with = $2))`,
      [id, userId],
    );
    return rows[0] || null;
  }

  async getDashboardWithWidgets(id: string, userId: string): Promise<{ dashboard: Dashboard; widgets: DashboardWidget[] } | null> {
    const dashboard = await this.getDashboard(id, userId);
    if (!dashboard) return null;
    const widgets = await this.listWidgets(id, userId);
    return { dashboard, widgets };
  }

  async updateDashboard(id: string, userId: string, updates: { name?: string; description?: string; theme?: 'light' | 'dark' }): Promise<Dashboard> {
    await this.assertOwner(id, userId);
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (updates.name !== undefined) { sets.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.description !== undefined) { sets.push(`description = $${idx++}`); params.push(updates.description); }
    if (updates.theme !== undefined) { sets.push(`theme = $${idx++}`); params.push(this.normalizeTheme(updates.theme)); }
    sets.push(`updated_at = NOW()`);

    params.push(id, userId);
    await this.db.query(
      `UPDATE jz_dashboards SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
      params,
    );
    return this.getDashboard(id, userId);
  }

  async deleteDashboard(id: string, userId: string): Promise<boolean> {
    await this.assertOwner(id, userId);
    const result = await this.db.query(
      'DELETE FROM jz_dashboards WHERE id = $1', [id],
    );
    return (result as any).rowCount > 0;
  }

  async saveLayout(id: string, userId: string, layout: any[]): Promise<void> {
    await this.assertOwner(id, userId);
    await this.db.query(
      'UPDATE jz_dashboards SET layout = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(layout), id],
    );
  }

  // ===== Widgets =====

  async listWidgets(dashboardId: string, userId: string): Promise<DashboardWidget[]> {
    if (!(await this.canAccess(dashboardId, userId))) return [];
    const { rows } = await this.db.query(
      `SELECT id, dashboard_id AS "dashboardId", user_id AS "userId", widget_type AS "widgetType",
              title, config, data_source AS "dataSource", refresh_interval AS "refreshInterval",
              cached_data AS "cachedData", cached_at AS "cachedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_dashboard_widgets WHERE dashboard_id = $1
       ORDER BY created_at`,
      [dashboardId],
    );
    return rows;
  }

  async addWidget(dashboardId: string, userId: string, widget: {
    widgetType: string; title: string; config?: any; dataSource?: any; refreshInterval?: number;
  }): Promise<DashboardWidget | null> {
    // 写操作仅创建者
    await this.assertOwner(dashboardId, userId);
    this.assertDataSourceValid(widget.dataSource);

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO jz_dashboard_widgets (id, dashboard_id, user_id, widget_type, title, config, data_source, refresh_interval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, dashboardId, userId, widget.widgetType, widget.title,
       JSON.stringify(widget.config || {}), JSON.stringify(widget.dataSource || {}), widget.refreshInterval || 0],
    );

    // Auto-add to layout — atomic append via SQL to avoid race conditions when multiple widgets are added concurrently
    const defaultSize = widget.widgetType === 'metric_card' ? { w: 4, h: 3 } : widget.widgetType === 'table' ? { w: 8, h: 4 } : { w: 6, h: 4 };
    const layoutItem = JSON.stringify({ i: id, x: 0, y: 0, ...defaultSize });
    await this.db.query(
      `UPDATE jz_dashboards SET layout = (
        SELECT jsonb_agg(item) FROM (
          SELECT item FROM jsonb_array_elements(COALESCE(layout, '[]'::jsonb)) AS item
          UNION ALL
          SELECT jsonb_set($1::jsonb, '{y}',
            (SELECT COALESCE(MAX((item->>'y')::int + (item->>'h')::int), 0) FROM jsonb_array_elements(COALESCE(layout, '[]'::jsonb)) AS item)::text::jsonb
          )
        ) sub
      ), updated_at = NOW() WHERE id = $2 AND user_id = $3`,
      [layoutItem, dashboardId, userId],
    );

    // Immediately cache data if dataSource is provided
    if (widget.dataSource?.type) {
      try {
        const data = await this.executeDataSource(widget.dataSource, userId);
        await this.db.query(
          'UPDATE jz_dashboard_widgets SET cached_data = $1, cached_at = NOW() WHERE id = $2',
          [JSON.stringify(data), id],
        );
      } catch (err: any) {
        this.logger.warn(`Widget ${id} initial data cache failed: ${err.message}`);
      }
    }

    return this.getWidget(id, userId);
  }

  async getWidget(id: string, userId: string): Promise<DashboardWidget | null> {
    const { rows } = await this.db.query(
      `SELECT id, dashboard_id AS "dashboardId", user_id AS "userId", widget_type AS "widgetType",
              title, config, data_source AS "dataSource", refresh_interval AS "refreshInterval",
              cached_data AS "cachedData", cached_at AS "cachedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_dashboard_widgets WHERE id = $1`,
      [id],
    );
    const widget: DashboardWidget | null = rows[0] || null;
    if (!widget) return null;
    if (!(await this.canAccess(widget.dashboardId, userId))) return null;
    return widget;
  }

  async updateWidget(id: string, userId: string, updates: {
    title?: string; config?: any; dataSource?: any; refreshInterval?: number;
  }): Promise<DashboardWidget | null> {
    const widget = await this.getWidget(id, userId);
    if (!widget) return null;
    await this.assertOwner(widget.dashboardId, userId);
    this.assertDataSourceValid(updates.dataSource);
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (updates.title !== undefined) { sets.push(`title = $${idx++}`); params.push(updates.title); }
    if (updates.config !== undefined) { sets.push(`config = $${idx++}`); params.push(JSON.stringify(updates.config)); }
    if (updates.dataSource !== undefined) { sets.push(`data_source = $${idx++}`); params.push(JSON.stringify(updates.dataSource)); }
    if (updates.refreshInterval !== undefined) { sets.push(`refresh_interval = $${idx++}`); params.push(updates.refreshInterval); }
    sets.push('updated_at = NOW()');

    params.push(id);
    await this.db.query(
      `UPDATE jz_dashboard_widgets SET ${sets.join(', ')} WHERE id = $${idx}`,
      params,
    );
    return this.getWidget(id, userId);
  }

  async deleteWidget(id: string, userId: string): Promise<boolean> {
    const widget = await this.getWidget(id, userId);
    if (!widget) return false;
    await this.assertOwner(widget.dashboardId, userId);

    await this.db.query('DELETE FROM jz_dashboard_widgets WHERE id = $1', [id]);

    // Clean layout
    const dashboard = await this.getDashboard(widget.dashboardId, userId);
    if (dashboard) {
      const layout = (dashboard.layout || []).filter((item: any) => item.i !== id);
      await this.saveLayout(widget.dashboardId, userId, layout);
    }
    return true;
  }

  async refreshWidgetData(id: string, userId: string): Promise<DashboardWidget | null> {
    const widget = await this.getWidget(id, userId);
    if (!widget) throw new Error('仪表块不存在');

    // 以创建者身份取数（连接的凭据归属创建者；被分享人手动刷新等价于查看最新数据）
    const data = await this.executeDataSource(widget.dataSource, widget.userId);
    await this.db.query(
      'UPDATE jz_dashboard_widgets SET cached_data = $1, cached_at = NOW() WHERE id = $2',
      [JSON.stringify(data), id],
    );
    return this.getWidget(id, userId);
  }

  // ===== Data Source Execution =====

  async executeDataSource(dataSource: any, userId: string): Promise<any> {
    if (!dataSource?.type) return null;

    // OEM 影子用户：硬隔离——只允许绑定的 MCP 源或静态数据，禁止直查见智内部库(sql)/任意 api
    await this.assertOemDataSourceAllowed(userId, dataSource);

    switch (dataSource.type) {
      case 'sql':
        return this.executeSqlQuery(dataSource.query, dataSource.params);
      case 'mcp':
        return this.executeMcpQuery(dataSource, userId);
      case 'api':
        return this.executeApiCall(dataSource.endpoint, dataSource.params);
      case 'static':
        return dataSource.data || null;
      default:
        throw new Error(`不支持的数据源类型: ${dataSource.type}`);
    }
  }

  /**
   * OEM 数据源硬隔离。若 userId 是某接入方的影子用户，则该会话取数只能命中
   * 该 app 绑定的 MCP 源（或静态数据）；任何 sql/api/越界 mcp_name 一律拒绝，
   * 防止 data_master 被诱导直查见智内部库或绕过绑定范围。非 OEM 用户零影响。
   */
  private async assertOemDataSourceAllowed(userId: string, dataSource: any): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT a.mcp_bindings FROM jz_users u
       JOIN jz_oem_apps a ON a.app_id = u.oem_app_id
       WHERE u.id = $1 AND u.is_oem_shadow = TRUE`,
      [userId],
    );
    if (!rows[0]) return; // 非 OEM 影子用户，不限制
    if (dataSource.type === 'static') return;
    if (dataSource.type !== 'mcp') {
      throw new Error(`OEM 会话仅允许使用绑定的 MCP 数据源或静态数据，禁止 ${dataSource.type}`);
    }
    const allowed: string[] = (rows[0].mcp_bindings || []).map((b: any) => b.mcp_name);
    if (!allowed.includes(dataSource.mcp_name)) {
      throw new Error(`OEM 数据源越界：${dataSource.mcp_name} 不在接入方绑定范围`);
    }
  }

  private async executeSqlQuery(query: string, params?: any[]): Promise<any> {
    if (!query) throw new Error('SQL 查询不能为空');

    // Security: only allow SELECT statements
    const normalized = query.trim().toUpperCase();
    if (!normalized.startsWith('SELECT')) {
      throw new Error('安全限制：仅允许 SELECT 查询');
    }
    // Reject dangerous keywords
    const forbidden = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'ALTER', 'TRUNCATE', 'CREATE', 'GRANT', 'REVOKE', 'EXEC'];
    for (const kw of forbidden) {
      // Check for keyword as standalone word (not inside quotes)
      const regex = new RegExp(`\\b${kw}\\b`, 'i');
      // Simple check: if the keyword appears and it's not the leading SELECT
      if (kw !== 'SELECT' && regex.test(query)) {
        throw new Error(`安全限制：查询中不允许使用 ${kw}`);
      }
    }

    try {
      const { rows } = await this.db.query(
        `SET LOCAL statement_timeout = '10s'; ${query}`,
        params || [],
      );
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      return { columns, rows, rowCount: rows.length };
    } catch (err: any) {
      throw new Error(`SQL 执行失败: ${err.message}`);
    }
  }

  /**
   * 执行 MCP「连接」数据源。统一走 McpRunnerService（与 agent 工具链同一实现，
   * 凭据按 widget 属主真实 userId 解析、带 db- 前缀回退）。
   *
   * data_source 形态（向后兼容）：
   *   { type:'mcp', mcp_name, query }             —— 数据库连接：SQL（仅 SELECT/WITH），等价 tool=execute_query
   *   { type:'mcp', mcp_name, tool, params }      —— 通用连接：任意 MCP 工具 + 参数
   */
  private async executeMcpQuery(dataSource: any, userId: string): Promise<any> {
    const { mcp_name: mcpName } = dataSource || {};
    if (!mcpName) throw new Error('MCP 数据源需要 mcp_name');

    const tool = dataSource.tool || 'execute_query';
    const params = dataSource.params || (dataSource.query ? { sql: dataSource.query } : {});

    // Security: 数据库查询工具仅允许 SELECT/WITH
    if (tool === 'execute_query') {
      if (!params.sql) throw new Error('MCP 数据源需要 query（SQL）或显式 params');
      const upper = String(params.sql).trim().toUpperCase();
      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        throw new Error('安全限制：仅允许 SELECT 查询');
      }
    }

    const result = await this.mcpRunner.run(mcpName, { tool, params, userId });
    // 连接查询失败（success:false）不得作为数据缓存——抛出，由调用方按失败处理
    if (result && result.success === false) {
      throw new Error(result.message || `连接 "${mcpName}" 查询失败`);
    }
    return result;
  }

  private async executeApiCall(endpoint: string, params?: any): Promise<any> {
    this.logger.warn(`API data source not yet implemented: ${endpoint}`);
    return { error: 'API 数据源尚未实现', endpoint };
  }
}
