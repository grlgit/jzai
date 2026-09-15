import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { randomUUID } from 'crypto';
import { CredentialService } from '../../capability/skill/credential.service';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';

export interface Dashboard {
  id: string;
  userId: string;
  name: string;
  description: string;
  layout: any[];
  isDefault: boolean;
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
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly db: DbService,
    private readonly credentialService: CredentialService,
    private readonly mcpRegistry: McpRegistryService,
  ) {}

  // ===== Dashboards =====

  async listDashboards(userId: string): Promise<Dashboard[]> {
    const { rows } = await this.db.query(
      `SELECT id, user_id AS "userId", name, description, layout, is_default AS "isDefault",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_dashboards WHERE user_id = $1 ORDER BY is_default DESC, created_at`,
      [userId],
    );
    return rows;
  }

  async createDashboard(userId: string, name: string, description = ''): Promise<Dashboard> {
    const id = randomUUID();
    // If user has no dashboards, make this the default
    const { rows: existing } = await this.db.query(
      'SELECT COUNT(*)::int AS count FROM jz_dashboards WHERE user_id = $1', [userId],
    );
    const isDefault = existing[0].count === 0;

    await this.db.query(
      `INSERT INTO jz_dashboards (id, user_id, name, description, is_default)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, userId, name, description, isDefault],
    );
    return this.getDashboard(id, userId);
  }

  async getDashboard(id: string, userId: string): Promise<Dashboard> {
    const { rows } = await this.db.query(
      `SELECT id, user_id AS "userId", name, description, layout, is_default AS "isDefault",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_dashboards WHERE id = $1 AND user_id = $2`,
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

  async updateDashboard(id: string, userId: string, updates: { name?: string; description?: string }): Promise<Dashboard> {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (updates.name !== undefined) { sets.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.description !== undefined) { sets.push(`description = $${idx++}`); params.push(updates.description); }
    sets.push(`updated_at = NOW()`);

    params.push(id, userId);
    await this.db.query(
      `UPDATE jz_dashboards SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
      params,
    );
    return this.getDashboard(id, userId);
  }

  async deleteDashboard(id: string, userId: string): Promise<boolean> {
    const result = await this.db.query(
      'DELETE FROM jz_dashboards WHERE id = $1 AND user_id = $2', [id, userId],
    );
    return (result as any).rowCount > 0;
  }

  async saveLayout(id: string, userId: string, layout: any[]): Promise<void> {
    await this.db.query(
      'UPDATE jz_dashboards SET layout = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3',
      [JSON.stringify(layout), id, userId],
    );
  }

  // ===== Widgets =====

  async listWidgets(dashboardId: string, userId: string): Promise<DashboardWidget[]> {
    const { rows } = await this.db.query(
      `SELECT id, dashboard_id AS "dashboardId", user_id AS "userId", widget_type AS "widgetType",
              title, config, data_source AS "dataSource", refresh_interval AS "refreshInterval",
              cached_data AS "cachedData", cached_at AS "cachedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_dashboard_widgets WHERE dashboard_id = $1 AND user_id = $2
       ORDER BY created_at`,
      [dashboardId, userId],
    );
    return rows;
  }

  async addWidget(dashboardId: string, userId: string, widget: {
    widgetType: string; title: string; config?: any; dataSource?: any; refreshInterval?: number;
  }): Promise<DashboardWidget> {
    // Verify dashboard ownership
    const dashboard = await this.getDashboard(dashboardId, userId);
    if (!dashboard) throw new Error('仪表盘不存在或无权限');

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO jz_dashboard_widgets (id, dashboard_id, user_id, widget_type, title, config, data_source, refresh_interval)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, dashboardId, userId, widget.widgetType, widget.title,
       JSON.stringify(widget.config || {}), JSON.stringify(widget.dataSource || {}), widget.refreshInterval || 0],
    );

    // Auto-add to layout — atomic append via SQL to avoid race conditions when multiple widgets are added concurrently
    const defaultSize = widget.widgetType === 'metric_card' ? { w: 4, h: 3 } : { w: 6, h: 4 };
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

  async getWidget(id: string, userId: string): Promise<DashboardWidget> {
    const { rows } = await this.db.query(
      `SELECT id, dashboard_id AS "dashboardId", user_id AS "userId", widget_type AS "widgetType",
              title, config, data_source AS "dataSource", refresh_interval AS "refreshInterval",
              cached_data AS "cachedData", cached_at AS "cachedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM jz_dashboard_widgets WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    return rows[0] || null;
  }

  async updateWidget(id: string, userId: string, updates: {
    title?: string; config?: any; dataSource?: any; refreshInterval?: number;
  }): Promise<DashboardWidget> {
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (updates.title !== undefined) { sets.push(`title = $${idx++}`); params.push(updates.title); }
    if (updates.config !== undefined) { sets.push(`config = $${idx++}`); params.push(JSON.stringify(updates.config)); }
    if (updates.dataSource !== undefined) { sets.push(`data_source = $${idx++}`); params.push(JSON.stringify(updates.dataSource)); }
    if (updates.refreshInterval !== undefined) { sets.push(`refresh_interval = $${idx++}`); params.push(updates.refreshInterval); }
    sets.push('updated_at = NOW()');

    params.push(id, userId);
    await this.db.query(
      `UPDATE jz_dashboard_widgets SET ${sets.join(', ')} WHERE id = $${idx++} AND user_id = $${idx}`,
      params,
    );
    return this.getWidget(id, userId);
  }

  async deleteWidget(id: string, userId: string): Promise<boolean> {
    // Also remove from parent dashboard layout
    const widget = await this.getWidget(id, userId);
    if (!widget) return false;

    await this.db.query('DELETE FROM jz_dashboard_widgets WHERE id = $1 AND user_id = $2', [id, userId]);

    // Clean layout
    const dashboard = await this.getDashboard(widget.dashboardId, userId);
    if (dashboard) {
      const layout = (dashboard.layout || []).filter((item: any) => item.i !== id);
      await this.saveLayout(widget.dashboardId, userId, layout);
    }
    return true;
  }

  async refreshWidgetData(id: string, userId: string): Promise<DashboardWidget> {
    const widget = await this.getWidget(id, userId);
    if (!widget) throw new Error('仪表块不存在');

    const data = await this.executeDataSource(widget.dataSource, userId);
    await this.db.query(
      'UPDATE jz_dashboard_widgets SET cached_data = $1, cached_at = NOW() WHERE id = $2 AND user_id = $3',
      [JSON.stringify(data), id, userId],
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
        return this.executeMcpQuery(dataSource.mcp_name, dataSource.query);
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

  private async executeMcpQuery(mcpName: string, sql: string): Promise<any> {
    if (!mcpName || !sql) throw new Error('MCP 数据源需要 mcp_name 和 query');

    // Security: only SELECT
    const upper = sql.trim().toUpperCase();
    if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
      throw new Error('安全限制：仅允许 SELECT 查询');
    }

    const mcp = this.mcpRegistry.get(mcpName);
    if (!mcp) throw new Error(`MCP "${mcpName}" 不存在`);
    if (!mcp.handlerCode) throw new Error(`MCP "${mcpName}" 无 handler`);

    const authSystem = mcp.authSystem || mcp.system || mcp.name;
    const creds = this.credentialService.resolveCredentials('', authSystem, mcp.authScope);
    if (!creds || Object.keys(creds).length === 0) throw new Error(`MCP "${mcpName}" 凭证缺失`);

    // Execute handler with execute_query tool
    let code = mcp.handlerCode
      .replace(/import\s+.*?from\s+.*?;?\n?/g, '')
      .replace(/export\s+/g, '')
      .replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ');
    const fn = new Function('require', 'ctx', `return (async function() { ${code} return execute(ctx); })();`);
    const result = await fn(require, {
      params: { sql },
      credentials: creds,
      tool: 'execute_query',
      toolName: 'execute_query',
    });
    return result;
  }

  private async executeApiCall(endpoint: string, params?: any): Promise<any> {
    this.logger.warn(`API data source not yet implemented: ${endpoint}`);
    return { error: 'API 数据源尚未实现', endpoint };
  }
}
