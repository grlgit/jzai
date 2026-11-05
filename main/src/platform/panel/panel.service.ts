import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
// 值导入（非 import type）：构造函数参数装饰器需要运行期元数据才能被 Nest DI 解析
import { AgentRegistryService } from '../../agent/core/agent-registry.service';
import { ResourceAccessService } from '../authz/resource-access.service';
import { createUserPrincipal } from '../app-store/runtime/invocation-principal';
import { DbService } from '../../db/db.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import * as fs from 'fs';

const SEED_PANELS = [
  { id: 'cw',            name: 'AI员工',    icon: 'img:/icons/coworker.svg',    permission: 'cw:view',        isBuiltin: false, sortOrder: 2, category: 'builtin', agentId: null },
  { id: 'dashboard',     name: '数据仪表',  icon: 'img:/icons/dashboard.svg',   permission: 'nav:dashboard',  isBuiltin: false, sortOrder: 3, category: 'builtin', agentId: 'data_master' },
  { id: 'skills',        name: '技能',      icon: 'img:/icons/skills.svg',      permission: 'nav:skills',     isBuiltin: false, sortOrder: 5, category: 'builtin', agentId: 'skill_master' },
  { id: 'connectors',    name: '连接',      icon: 'img:/icons/connectors.svg',  permission: 'nav:connectors', isBuiltin: false, sortOrder: 6, category: 'builtin', agentId: 'connector_master' },
  { id: 'agents',        name: '智能体',    icon: 'img:/icons/agents.svg',      permission: 'nav:agents',     isBuiltin: false, sortOrder: 7, category: 'system',  agentId: null },
  { id: 'apps',          name: '应用',      icon: 'img:/icons/apps.svg',        permission: 'nav:apps',       isBuiltin: false, sortOrder: 8, category: 'builtin', agentId: null },
  { id: 'cfg',           name: '设置',      icon: '⚙',                          permission: 'nav:settings',   isBuiltin: true,  sortOrder: 9, category: 'system',  agentId: null },
];

export interface SidebarItem {
  id: string;
  name: string;
  icon: string;
  visible: boolean;
  groupName: string;
  sortOrder: number;
  isBuiltin: boolean;
  category: string;
  sourceAppId?: string;
  agentId?: string;
  uninstallable: boolean;
  nameI18n?: Record<string, string>;
  entryComponent?: string;
  keepAlive?: boolean;
  messageSchema?: string;
  appVersion?: string;
}

export interface AppPanelSpec {
  id: string;
  name: Record<string, string>;
  icon?: string;
  groupName?: string;
  sortOrder?: number;
  permission?: string;
  entryComponent?: string;
  agentId?: string;
  keepAlive?: boolean;
  messageSchema?: string;
  /** P4 移动端声明（manifest panels[].mobile 原样存 JSONB） */
  mobile?: { supported: boolean; entryComponent?: string; layout?: 'full' | 'sheet' };
}

@Injectable()
export class PanelService implements OnModuleInit {
  private readonly logger = new Logger(PanelService.name);

  constructor(
    private readonly db: DbService,
    private readonly workspace: WorkspaceService,
    // @Optional：spec 直构只传 db；面板配对智能体的名称/图标仅用于前端显示
    @Optional() private readonly agents?: AgentRegistryService,
    // @Optional：spec 直构不接线时保持旧行为（配对智能体不透出过滤）
    @Optional() private readonly access?: ResourceAccessService,
  ) {}

  async onModuleInit() {
    await this.seedPanels();
  }

  private async seedPanels() {
    for (const p of SEED_PANELS) {
      await this.db.query(
        `INSERT INTO jz_panels (id, name, icon, permission, is_builtin, sort_order, category, agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           name = $2, icon = $3, permission = $4,
           category = $7, agent_id = $8`,
        [p.id, p.name, p.icon, p.permission, p.isBuiltin, p.sortOrder, p.category, p.agentId],
      );
    }
    // Remove deprecated panels（kb：企业心智入口已迁入企业WIKI APP，U10）
    await this.db.query(`DELETE FROM jz_panels WHERE id IN ('dash', 'distill', 'users', 'kb')`).catch(() => {});
    await this.db.query(`DELETE FROM jz_user_sidebar WHERE panel_id IN ('distill', 'users', 'kb')`).catch(() => {});
    this.logger.log(`Seeded ${SEED_PANELS.length} panels`);
  }

  async listPanels() {
    const { rows } = await this.db.query(
      'SELECT id, name, icon, permission, is_builtin as "isBuiltin", sort_order as "sortOrder" FROM jz_panels ORDER BY sort_order',
    );
    return rows;
  }

  async getUserSidebar(userId: string, permissions: string[]): Promise<SidebarItem[]> {
    const isAdmin = permissions.includes('sys:admin');
    const hasAppTable = await this.appTableExists();

    let rows: any[];
    if (hasAppTable) {
      const { rows: r } = await this.db.query(
        `SELECT p.id, p.name, p.icon, p.permission,
                p.is_builtin as "isBuiltin", p.sort_order as "defaultOrder",
                p.category, p.source_app_id as "sourceAppId",
                p.agent_id as "agentId", p.uninstallable,
                p.name_i18n as "nameI18n",
                p.entry_component as "entryComponent",
                p.keep_alive as "keepAlive",
                p.message_schema as "messageSchema",
                p.mobile_config as "mobile",
                a.version as "appVersion",
                COALESCE(us.visible, TRUE) as "visible",
                COALESCE(us.group_name, '') as "groupName",
                COALESCE(us.sort_order, p.sort_order) as "sortOrder",
                us.custom_name as "customName",
                us.custom_icon as "customIcon",
                g.level AS "grantRole"
         FROM jz_panels p
         LEFT JOIN jz_user_sidebar us ON us.panel_id = p.id AND us.user_id = $1
         -- P1 T1.10：双表判定——旧 jz_app_grants UNION ALL 新 jz_resource_grants(resource_type='panel')
         -- sub_id 语义：'' = 整面板授权；非空 = 该面板某 permission 条目授权
         LEFT JOIN LATERAL (
           SELECT g2.level FROM (
             SELECT g.level FROM jz_app_grants g
             WHERE g.app_id = p.source_app_id
               AND g.level != 'none'
               AND (p.permission IS NULL OR g.permission_id = p.permission)
               AND (
                 (g.target_type = 'user' AND g.target_id = $1)
                 OR (g.target_type = 'role' AND g.target_id IN (SELECT u.role_id FROM jz_users u WHERE u.id = $1))
                 OR (g.target_type = 'department' AND g.target_id IN (
                   SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id = $1
                 ))
               )
             UNION ALL
             SELECT rg.level FROM jz_resource_grants rg
             WHERE rg.resource_type = 'panel'
               AND rg.resource_id = p.id
               AND rg.level != 'none'
               AND (rg.sub_id = '' OR p.permission IS NULL OR rg.sub_id = p.permission)
               AND (
                 (rg.target_type = 'user' AND rg.target_id = $1)
                 OR (rg.target_type = 'role' AND rg.target_id IN (SELECT u.role_id FROM jz_users u WHERE u.id = $1))
                 OR (rg.target_type = 'department' AND rg.target_id IN (
                   SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id = $1
                 ))
               )
           ) g2
           LIMIT 1
         ) g ON TRUE
         LEFT JOIN jz_installed_apps a ON a.app_id = p.source_app_id
         WHERE (p.source_app_id IS NULL OR a.status = 'active')
         ORDER BY COALESCE(us.sort_order, p.sort_order)`,
        [userId],
      );
      rows = r;
    } else {
      const { rows: r } = await this.db.query(
        `SELECT p.id, p.name, p.icon, p.permission,
                p.is_builtin as "isBuiltin", p.sort_order as "defaultOrder",
                p.category, p.source_app_id as "sourceAppId",
                p.agent_id as "agentId", p.uninstallable,
                p.name_i18n as "nameI18n",
                p.entry_component as "entryComponent",
                p.keep_alive as "keepAlive",
                p.message_schema as "messageSchema",
                COALESCE(us.visible, TRUE) as "visible",
                COALESCE(us.group_name, '') as "groupName",
                COALESCE(us.sort_order, p.sort_order) as "sortOrder",
                us.custom_name as "customName",
                us.custom_icon as "customIcon",
                g.level AS "grantRole"
         FROM jz_panels p
         LEFT JOIN jz_user_sidebar us ON us.panel_id = p.id AND us.user_id = $1
         -- P1 T1.10：双表判定——旧 jz_app_grants UNION ALL 新 jz_resource_grants(resource_type='panel')
         -- sub_id 语义：'' = 整面板授权；非空 = 该面板某 permission 条目授权
         LEFT JOIN LATERAL (
           SELECT g2.level FROM (
             SELECT g.level FROM jz_app_grants g
             WHERE g.app_id = p.source_app_id
               AND g.level != 'none'
               AND (p.permission IS NULL OR g.permission_id = p.permission)
               AND (
                 (g.target_type = 'user' AND g.target_id = $1)
                 OR (g.target_type = 'role' AND g.target_id IN (SELECT u.role_id FROM jz_users u WHERE u.id = $1))
                 OR (g.target_type = 'department' AND g.target_id IN (
                   SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id = $1
                 ))
               )
             UNION ALL
             SELECT rg.level FROM jz_resource_grants rg
             WHERE rg.resource_type = 'panel'
               AND rg.resource_id = p.id
               AND rg.level != 'none'
               AND (rg.sub_id = '' OR p.permission IS NULL OR rg.sub_id = p.permission)
               AND (
                 (rg.target_type = 'user' AND rg.target_id = $1)
                 OR (rg.target_type = 'role' AND rg.target_id IN (SELECT u.role_id FROM jz_users u WHERE u.id = $1))
                 OR (rg.target_type = 'department' AND rg.target_id IN (
                   SELECT dm.department_id FROM jz_department_members dm WHERE dm.user_id = $1
                 ))
               )
           ) g2
           LIMIT 1
         ) g ON TRUE
         ORDER BY COALESCE(us.sort_order, p.sort_order)`,
        [userId],
      );
      rows = r;
    }

    // 配对智能体按可见性透出：普通用户不可见的 agent（如 connector_master，meta 'none'）不带出
    // agentId/名称/图标——前端据此不并入聊天选择器、打开面板也不自动切换（修"普通用户可与连接大师对话"）。
    // meta 缺失的未纳管 agent（APP 动态 agent）保持旧行为放行。
    const hiddenAgents = new Set<string>();
    if (!isAdmin && this.access) {
      const agentIds = [...new Set(rows.map((r: any) => r.agentId).filter(Boolean))] as string[];
      if (agentIds.length > 0) {
        const [uRows, dRows] = await Promise.all([
          this.db.query(`SELECT role_id FROM jz_users WHERE id = $1`, [userId]),
          this.db.query(`SELECT department_id FROM jz_department_members WHERE user_id = $1`, [userId]),
        ]);
        const principal = createUserPrincipal({
          id: userId,
          roleId: uRows.rows[0]?.role_id,
          departmentIds: dRows.rows.map((d: any) => d.department_id),
          permissions,
        }, 'http:sidebar');
        await Promise.all(agentIds.map(async id => {
          if (!(await this.access!.canViewOrUnmanaged('agent', id, principal))) hiddenAgents.add(id);
        }));
      }
    }

    return rows
      .filter((r: any) => {
        if (r.category === 'third_party') {
          // 三方面板：管理员走 grant 或 sys:admin 均可；普通用户必须有 grant
          return isAdmin || !!r.grantRole;
        }
        if (isAdmin) return true;
        return !r.permission || permissions.includes(r.permission);
      })
      .map((r: any) => ({
        id: r.id,
        name: r.customName || r.name,
        icon: r.customIcon || r.icon,
        visible: r.visible,
        groupName: r.groupName,
        sortOrder: r.sortOrder,
        isBuiltin: r.isBuiltin,
        category: r.category ?? 'builtin',
        sourceAppId: r.sourceAppId ?? undefined,
        agentId: r.agentId && !hiddenAgents.has(r.agentId) ? r.agentId : undefined,
        uninstallable: !!r.uninstallable,
        nameI18n: r.nameI18n ?? undefined,
        entryComponent: r.entryComponent ?? undefined,
        keepAlive: !!r.keepAlive,
        messageSchema: r.messageSchema ?? undefined,
        mobile: r.mobile ? (typeof r.mobile === 'string' ? JSON.parse(r.mobile) : r.mobile) : undefined,
        appVersion: r.appVersion ?? undefined,
        // 配对智能体显示元数据（仅 name/icon，不含 soul/提示词）：
        // 前端在"当前智能体"徽标等处需要显示名，但该智能体可能不在用户可授权列表中（面板配对服务智能体）
        ...(r.agentId && !hiddenAgents.has(r.agentId) && this.agents?.get(r.agentId)
          ? { agentName: this.agents.get(r.agentId)!.name, agentIcon: this.agents.get(r.agentId)!.icon }
          : {}),
      }));
  }

  async listPanelsByCategory(category: string) {
    const { rows } = await this.db.query(
      `SELECT id, name, icon, permission, is_builtin as "isBuiltin", sort_order as "sortOrder",
              category, source_app_id as "sourceAppId", agent_id as "agentId",
              uninstallable, name_i18n as "nameI18n"
       FROM jz_panels WHERE category = $1 ORDER BY sort_order`,
      [category],
    );
    return rows;
  }

  async registerAppPanel(panel: AppPanelSpec, appId: string): Promise<void> {
    const nameZh = panel.name?.zh ?? panel.name?.en ?? '';
    const nameEn = panel.name?.en ?? nameZh;
    await this.db.query(
      `INSERT INTO jz_panels
         (id, name, icon, permission, is_builtin, sort_order, category,
          source_app_id, agent_id, uninstallable, entry_component, name_i18n, keep_alive, message_schema,
          mobile_config)
       VALUES ($1,$2,$3,$4,FALSE,$5,'third_party',$6,$7,TRUE,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         name=$2, icon=$3, permission=$4, sort_order=$5,
         source_app_id=$6, agent_id=$7, entry_component=$8, name_i18n=$9, keep_alive=$10, message_schema=$11,
         mobile_config=$12`,
      [
        panel.id, nameZh,
        panel.icon ?? '',
        panel.permission ?? null,
        panel.sortOrder ?? 100,
        appId,
        panel.agentId ?? null,
        panel.entryComponent ?? null,
        JSON.stringify(panel.name),
        panel.keepAlive ?? false,
        panel.messageSchema ?? null,
        panel.mobile ? JSON.stringify(panel.mobile) : null,
      ],
    );
  }

  async removeAppPanels(appId: string): Promise<void> {
    // 必须先取回面板 id 再删：先删 jz_panels 会让清理 jz_user_sidebar 的子查询
    // 永远返回空，重装后用户的显隐/分组/排序覆盖会带着陈旧数据复活。
    const { rows } = await this.db.query(
      `SELECT id FROM jz_panels WHERE source_app_id = $1`,
      [appId],
    );
    if (rows.length > 0) {
      const placeholders = rows.map((_: any, i: number) => `$${i + 1}`).join(', ');
      await this.db.query(
        `DELETE FROM jz_user_sidebar WHERE panel_id IN (${placeholders})`,
        rows.map((r: any) => r.id),
      );
    }
    await this.db.query(`DELETE FROM jz_panels WHERE source_app_id = $1`, [appId]);
  }

  /** 检查 jz_installed_apps 表是否已存在（L1 阶段该表不存在） */
  private async appTableExists(): Promise<boolean> {
    try {
      const { rows } = await this.db.query(
        `SELECT to_regclass('public.jz_installed_apps') AS tbl`,
      );
      return rows[0]?.tbl != null;
    } catch {
      return false;
    }
  }

  async getSystemPanelIds(panelIds: string[]): Promise<string[]> {
    if (panelIds.length === 0) return [];
    const placeholders = panelIds.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.db.query(
      `SELECT id FROM jz_panels WHERE id IN (${placeholders}) AND category = 'system'`,
      panelIds,
    );
    return rows.map((r: { id: string }) => r.id);
  }

  async saveUserSidebar(userId: string, items: { panelId: string; visible: boolean; groupName: string; sortOrder: number; customName?: string; customIcon?: string }[]) {
    // Delete existing and re-insert
    await this.db.query('DELETE FROM jz_user_sidebar WHERE user_id = $1', [userId]);
    for (const item of items) {
      await this.db.query(
        `INSERT INTO jz_user_sidebar (user_id, panel_id, visible, group_name, sort_order, custom_name, custom_icon)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, item.panelId, item.visible, item.groupName || '', item.sortOrder, item.customName || null, item.customIcon || null],
      );
    }
  }

  async resetUserSidebar(userId: string) {
    await this.db.query('DELETE FROM jz_user_sidebar WHERE user_id = $1', [userId]);
  }

  // ===== Shortcuts =====

  async getUserShortcuts(userId: string, permissions: string[]): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT id, name, icon, type, target, sort_order as "sortOrder" FROM jz_shortcuts WHERE user_id = $1 ORDER BY sort_order',
      [userId],
    );
    if (rows.length === 0) {
      return this.getDefaultShortcuts(permissions);
    }
    if (rows.length === 1 && rows[0].id === '__empty__') {
      return [];
    }
    return rows;
  }

  private async getDefaultShortcuts(permissions: string[]): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT id, name, icon, permission FROM jz_panels WHERE is_builtin = FALSE ORDER BY sort_order',
    );
    const isAdmin = permissions.includes('sys:admin');
    return rows
      .filter((r: any) => !r.permission || permissions.includes(r.permission) || isAdmin)
      .map((r: any, i: number) => ({
        id: r.id, name: r.name, icon: r.icon, type: 'panel', target: r.id, sortOrder: i,
      }));
  }

  async saveUserShortcuts(userId: string, items: { id: string; name: string; icon: string; type: string; target: string; sortOrder: number }[]) {
    await this.db.query('DELETE FROM jz_shortcuts WHERE user_id = $1', [userId]);
    if (items.length === 0) {
      await this.db.query(
        'INSERT INTO jz_shortcuts (id, user_id, name, icon, type, target, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        ['__empty__', userId, '__empty__', '', 'marker', '__empty__', 0],
      );
      return;
    }
    for (const item of items) {
      await this.db.query(
        'INSERT INTO jz_shortcuts (id, user_id, name, icon, type, target, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [item.id, userId, item.name, item.icon, item.type, item.target, item.sortOrder],
      );
    }
  }

  async resetUserShortcuts(userId: string) {
    await this.db.query('DELETE FROM jz_shortcuts WHERE user_id = $1', [userId]);
  }

  // ===== Suggestions =====

  async getUserSuggestions(userId: string): Promise<{ text: string }[]> {
    const filePath = this.workspace.getUserFilePath(userId, 'suggestions.json');

    // Check cache (valid for 24h)
    if (fs.existsSync(filePath)) {
      try {
        const stat = fs.statSync(filePath);
        const ageMs = Date.now() - stat.mtimeMs;
        if (ageMs < 24 * 60 * 60 * 1000) {
          return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        }
      } catch {}
    }

    // Generate from recent messages
    const suggestions = await this.generateSuggestions(userId);
    if (suggestions.length > 0) {
      fs.writeFileSync(filePath, JSON.stringify(suggestions, null, 2), 'utf-8');
    }
    return suggestions;
  }

  saveUserSuggestions(userId: string, items: { text: string }[]) {
    const filePath = this.workspace.getUserFilePath(userId, 'suggestions.json');
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2), 'utf-8');
  }

  clearUserSuggestions(userId: string) {
    // Write empty array (not delete) so getUserSuggestions reads cache instead of regenerating
    const filePath = this.workspace.getUserFilePath(userId, 'suggestions.json');
    fs.writeFileSync(filePath, '[]', 'utf-8');
  }

  private async generateSuggestions(userId: string): Promise<{ text: string }[]> {
    // Get user messages from the last 2 days
    const { rows } = await this.db.query(
      `SELECT content FROM jz_messages m
       JOIN jz_sessions s ON s.id = m.session_id
       WHERE s.user_id = $1 AND m.role = 'user' AND m.created_at > NOW() - INTERVAL '2 days'
       ORDER BY m.created_at DESC LIMIT 50`,
      [userId],
    );

    if (rows.length === 0) return [];

    // Extract short, distinct questions/commands by frequency analysis
    const replyPatterns = /^(是的?|好的?|对的?|嗯+|ok|yes|no|不[是了]?|确认|取消|继续|请继续|可以|行|没问题|明白|知道了|谢谢|感谢|直接录入|先调整数据|\d{1,2})$/i;
    const seen = new Map<string, number>();
    for (const row of rows) {
      const text = (row.content || '').trim();
      if (!text || text.length > 30 || text.startsWith('[附件')) continue;
      // Normalize: strip leading/trailing punctuation
      const normalized = text.replace(/^[，。？！、]+|[，。？！、]+$/g, '').trim();
      if (normalized.length < 2) continue;
      // Skip reply-type messages (confirmations, short responses)
      if (replyPatterns.test(normalized)) continue;
      if (normalized.length < 5 && !/[？?]/.test(normalized)) continue;
      seen.set(normalized, (seen.get(normalized) || 0) + 1);
    }

    // Sort by frequency, take top 3
    const sorted = [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([text]) => ({ text }));

    // If not enough unique messages, take the most recent distinct ones
    if (sorted.length < 3) {
      const recent: { text: string }[] = [];
      const usedTexts = new Set(sorted.map(s => s.text));
      for (const row of rows) {
        const text = (row.content || '').trim();
        if (!text || text.length > 30 || text.startsWith('[附件') || usedTexts.has(text)) continue;
        const norm = text.replace(/^[，。？！、]+|[，。？！、]+$/g, '').trim();
        if (norm.length < 2 || replyPatterns.test(norm)) continue;
        if (norm.length < 5 && !/[？?]/.test(norm)) continue;
        usedTexts.add(text);
        recent.push({ text });
        if (sorted.length + recent.length >= 3) break;
      }
      sorted.push(...recent);
    }

    return sorted;
  }
}
