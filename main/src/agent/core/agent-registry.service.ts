import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WorkspaceService } from '../../workspace/workspace.service';
import type { InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import { ResourceMetaService } from '../../platform/authz/resource-meta.service';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';

export interface MessageDisplayConfig {
  toolProcess?: boolean;
  toolResult?: boolean;
  sourceRef?: boolean;
}

export interface AgentContextConfig {
  maxToolOutputChars?: number;   // Per-agent override for L1 tool output limit
  keepRecentTurns?: number;      // Number of recent turns to preserve during pruning (default 2)
  compactionStrategy?: 'clear' | 'summarize';  // L2 pruning: clear tool results vs LLM summarize
}

export interface AgentSessionConfig {
  reuseWindowMinutes?: number;   // #2: per-agent session reuse window (default 10). Longer-running
                                 // agents (skill_master/connector_master) need a wider window.
}

export interface AgentDelegationEntry {
  targetAgent: string;
  description: string;
  keywords: string[];
}

export interface AgentDef {
  id: string;
  name: string;
  icon: string;
  description: string;
  modelLevel: 'default' | 'coding' | 'reasoning' | 'summary';
  builtin: boolean;
  soul: string;
  tools: string[];
  defaultPanel?: string;
  messageDisplay?: MessageDisplayConfig;
  loadKnowledge?: boolean;
  context?: AgentContextConfig;
  sessionConfig?: AgentSessionConfig;
  promptEnhancer?: { builtin: string };
  agentDelegation?: AgentDelegationEntry[];
  // ── P1 运行期字段（meta join 得出，不落 YAML）──
  scope?: 'global' | 'user';
  ownerUserId?: string;
  canEdit?: boolean;
}

@Injectable()
export class AgentRegistryService {
  private readonly logger = new Logger(AgentRegistryService.name);
  private agents = new Map<string, AgentDef>();

  constructor(
    private readonly workspace: WorkspaceService,
    // P1：可选注入——authz 未接线（测试直构）时保持旧行为
    @Optional() private readonly meta?: ResourceMetaService,
    @Optional() private readonly access?: ResourceAccessService,
  ) {
    this.loadAll();
  }

  loadAll() {
    this.agents.clear();
    if (!fs.existsSync(this.workspace.getAgentsDir())) {
      fs.mkdirSync(this.workspace.getAgentsDir(), { recursive: true });
      return;
    }

    // 跳过以 . 开头的隐藏文件（macOS AppleDouble 元数据 ._*.yaml 是二进制内容，解析必然报 "null byte" 错误）
    const files = fs.readdirSync(this.workspace.getAgentsDir())
      .filter(f => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.startsWith('.'));
    for (const file of files) {
      try {
        const raw = yaml.load(fs.readFileSync(path.join(this.workspace.getAgentsDir(), file), 'utf-8')) as any;
        const a = raw.agent || raw;
        const def: AgentDef = {
          id: a.id || file.replace(/\.ya?ml$/, ''),
          name: a.name || a.id,
          icon: a.icon || '🤖',
          description: a.description || '',
          modelLevel: a.modelLevel || 'default',
          builtin: a.builtin ?? false,
          soul: a.soul || '',
          tools: a.tools || [],
          defaultPanel: a.defaultPanel || undefined,
          messageDisplay: a.messageDisplay || undefined,
          loadKnowledge: a.loadKnowledge ?? true,
          context: a.context || undefined,
          sessionConfig: a.sessionConfig || undefined,
          promptEnhancer: a.promptEnhancer || undefined,
          agentDelegation: a.agentDelegation || undefined,
        };
        this.agents.set(def.id, def);
        this.logger.log(`Loaded agent: ${def.id} (${def.name}) [${def.tools.length} tools]`);
      } catch (err: any) {
        this.logger.error(`Failed to load agent ${file}: ${err.message}`);
      }
    }
    this.logger.log(`Total: ${this.agents.size} agents loaded`);
  }

  getAll(): AgentDef[] {
    return Array.from(this.agents.values());
  }

  /**
   * 按 principal 过滤的列表（P1）：visible + scope/ownerUserId/canEdit 注解。
   * main 智能体由 ResourceAccessService 硬例外强制保留。
   */
  async getAllForPrincipal(p: InvocationPrincipal): Promise<AgentDef[]> {
    if (!this.access) return this.getAll();
    return this.access.annotateEditable('agent', this.getAll(), a => a.id, p);
  }

  /**
   * 分配新 agent id（P1）：普通用户强制 `u_{shortUserId}_{slug}` 前缀防抢占全局命名空间；
   * 与内存表/磁盘文件双方冲突 → 409，绝不覆盖既有 YAML。
   */
  allocateAgentId(requested: string | undefined, actor?: InvocationPrincipal): string {
    const slug = (requested || 'agent').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
    const isAdmin = !!actor?.permissions.includes('sys:admin');
    let id = slug;
    if (!isAdmin && actor?.userId) {
      const short = actor.userId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8) || 'u';
      id = `u_${short}_${slug}`;
    }
    const filePath = path.join(this.workspace.getAgentsDir(), `${id}.yaml`);
    if (this.agents.has(id) || fs.existsSync(filePath)) {
      throw new ConflictException(`智能体 ID 已被占用: ${id}`);
    }
    return id;
  }

  get(id: string): AgentDef | undefined {
    return this.agents.get(id);
  }

  // ── APP agent 归属（T2/P3）：agentId → owner appId，供工具链注入 APP 身份 ──
  private readonly agentOwners = new Map<string, string>();

  /** 幂等重建某 APP 的 agent 归属（激活/升级时调用） */
  setAgentOwnersForApp(appId: string, agentIds: string[]): void {
    this.clearAgentOwnersForApp(appId);
    for (const id of agentIds) this.agentOwners.set(id, appId);
  }

  clearAgentOwnersForApp(appId: string): void {
    for (const [id, owner] of [...this.agentOwners]) {
      if (owner === appId) this.agentOwners.delete(id);
    }
  }

  /** agent 的归属 APP（内置 agent 返回 undefined） */
  getOwnerAppId(agentId: string): string | undefined {
    return this.agentOwners.get(agentId);
  }

  /**
   * 保存 agent（P1：改为 async）。新建时若带 actor 且 authz 已接线，写归属 meta：
   * 普通用户 → scope='user'/owner=自己；admin → scope='global'。均 default_visibility='none'。
   */
  async save(def: AgentDef, actor?: InvocationPrincipal) {
    const isNew = !this.agents.has(def.id);
    const filePath = path.join(this.workspace.getAgentsDir(), `${def.id}.yaml`);
    const content = yaml.dump({ agent: {
      id: def.id,
      name: def.name,
      icon: def.icon,
      description: def.description,
      modelLevel: def.modelLevel,
      builtin: def.builtin,
      tools: def.tools,
      soul: def.soul,
      ...(def.defaultPanel ? { defaultPanel: def.defaultPanel } : {}),
      ...(def.messageDisplay ? { messageDisplay: def.messageDisplay } : {}),
      ...(def.loadKnowledge !== undefined && def.loadKnowledge !== true ? { loadKnowledge: def.loadKnowledge } : {}),
      ...(def.sessionConfig ? { sessionConfig: def.sessionConfig } : {}),
    }}, { lineWidth: 120 });
    fs.writeFileSync(filePath, content, 'utf-8');
    this.agents.set(def.id, def);
    if (isNew && actor && this.meta) {
      const isAdmin = actor.permissions.includes('sys:admin');
      await this.meta.upsert({
        resourceType: 'agent', resourceId: def.id,
        scope: isAdmin ? 'global' : 'user',
        ownerUserId: isAdmin ? undefined : actor.userId,
        builtin: def.builtin, defaultVisibility: 'none',
        createdBy: actor.userId,
      });
    }
    this.logger.log(`Saved agent: ${def.id}`);
  }

  /** 删除（P1：async，连带清理 meta/grants） */
  async delete(id: string): Promise<boolean> {
    const def = this.agents.get(id);
    if (!def || def.builtin) return false;
    const filePath = path.join(this.workspace.getAgentsDir(), `${id}.yaml`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    this.agents.delete(id);
    if (this.meta) await this.meta.remove('agent', id);
    this.logger.log(`Deleted agent: ${id}`);
    return true;
  }
}
