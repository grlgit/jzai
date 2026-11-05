import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import type { InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import { ResourceMetaService, ResourceType, ALWAYS_VISIBLE_AGENTS } from './resource-meta.service';
import { ResourceGrantService } from './resource-grant.service';

export { ALWAYS_VISIBLE_AGENTS };

/**
 * 资源访问判定门面——所有能力注册表/controller 只依赖本服务，不直接查表。
 * 真值表见 docs/rework-2026H2/design-p1-authz.md §3.3：
 *   - main 智能体全员可见（硬例外）
 *   - admin：global 可见可编辑可授权；他人 user 类资源可见但不可编辑不可授权
 *   - owner：自己的 user 类资源全权（编辑 + 分享）
 *   - 其他人：按 grants / default_visibility 判定可见，不可编辑
 *
 * 回滚开关：AUTHZ_ENFORCE=0 时 canView 恒 true、canEdit 回落旧逻辑（admin 判定），
 * 表和数据保留——生产回滚不回滚迁移。
 */
@Injectable()
export class ResourceAccessService {
  private readonly logger = new Logger(ResourceAccessService.name);

  constructor(
    private readonly meta: ResourceMetaService,
    private readonly grants: ResourceGrantService,
  ) {}

  private get enforced(): boolean {
    return process.env.AUTHZ_ENFORCE !== '0';
  }

  /** 回滚开关读取（T1.9 buildForAgent 兜底过滤等运行期判定用） */
  isEnforced(): boolean {
    return this.enforced;
  }

  private isAdmin(p: InvocationPrincipal): boolean {
    return p.permissions.includes('sys:admin');
  }

  /**
   * system/service 主体（定时器、APP 服务主体、dev-mcp）：有独立授权链，资源过滤对其放行。
   * 'delegated'（代表用户的委派调用）仍按用户过滤。
   */
  isSystemPrincipal(p: InvocationPrincipal): boolean {
    return p.type === 'system' || p.type === 'service' || p.type === 'dev-mcp' || p.origin === 'scheduler';
  }

  async canView(t: ResourceType, id: string, p: InvocationPrincipal): Promise<boolean> {
    if (!this.enforced) return true;
    if (t === 'agent' && ALWAYS_VISIBLE_AGENTS.includes(id)) return true;
    if (this.isSystemPrincipal(p)) return true;
    if (this.isAdmin(p)) return true;

    const m = await this.meta.get(t, id);
    if (!m) return false; // 无 meta 的异常态 fail-closed（admin 已在上面放行）
    if (m.defaultVisibility === 'all') return true;
    if (m.scope === 'user' && m.ownerUserId === p.userId) return true;
    return this.grants.hasGrant(t, id, p);
  }

  /**
   * 面板配对场景可见性：meta 缺失 = 未纳管（APP 动态 agent 等从未回填的资源），
   * 保持旧行为放行；meta 存在则按真值表判定（connector_master 'none' → 普通用户不可见）。
   */
  async canViewOrUnmanaged(t: ResourceType, id: string, p: InvocationPrincipal): Promise<boolean> {
    if (await this.canView(t, id, p)) return true;
    return !(await this.meta.get(t, id));
  }

  async canEdit(t: ResourceType, id: string, p: InvocationPrincipal): Promise<boolean> {
    if (!this.enforced) return this.isAdmin(p);
    const m = await this.meta.get(t, id);
    if (m?.scope === 'user') {
      // 用户类资源：仅 owner 可编辑——admin 可见但不可编辑（需求明确）
      return m.ownerUserId === p.userId;
    }
    // 全局类资源：仅 admin 可编辑
    return this.isAdmin(p);
  }

  async canGrant(t: ResourceType, id: string, p: InvocationPrincipal): Promise<boolean> {
    if (!this.enforced) return this.isAdmin(p);
    const m = await this.meta.get(t, id);
    if (m?.scope === 'user') {
      // 用户类资源：仅 owner 可分享——admin 不可授权（需求明确）
      return m.ownerUserId === p.userId;
    }
    return this.isAdmin(p);
  }

  /**
   * 批量可见性过滤（列表接口统一走这里，防 N+1）：
   * 一次 getMany + 一次 visibleIds，总计常数次 SQL。
   */
  async filterVisible<T>(t: ResourceType, items: T[], idOf: (x: T) => string, p: InvocationPrincipal): Promise<T[]> {
    if (!this.enforced || items.length === 0) return items;
    if (this.isSystemPrincipal(p) || this.isAdmin(p)) return items;

    const ids = items.map(idOf);
    const [metas, granted] = await Promise.all([
      this.meta.getMany(t, ids),
      this.grants.visibleIds(t, p),
    ]);

    return items.filter(item => {
      const id = idOf(item);
      if (t === 'agent' && ALWAYS_VISIBLE_AGENTS.includes(id)) return true;
      const m = metas.get(id);
      if (!m) return false; // fail-closed
      if (m.defaultVisibility === 'all') return true;
      if (m.scope === 'user' && m.ownerUserId === p.userId) return true;
      return granted.has(id);
    });
  }

  /**
   * filterVisible + 归属/可编辑注解（列表接口给前端渲染用）。
   * meta 一次 getMany 批量读；canEdit 语义与 canEdit() 完全一致（真值表同一出处）。
   */
  async annotateEditable<T extends object>(
    t: ResourceType, items: T[], idOf: (x: T) => string, p: InvocationPrincipal,
  ): Promise<Array<T & { scope?: 'global' | 'user'; ownerUserId?: string; canEdit?: boolean }>> {
    const visible = await this.filterVisible(t, items, idOf, p);
    const metas = await this.meta.getMany(t, visible.map(idOf));
    const admin = this.isAdmin(p);
    return visible.map(item => {
      const m = metas.get(idOf(item));
      const canEdit = !this.enforced
        ? admin
        : (m?.scope === 'user' ? m.ownerUserId === p.userId : admin);
      return { ...item, scope: m?.scope, ownerUserId: m?.ownerUserId, canEdit };
    });
  }

  async assertCanEdit(t: ResourceType, id: string, p: InvocationPrincipal): Promise<void> {
    if (!(await this.canEdit(t, id, p))) {
      this.logger.warn(`Edit denied: ${t}/${id} by ${p.userId ?? p.principalId}`);
      throw new ForbiddenException(`无权编辑该${this.typeLabel(t)}`);
    }
  }

  async assertCanGrant(t: ResourceType, id: string, p: InvocationPrincipal): Promise<void> {
    if (!(await this.canGrant(t, id, p))) {
      this.logger.warn(`Grant denied: ${t}/${id} by ${p.userId ?? p.principalId}`);
      throw new ForbiddenException(`无权授权该${this.typeLabel(t)}`);
    }
  }

  private typeLabel(t: ResourceType): string {
    const labels: Record<ResourceType, string> = {
      agent: '智能体', skill: '技能', connector: '连接', tool: '工具', panel: '面板', app: '应用',
    };
    return labels[t] || '资源';
  }
}
