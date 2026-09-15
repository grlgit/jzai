import { Injectable, Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { EditionService } from '../../edition/edition.service';
import { randomUUID } from 'crypto';

export interface CoWorkerCapabilities {
  builtin: string[];
  mcp: Array<{ serverId: string; serverName?: string; tools: string[] }>;
  skills: string[];
}

export interface CoWorker {
  id: string;
  name: string;
  description: string;
  avatarUrl: string;
  soul: string;
  modelLevel: string;
  tools: string[];
  skills: string[];
  mcpServers: string[];
  capabilities: CoWorkerCapabilities;
  workScope: string;
  configOverrides: Record<string, any>;
  wechatConfig: Record<string, any>;
  kbBindings: string[];
  status: string;
  createdBy: string;
  buildVersion: number;
  configVersion: number;
  lastBuildAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CoWorkerAssignment {
  id: string;
  coworkerId: string;
  userId: string;
  dockerTag: string;
  status: string;
  lastSeen: Date | null;
  configVersion: number;
  createdAt: Date;
  // API Key fields
  apiKey?: string;
  apiKeyCreatedAt?: Date | null;
  apiKeyRevokedAt?: Date | null;
  // joined fields
  userName?: string;
  userEmail?: string;
  coworkerName?: string;
  // enrollment fields (Windows app)
  enrollToken?: string;
  enrolledAt?: Date | null;
  enrollCount?: number;
  enrollIp?: string;
  enrollUserAgent?: string;
  // soul sync fields
  syncStatus?: string;
  lastSyncAt?: Date | null;
}

@Injectable()
export class CoWorkerService {
  private readonly logger = new Logger(CoWorkerService.name);

  constructor(
    private readonly db: DbService,
    @Optional() @Inject(forwardRef(() => EditionService)) private readonly edition?: EditionService,
  ) {}

  // ===== CoWorker CRUD =====

  async create(data: {
    name: string;
    description?: string;
    avatarUrl?: string;
    soul?: string;
    modelLevel?: string;
    tools?: string[];
    skills?: string[];
    mcpServers?: string[];
    capabilities?: CoWorkerCapabilities;
    workScope?: string;
    configOverrides?: Record<string, any>;
    wechatConfig?: Record<string, any>;
    kbBindings?: string[];
    createdBy: string;
  }): Promise<CoWorker> {
    const id = randomUUID();
    await this.db.query(
      `INSERT INTO jz_coworkers (id, name, description, avatar_url, soul, model_level, tools, skills, mcp_servers, work_scope, config_overrides, wechat_config, kb_bindings, created_by, capabilities)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        id, data.name, data.description || '', data.avatarUrl || '',
        data.soul || '', data.modelLevel || 'default',
        JSON.stringify(data.tools || []), JSON.stringify(data.skills || []),
        JSON.stringify(data.mcpServers || []), data.workScope || '',
        JSON.stringify(data.configOverrides || {}), JSON.stringify(data.wechatConfig || {}),
        JSON.stringify(data.kbBindings || []), data.createdBy,
        JSON.stringify(data.capabilities || { builtin: [], mcp: [], skills: [] }),
      ],
    );
    this.logger.log(`CoWorker created: ${id} (${data.name})`);
    return this.getById(id) as Promise<CoWorker>;
  }

  async getById(id: string): Promise<CoWorker | null> {
    const { rows } = await this.db.query(
      `SELECT id, name, description, avatar_url, soul, model_level, tools, skills, mcp_servers, capabilities,
              work_scope, config_overrides, wechat_config, kb_bindings, status, created_by, created_at, updated_at
       FROM jz_coworkers WHERE id = $1`,
      [id],
    );
    return rows[0] ? this.mapCoWorker(rows[0]) : null;
  }

  async list(filters?: { status?: string; createdBy?: string }): Promise<CoWorker[]> {
    let sql = 'SELECT * FROM jz_coworkers WHERE 1=1';
    const params: any[] = [];
    if (filters?.status) {
      params.push(filters.status);
      sql += ` AND status = $${params.length}`;
    }
    if (filters?.createdBy) {
      params.push(filters.createdBy);
      sql += ` AND created_by = $${params.length}`;
    }
    sql += ' ORDER BY updated_at DESC';
    const { rows } = await this.db.query(sql, params);
    return rows.map(r => this.mapCoWorker(r));
  }

  async update(id: string, data: Partial<{
    name: string; description: string; avatarUrl: string; soul: string;
    modelLevel: string; tools: string[]; skills: string[]; mcpServers: string[];
    capabilities: CoWorkerCapabilities;
    workScope: string; configOverrides: Record<string, any>; wechatConfig: Record<string, any>;
    kbBindings: string[];
  }>): Promise<CoWorker | null> {
    const sets: string[] = [];
    const params: any[] = [];
    const addSet = (col: string, val: any) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (data.name !== undefined) addSet('name', data.name);
    if (data.description !== undefined) addSet('description', data.description);
    if (data.avatarUrl !== undefined) addSet('avatar_url', data.avatarUrl);
    if (data.soul !== undefined) addSet('soul', data.soul);
    if (data.modelLevel !== undefined) addSet('model_level', data.modelLevel);
    if (data.tools !== undefined) addSet('tools', JSON.stringify(data.tools));
    if (data.skills !== undefined) addSet('skills', JSON.stringify(data.skills));
    if (data.mcpServers !== undefined) addSet('mcp_servers', JSON.stringify(data.mcpServers));
    if (data.capabilities !== undefined) addSet('capabilities', JSON.stringify(data.capabilities));
    if (data.workScope !== undefined) addSet('work_scope', data.workScope);
    if (data.configOverrides !== undefined) addSet('config_overrides', JSON.stringify(data.configOverrides));
    if (data.wechatConfig !== undefined) addSet('wechat_config', JSON.stringify(data.wechatConfig));
    if (data.kbBindings !== undefined) addSet('kb_bindings', JSON.stringify(data.kbBindings));

    if (sets.length === 0) return this.getById(id);

    sets.push('updated_at = NOW()');
    sets.push('config_version = COALESCE(config_version, 1) + 1');
    params.push(id);
    await this.db.query(`UPDATE jz_coworkers SET ${sets.join(', ')} WHERE id = $${params.length}`, params);

    // Bump config_version on all assignments for hot-reload
    await this.db.query(
      'UPDATE jz_coworker_assignments SET config_version = config_version + 1 WHERE coworker_id = $1',
      [id],
    );

    this.invalidateToolsCache(id);
    this.logger.log(`CoWorker updated: ${id}`);
    return this.getById(id);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM jz_coworkers WHERE id = $1', [id]);
    if (rowCount && rowCount > 0) {
      this.logger.log(`CoWorker deleted: ${id}`);
      return true;
    }
    return false;
  }

  async publish(id: string): Promise<CoWorker | null> {
    await this.db.query("UPDATE jz_coworkers SET status = 'published', updated_at = NOW() WHERE id = $1", [id]);
    return this.getById(id);
  }

  async markBuilt(id: string): Promise<void> {
    await this.db.query(
      'UPDATE jz_coworkers SET build_version = COALESCE(config_version, 1), last_build_at = NOW() WHERE id = $1',
      [id],
    );
  }

  // ===== Assignments =====

  async assign(coworkerId: string, userId: string): Promise<CoWorkerAssignment> {
    // Edition-based assignment limit
    if (this.edition) {
      const { rows } = await this.db.query('SELECT COUNT(*)::int as cnt FROM jz_coworker_assignments');
      this.edition.checkCoWorkerLimit(rows[0]?.cnt || 0);
    }

    const id = randomUUID();
    await this.db.query(
      'INSERT INTO jz_coworker_assignments (id, coworker_id, user_id) VALUES ($1, $2, $3)',
      [id, coworkerId, userId],
    );
    this.logger.log(`CoWorker ${coworkerId} assigned to user ${userId}`);
    return this.getAssignment(id) as Promise<CoWorkerAssignment>;
  }

  async unassign(coworkerId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM jz_coworker_assignments WHERE coworker_id = $1 AND user_id = $2',
      [coworkerId, userId],
    );
    return (rowCount ?? 0) > 0;
  }

  async getAssignment(id: string): Promise<CoWorkerAssignment | null> {
    const { rows } = await this.db.query(
      `SELECT a.*, u.name as user_name, u.email as user_email, c.name as coworker_name
       FROM jz_coworker_assignments a
       JOIN jz_users u ON u.id = a.user_id
       JOIN jz_coworkers c ON c.id = a.coworker_id
       WHERE a.id = $1`,
      [id],
    );
    return rows[0] ? this.mapAssignment(rows[0]) : null;
  }

  async listAssignments(coworkerId: string): Promise<CoWorkerAssignment[]> {
    const { rows } = await this.db.query(
      `SELECT a.*, u.name as user_name, u.email as user_email, c.name as coworker_name
       FROM jz_coworker_assignments a
       JOIN jz_users u ON u.id = a.user_id
       JOIN jz_coworkers c ON c.id = a.coworker_id
       WHERE a.coworker_id = $1
       ORDER BY a.created_at DESC`,
      [coworkerId],
    );
    return rows.map(r => this.mapAssignment(r));
  }

  async getMyCoWorkers(userId: string): Promise<Array<CoWorkerAssignment & { coworker: CoWorker }>> {
    const { rows } = await this.db.query(
      `SELECT a.*, c.*,
              a.id as assignment_id, a.status as assignment_status, a.created_at as assignment_created_at,
              c.id as coworker_id, c.status as coworker_status, c.created_at as coworker_created_at
       FROM jz_coworker_assignments a
       JOIN jz_coworkers c ON c.id = a.coworker_id
       WHERE a.user_id = $1 AND c.status = 'published'
       ORDER BY a.created_at DESC`,
      [userId],
    );
    return rows.map(r => ({
      ...this.mapAssignment({
        ...r,
        id: r.assignment_id,
        status: r.assignment_status,
        created_at: r.assignment_created_at,
      }),
      coworker: this.mapCoWorker({
        ...r,
        id: r.coworker_id,
        status: r.coworker_status,
        created_at: r.coworker_created_at,
      }),
    }));
  }

  async updateHeartbeat(assignmentId: string): Promise<void> {
    await this.db.query(
      "UPDATE jz_coworker_assignments SET last_seen = NOW(), status = 'active' WHERE id = $1",
      [assignmentId],
    );
  }

  // ===== Tool Authorization (with TTL cache) =====

  private toolsCache = new Map<string, { tools: string[]; expiry: number }>();
  private coworkerAssignments = new Map<string, Set<string>>();
  private static readonly TOOLS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async getAuthorizedTools(assignmentId: string): Promise<string[]> {
    const cached = this.toolsCache.get(assignmentId);
    if (cached && cached.expiry > Date.now()) return cached.tools;

    const { rows } = await this.db.query(
      `SELECT a.coworker_id, c.tools FROM jz_coworker_assignments a JOIN jz_coworkers c ON c.id = a.coworker_id WHERE a.id = $1`,
      [assignmentId],
    );
    const tools = this.safeParseJson(rows[0]?.tools, []);
    this.toolsCache.set(assignmentId, { tools, expiry: Date.now() + CoWorkerService.TOOLS_CACHE_TTL });

    // Maintain reverse index for targeted invalidation
    const coworkerId = rows[0]?.coworker_id;
    if (coworkerId) {
      let set = this.coworkerAssignments.get(coworkerId);
      if (!set) {
        set = new Set<string>();
        this.coworkerAssignments.set(coworkerId, set);
      }
      set.add(assignmentId);
    }

    return tools;
  }

  /** Invalidate tools cache when CoWorker is updated */
  invalidateToolsCache(coworkerId?: string) {
    if (coworkerId) {
      const assignments = this.coworkerAssignments.get(coworkerId);
      if (assignments) {
        for (const assignmentId of assignments) {
          this.toolsCache.delete(assignmentId);
        }
        this.coworkerAssignments.delete(coworkerId);
      }
    } else {
      this.toolsCache.clear();
      this.coworkerAssignments.clear();
    }
  }

  // ===== Assignment Resolution =====

  async resolveAssignmentId(userId: string, coworkerId?: string): Promise<string | null> {
    if (coworkerId) {
      const { rows } = await this.db.query(
        'SELECT id FROM jz_coworker_assignments WHERE coworker_id = $1 AND user_id = $2',
        [coworkerId, userId],
      );
      if (rows[0]) return rows[0].id;
    }

    // Fallback: 当没有 coworkerId 时，尝试查找用户的活跃分配
    // 这是为了向后兼容旧版 JWT token（不包含 coworkerId）
    // 只在用户只有一个活跃分配时使用，避免歧义
    const { rows: activeAssignments } = await this.db.query(
      `SELECT a.id, a.coworker_id, c.name as coworker_name
       FROM jz_coworker_assignments a
       JOIN jz_coworkers c ON c.id = a.coworker_id
       WHERE a.user_id = $1
       AND c.status = 'published'
       ORDER BY a.created_at DESC`,
      [userId],
    );

    // 如果只有一个活跃分配，使用它
    if (activeAssignments.length === 1) {
      this.logger.log(`[Assignment Resolution] Using single active assignment ${activeAssignments[0].id} for user ${userId} (coworker: ${activeAssignments[0].coworker_name})`);
      return activeAssignments[0].id;
    }

    // 如果有多个活跃分配，无法自动选择
    if (activeAssignments.length > 1) {
      this.logger.warn(`[Assignment Resolution] User ${userId} has ${activeAssignments.length} active assignments, cannot auto-select`);
    }

    return null;
  }

  /**
   * Enroll a Windows app with an enrollment token.
   * The token is either the assignment ID or a dedicated enroll_token.
   * Returns the CoWorker configuration and extension list.
   * Implements rate limiting (enroll_count) and one-time enrollment tracking.
   */
  async enroll(token: string, ip?: string, userAgent?: string): Promise<{
    assignmentId: string;
    apiKey: string;
    coworker: CoWorker;
    user: { id: string; name: string; email: string };
  } | null> {
    if (!token) return null;

    // 显式列名 + 别名，避免 a.id 与 c.id 重叠导致 assignmentId 被 coworkerId 覆盖。
    const assignmentColumns = `
      a.id as assignment_id,
      a.coworker_id,
      a.user_id,
      a.api_key,
      a.api_key_created_at,
      a.api_key_revoked_at,
      a.status as assignment_status,
      a.enroll_token,
      a.enrolled_at,
      a.enroll_count,
      a.enroll_ip,
      a.enroll_user_agent,
      a.config_version,
      a.sync_status,
      a.last_sync_at,
      a.last_sync_error,
      a.sync_retry_count,
      a.onboarding_state,
      u.name as user_name,
      u.email as user_email,
      c.*
    `;

    // Try to find assignment by enroll_token (dedicated enrollment token)
    const { rows: byToken } = await this.db.query(
      `SELECT ${assignmentColumns}
       FROM jz_coworker_assignments a
       JOIN jz_users u ON u.id = a.user_id
       JOIN jz_coworkers c ON c.id = a.coworker_id
       WHERE a.enroll_token = $1 AND c.status = 'published'`,
      [token],
    );
    if (byToken[0]) {
      await this.recordEnrollment(byToken[0].assignment_id, ip, userAgent);
      return {
        assignmentId: byToken[0].assignment_id,
        apiKey: await this.ensureValidApiKey(byToken[0].assignment_id, byToken[0].api_key),
        coworker: this.mapCoWorker(byToken[0]),
        user: { id: byToken[0].user_id, name: byToken[0].user_name, email: byToken[0].user_email },
      };
    }

    // Fallback: try to find assignment by ID (for development/testing)
    const { rows: byId } = await this.db.query(
      `SELECT ${assignmentColumns}
       FROM jz_coworker_assignments a
       JOIN jz_users u ON u.id = a.user_id
       JOIN jz_coworkers c ON c.id = a.coworker_id
       WHERE a.id = $1 AND c.status = 'published'`,
      [token],
    );
    if (byId[0]) {
      await this.recordEnrollment(byId[0].assignment_id, ip, userAgent);
      return {
        assignmentId: byId[0].assignment_id,
        apiKey: await this.ensureValidApiKey(byId[0].assignment_id, byId[0].api_key),
        coworker: this.mapCoWorker(byId[0]),
        user: { id: byId[0].user_id, name: byId[0].user_name, email: byId[0].user_email },
      };
    }

    return null;
  }

  /**
   * Ensure an assignment has an API key (for backward compatibility).
   * Generate one if missing.
   */
  private async ensureApiKey(assignmentId: string): Promise<string> {
    const apiKey = `jw_${require('crypto').randomBytes(32).toString('hex')}`;
    await this.db.query(
      'UPDATE jz_coworker_assignments SET api_key = $1, api_key_created_at = NOW() WHERE id = $2',
      [apiKey, assignmentId]
    );
    this.logger.log(`Generated API key for existing assignment: ${assignmentId}`);
    return apiKey;
  }

  /**
   * Ensure the stored API key is valid (jw_ format). If it is missing or an
   * old user JWT, rotate to a fresh jw_ key.
   */
  private async ensureValidApiKey(assignmentId: string, existingKey?: string | null): Promise<string> {
    if (existingKey && existingKey.startsWith('jw_') && existingKey.length === 67) {
      return existingKey;
    }
    if (existingKey && existingKey.startsWith('eyJ')) {
      this.logger.warn(`Assignment ${assignmentId} had legacy JWT in api_key column, rotating to jw_ key`);
    }
    return this.ensureApiKey(assignmentId);
  }

  /**
   * Generate a unique enrollment token for an assignment.
   * This token is used for Windows app enrollment.
   */
  async generateEnrollToken(assignmentId: string): Promise<string | null> {
    const assignment = await this.getAssignment(assignmentId);
    if (!assignment) return null;

    // Check if already has a token
    if (assignment.enrollToken) {
      return assignment.enrollToken;
    }

    // Generate unique token
    const token = this.generateUniqueToken();
    await this.db.query(
      'UPDATE jz_coworker_assignments SET enroll_token = $1 WHERE id = $2',
      [token, assignmentId],
    );
    return token;
  }

  /**
   * Record enrollment event (rate tracking).
   */
  private async recordEnrollment(assignmentId: string, ip?: string, userAgent?: string): Promise<void> {
    await this.db.query(
      `UPDATE jz_coworker_assignments
       SET enrolled_at = COALESCE(enrolled_at, NOW()),
           enroll_count = COALESCE(enroll_count, 0) + 1,
           enroll_ip = $1,
           enroll_user_agent = $2
       WHERE id = $3`,
      [ip || null, userAgent || null, assignmentId],
    );
  }

  private generateUniqueToken(): string {
    // Generate a 12-character alphanumeric token
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No O, 0, I, 1 to avoid confusion
    let token = '';
    for (let i = 0; i < 12; i++) {
      token += chars[Math.floor(Math.random() * chars.length)];
    }
    return token;
  }

  // ===== Message/Event Recording =====

  async recordMessages(assignmentId: string, messages: Array<{ channel?: string; direction: string; content?: string; metadata?: any; createdAt?: string }>): Promise<number> {
    if (messages.length > 100) throw new Error('单次上报不超过100条');
    let count = 0;
    for (const msg of messages) {
      if (msg.content && msg.content.length > 10000) msg.content = msg.content.slice(0, 10000);
      await this.db.query(
        'INSERT INTO jz_coworker_messages (id, assignment_id, channel, direction, content, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), assignmentId, msg.channel || 'web', msg.direction, msg.content || '', JSON.stringify(msg.metadata || {}), msg.createdAt || new Date()],
      );
      count++;
    }
    return count;
  }

  async recordEvent(assignmentId: string, eventType: string, payload: any = {}): Promise<void> {
    await this.db.query(
      'INSERT INTO jz_coworker_events (id, assignment_id, event_type, payload) VALUES ($1,$2,$3,$4)',
      [randomUUID(), assignmentId, eventType, JSON.stringify(payload)],
    );
  }

  // ===== Helpers =====

  private safeParseJson<T>(value: any, fallback: T): T {
    if (value === null || value === undefined) return fallback;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return fallback; }
  }

  private mapCoWorker(row: any): CoWorker {
    return {
      id: row.id,
      name: row.name,
      description: row.description || '',
      avatarUrl: row.avatar_url || '',
      soul: row.soul || '',
      modelLevel: row.model_level || 'default',
      tools: this.safeParseJson(row.tools, []),
      skills: this.safeParseJson(row.skills, []),
      mcpServers: this.safeParseJson(row.mcp_servers, []),
      capabilities: this.safeParseJson(row.capabilities, { builtin: [], mcp: [], skills: [] }),
      workScope: row.work_scope || '',
      configOverrides: this.safeParseJson(row.config_overrides, {}),
      wechatConfig: this.safeParseJson(row.wechat_config, {}),
      kbBindings: this.safeParseJson(row.kb_bindings, []),
      status: row.status || 'draft',
      createdBy: row.created_by || '',
      buildVersion: Number(row.build_version || 0),
      configVersion: Number(row.config_version || 1),
      lastBuildAt: row.last_build_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private mapAssignment(row: any): CoWorkerAssignment {
    return {
      id: row.id,
      coworkerId: row.coworker_id,
      userId: row.user_id,
      dockerTag: row.docker_tag || '',
      status: row.status || 'pending',
      lastSeen: row.last_seen || null,
      configVersion: row.config_version || 1,
      apiKey: row.api_key,
      apiKeyCreatedAt: row.api_key_created_at || null,
      apiKeyRevokedAt: row.api_key_revoked_at || null,
      createdAt: row.created_at,
      userName: row.user_name,
      userEmail: row.user_email,
      coworkerName: row.coworker_name,
      enrollToken: row.enroll_token,
      enrolledAt: row.enrolled_at,
      enrollCount: row.enroll_count || 0,
      enrollIp: row.enroll_ip,
      enrollUserAgent: row.enroll_user_agent,
      syncStatus: row.sync_status || 'idle',
      lastSyncAt: row.last_sync_at || null,
    };
  }

  // ===== Soul Sync Optimization =====

  /**
   * 记录Soul同步历史
   */
  async recordSoulSync(
    coworkerId: string,
    assignmentId: string,
    oldSoul: string,
    newSoul: string,
    oldVersion: number,
    newVersion: number,
    triggerSource: string = 'admin',
    triggeredBy?: string,
  ): Promise<string> {
    const { randomUUID } = await import('crypto');
    const syncId = randomUUID();

    await this.db.query(`
      INSERT INTO jz_soul_sync_history
        (id, coworker_id, assignment_id, old_soul, new_soul, old_version, new_version, sync_status, trigger_source, triggered_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [syncId, coworkerId, assignmentId, oldSoul, newSoul, oldVersion, newVersion, 'pushing', triggerSource, triggeredBy || null]);

    return syncId;
  }

  /**
   * 完成Soul同步记录
   */
  async completeSoulSync(
    syncId: string,
    success: boolean,
    errorMessage?: string,
  ): Promise<void> {
    const syncStatus = success ? 'success' : 'failed';
    const completedAt = new Date();

    // 计算持续时间
    const { rows } = await this.db.query(`
      SELECT started_at FROM jz_soul_sync_history WHERE id = $1
    `, [syncId]);

    let durationMs: number | null = null;
    if (rows.length > 0) {
      const startedAt = new Date(rows[0].started_at);
      durationMs = completedAt.getTime() - startedAt.getTime();
    }

    await this.db.query(`
      UPDATE jz_soul_sync_history
      SET sync_status = $2, completed_at = $3, duration_ms = $4, error_message = $5
      WHERE id = $1
    `, [syncId, syncStatus, completedAt, durationMs, errorMessage || null]);
  }

  /**
   * 获取Soul同步历史
   */
  async getSoulSyncHistory(coworkerId: string, limit = 20): Promise<any[]> {
    const { rows } = await this.db.query(`
      SELECT * FROM jz_soul_sync_history
      WHERE coworker_id = $1
      ORDER BY started_at DESC
      LIMIT $2
    `, [coworkerId, limit]);

    return rows.map(row => ({
      id: row.id,
      coworkerId: row.coworker_id,
      assignmentId: row.assignment_id,
      oldSoul: row.old_soul?.substring(0, 50) + '...',
      newSoul: row.new_soul?.substring(0, 50) + '...',
      oldVersion: row.old_version,
      newVersion: row.new_version,
      syncStatus: row.sync_status,
      errorMessage: row.error_message,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      durationMs: row.duration_ms,
      triggerSource: row.trigger_source,
    }));
  }

  /**
   * 检查Soul同步健康状态
   */
  async checkSoulSyncHealth(coworkerId: string): Promise<{
    healthy: boolean;
    issues: string[];
    lastSyncAt?: Date;
    failedCount: number;
  }> {
    const issues: string[] = [];
    let healthy = true;
    let lastSyncAt: Date | null = null;
    let failedCount = 0;

    // 检查最近的同步失败
    const { rows: failedSyncs } = await this.db.query(`
      SELECT COUNT(*) as count, MAX(completed_at) as last_failed_at
      FROM jz_soul_sync_history
      WHERE coworker_id = $1 AND sync_status = 'failed' AND completed_at > NOW() - INTERVAL '1 hour'
    `, [coworkerId]);

    if (failedSyncs[0].count > 0) {
      failedCount = Number(failedSyncs[0].count);
      issues.push(`最近1小时有${failedCount}次同步失败`);
      healthy = false;
    }

    // 检查是否有长时间未同步的分配
    const { rows: staleAssignments } = await this.db.query(`
      SELECT a.id, a.last_sync_at, a.config_version
      FROM jz_coworker_assignments a
      WHERE a.coworker_id = $1
        AND a.status = 'active'
        AND (a.last_sync_at IS NULL OR a.last_sync_at < NOW() - INTERVAL '24 hours')
      LIMIT 5
    `, [coworkerId]);

    if (staleAssignments.length > 0) {
      issues.push(`有${staleAssignments.length}个分配超过24小时未同步`);
      healthy = false;
    }

    // 获取最后一次成功同步时间
    const { rows: lastSync } = await this.db.query(`
      SELECT MAX(completed_at) as last_sync_at
      FROM jz_soul_sync_history
      WHERE coworker_id = $1 AND sync_status = 'success'
    `, [coworkerId]);

    if (lastSync[0].last_sync_at) {
      lastSyncAt = lastSync[0].last_sync_at;
    }

    return {
      healthy,
      issues,
      lastSyncAt: lastSyncAt || undefined,
      failedCount,
    };
  }

  /**
   * 获取CoWorker版本号（用于乐观锁）
   */
  async getCoWorkerVersion(coworkerId: string): Promise<number> {
    const { rows } = await this.db.query('SELECT version FROM jz_coworkers WHERE id = $1', [coworkerId]);
    return rows[0]?.version || 1;
  }

  /**
   * 使用乐观锁更新CoWorker（带版本检查）
   */
  async updateWithOptimisticLock(
    id: string,
    data: Partial<{
      name: string; description: string; avatarUrl: string; soul: string;
      modelLevel: string; tools: string[]; skills: string[]; mcpServers: string[];
      capabilities: CoWorkerCapabilities;
      workScope: string; configOverrides: Record<string, any>; wechatConfig: Record<string, any>;
      kbBindings: string[];
    }>,
    expectedVersion: number,
  ): Promise<CoWorker | null> {
    const sets: string[] = [];
    const params: any[] = [];
    const addSet = (col: string, val: any) => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };

    if (data.name !== undefined) addSet('name', data.name);
    if (data.description !== undefined) addSet('description', data.description);
    if (data.avatarUrl !== undefined) addSet('avatar_url', data.avatarUrl);
    if (data.soul !== undefined) addSet('soul', data.soul);
    if (data.modelLevel !== undefined) addSet('model_level', data.modelLevel);
    if (data.tools !== undefined) addSet('tools', JSON.stringify(data.tools));
    if (data.skills !== undefined) addSet('skills', JSON.stringify(data.skills));
    if (data.mcpServers !== undefined) addSet('mcp_servers', JSON.stringify(data.mcpServers));
    if (data.capabilities !== undefined) addSet('capabilities', JSON.stringify(data.capabilities));
    if (data.workScope !== undefined) addSet('work_scope', data.workScope);
    if (data.configOverrides !== undefined) addSet('config_overrides', JSON.stringify(data.configOverrides));
    if (data.wechatConfig !== undefined) addSet('wechat_config', JSON.stringify(data.wechatConfig));
    if (data.kbBindings !== undefined) addSet('kb_bindings', JSON.stringify(data.kbBindings));

    if (sets.length === 0) return this.getById(id);

    sets.push('updated_at = NOW()');
    // 注意：version会由触发器自动递增，不需要手动设置
    params.push(expectedVersion, id);

    const { rowCount } = await this.db.query(
      `UPDATE jz_coworkers SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND version = $${params.length - 2}`,
      params,
    );

    if (rowCount === 0) {
      const currentVersion = await this.getCoWorkerVersion(id);
      throw new Error(`乐观锁冲突：期望版本${expectedVersion}，当前版本${currentVersion}`);
    }

    // Bump config_version on all assignments for hot-reload
    await this.db.query(
      'UPDATE jz_coworker_assignments SET config_version = config_version + 1 WHERE coworker_id = $1',
      [id],
    );

    this.invalidateToolsCache(id);
    const updated = await this.getById(id);
    this.logger.log(`CoWorker updated with optimistic lock: ${id} (version ${expectedVersion} -> ${updated?.configVersion || expectedVersion + 1})`);
    return updated;
  }

  /**
   * 重置激活状态（L-03：原子性操作）
   *
   * 执行原子性的重置操作，包括：
   * 1. 重置分配的config_version
   * 2. 清除同步状态
   * 3. 记录重置历史
   * 4. 保持assignment状态不变（允许重新激活）
   *
   * @param assignmentId 分配ID
   * @param options 重置选项
   */
  async resetActivationStatus(
    assignmentId: string,
    options: {
      action?: 'reset_start' | 'reset_confirm';
      timestamp?: number;
      clearApiKey?: boolean;
    } = {},
  ): Promise<{ success: boolean; message: string; newConfigVersion?: number }> {
    try {
      return await this.db.transaction(async (client) => {
        // 获取当前分配状态
        const { rows: assignments } = await client.query(
          'SELECT id, config_version, status, api_key FROM jz_coworker_assignments WHERE id = $1',
          [assignmentId],
        );

        if (assignments.length === 0) {
          return { success: false, message: '分配不存在' };
        }

        const oldVersion = assignments[0].config_version || 0;

        // 重置config_version（强制客户端重新拉取配置）
        const newConfigVersion = Date.now();
        await client.query(
          'UPDATE jz_coworker_assignments SET config_version = $1, updated_at = NOW() WHERE id = $2',
          [newConfigVersion, assignmentId],
        );

        // 清除同步状态
        await client.query(
          `UPDATE jz_coworker_assignments
           SET sync_status = 'idle',
               last_sync_at = NULL,
               last_sync_error = NULL,
               sync_retry_count = 0
           WHERE id = $1`,
          [assignmentId],
        );

        // 可选：撤销API Key（需要重新生成）
        if (options.clearApiKey) {
          await client.query(
            'UPDATE jz_coworker_assignments SET api_key = NULL, api_key_created_at = NULL, api_key_revoked_at = NOW() WHERE id = $1',
            [assignmentId],
          );
        }

        // 记录重置历史
        const { randomUUID } = await import('crypto');
        await client.query(
          `INSERT INTO jz_soul_sync_history (
             id, coworker_id, assignment_id,
             old_version, new_version,
             sync_status, trigger_source,
             started_at, completed_at
           ) VALUES ($1, (SELECT coworker_id FROM jz_coworker_assignments WHERE id = $2), $2, $3, $4, $5, $6, NOW(), NOW())`,
          [
            randomUUID(),
            assignmentId,
            oldVersion,
            newConfigVersion,
            'success',
            'manual',
          ],
        );

        this.logger.log(`Assignment ${assignmentId.slice(0,8)} reset: version ${oldVersion} -> ${newConfigVersion}`);

        return {
          success: true,
          message: '激活状态已重置，请重新激活',
          newConfigVersion,
        };
      });
    } catch (error: any) {
      this.logger.error(`Reset failed for ${assignmentId}: ${error.message}`);
      return { success: false, message: `重置失败: ${error.message}` };
    }
  }

  /**
   * 批量重置用户的所有CoWorker分配（用于用户重置场景）
   */
  async resetAllUserAssignments(
    userId: string,
    options: { clearApiKeys?: boolean } = {},
  ): Promise<{ resetCount: number; failures: Array<{ assignmentId: string; error: string }> }> {
    const { rows: assignments } = await this.db.query(
      'SELECT id FROM jz_coworker_assignments WHERE user_id = $1 AND status = $2',
      [userId, 'active'],
    );

    const failures: Array<{ assignmentId: string; error: string }> = [];
    let resetCount = 0;

    for (const row of assignments) {
      const result = await this.resetActivationStatus(row.id, { clearApiKey: options.clearApiKeys });
      if (result.success) {
        resetCount++;
      } else {
        failures.push({ assignmentId: row.id, error: result.message });
      }
    }

    this.logger.log(`Reset ${resetCount} assignments for user ${userId}, ${failures.length} failures`);

    return { resetCount, failures };
  }
}
