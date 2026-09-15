import { Injectable, Logger, Optional, BadRequestException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { DbService } from '../../db/db.service';
import { UserService, Permission } from '../../user/user.service';
import { EditionService } from '../../edition/edition.service';

/** System-allowed OEM scopes. The effective token scope = app.scope ∩ this set. */
const OEM_ALLOWED_SCOPES: Permission[] = ['chat:use', 'dash:view'];
const TOKEN_TTL_SECONDS = 900; // 15 min

export interface OemApp {
  id: string;
  appId: string;
  name: string;
  bearerUserId: string;
  scope: Permission[];
  mcpBindings: any[];
  branding: Record<string, any>;
  allowedOrigins: string[];
  cachePolicy: 'on' | 'off';
  rateLimit: OemRateLimit;
  status: 'active' | 'suspended';
  createdAt: string;
  updatedAt: string;
}

export interface OemRateLimit {
  tokenPerMin?: number;  // 每分钟 token 签发上限
  msgPerMin?: number;    // 每分钟对话消息上限
  msgPerDay?: number;    // 每日对话消息配额
}

export interface OemRuntimeConfig {
  dataSources: any[];
  rateLimit: OemRateLimit;
  allowedOrigins: string[];
  cachePolicy: 'on' | 'off';
}

@Injectable()
export class OemService {
  private readonly logger = new Logger(OemService.name);
  /** 内存滑动窗口：key=`${appId}:${metric}` → 时间戳(ms)数组（按 app 限流，单实例即可） */
  private rlWindows = new Map<string, number[]>();

  constructor(
    private readonly db: DbService,
    private readonly userService: UserService,
    @Optional() private readonly edition?: EditionService,
  ) {}

  private genId(): string {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  }

  // ===== Admin: App CRUD =====

  async listApps(): Promise<OemApp[]> {
    const { rows } = await this.db.query('SELECT * FROM jz_oem_apps ORDER BY created_at DESC');
    return rows.map(this.mapApp);
  }

  async getApp(id: string): Promise<OemApp | null> {
    const { rows } = await this.db.query('SELECT * FROM jz_oem_apps WHERE id=$1', [id]);
    return rows[0] ? this.mapApp(rows[0]) : null;
  }

  private async getAppByAppId(appId: string): Promise<any | null> {
    const { rows } = await this.db.query('SELECT * FROM jz_oem_apps WHERE app_id=$1', [appId]);
    return rows[0] || null;
  }

  /** Create a new接入方. Returns the app + the plaintext secret (shown only once). */
  async createApp(input: {
    name: string; bearerUserId: string; scope?: Permission[]; mcpBindings?: any[];
    branding?: Record<string, any>; allowedOrigins?: string[]; cachePolicy?: 'on' | 'off'; rateLimit?: OemRateLimit;
  }): Promise<{ app: OemApp; appSecret: string }> {
    const bearer = await this.userService.getUser(input.bearerUserId);
    if (!bearer) throw new BadRequestException('承载用户不存在');

    const id = this.genId();
    const appId = 'oem_' + crypto.randomBytes(9).toString('hex');
    const appSecret = crypto.randomBytes(32).toString('base64url');
    const secretHash = await bcrypt.hash(appSecret, 10);
    const scope = this.sanitizeScope(input.scope);

    await this.db.query(
      `INSERT INTO jz_oem_apps
         (id, app_id, app_secret_hash, name, bearer_user_id, scope, mcp_bindings, branding, allowed_origins, cache_policy, rate_limit)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id, appId, secretHash, input.name, input.bearerUserId,
        JSON.stringify(scope), JSON.stringify(input.mcpBindings || []),
        JSON.stringify(input.branding || {}), JSON.stringify(input.allowedOrigins || []),
        input.cachePolicy || 'on', JSON.stringify(input.rateLimit || {}),
      ],
    );
    this.logger.log(`OEM app created: ${appId} (${input.name})`);
    const app = (await this.getApp(id))!;
    return { app, appSecret };
  }

  async updateApp(id: string, updates: Partial<{
    name: string; scope: Permission[]; mcpBindings: any[]; branding: Record<string, any>;
    allowedOrigins: string[]; cachePolicy: 'on' | 'off'; rateLimit: OemRateLimit;
  }>): Promise<OemApp | null> {
    const app = await this.getApp(id);
    if (!app) return null;
    const fields: string[] = [];
    const vals: any[] = [id];
    const set = (col: string, val: any) => { vals.push(val); fields.push(`${col}=$${vals.length}`); };
    if (updates.name !== undefined) set('name', updates.name);
    if (updates.scope !== undefined) set('scope', JSON.stringify(this.sanitizeScope(updates.scope)));
    if (updates.mcpBindings !== undefined) set('mcp_bindings', JSON.stringify(updates.mcpBindings));
    if (updates.branding !== undefined) set('branding', JSON.stringify(updates.branding));
    if (updates.allowedOrigins !== undefined) set('allowed_origins', JSON.stringify(updates.allowedOrigins));
    if (updates.cachePolicy !== undefined) set('cache_policy', updates.cachePolicy);
    if (updates.rateLimit !== undefined) set('rate_limit', JSON.stringify(updates.rateLimit));
    if (!fields.length) return app;
    await this.db.query(`UPDATE jz_oem_apps SET ${fields.join(', ')}, updated_at=NOW() WHERE id=$1`, vals);
    return this.getApp(id);
  }

  async rotateSecret(id: string): Promise<{ appSecret: string } | null> {
    const app = await this.getApp(id);
    if (!app) return null;
    const appSecret = crypto.randomBytes(32).toString('base64url');
    const secretHash = await bcrypt.hash(appSecret, 10);
    await this.db.query('UPDATE jz_oem_apps SET app_secret_hash=$2, updated_at=NOW() WHERE id=$1', [id, secretHash]);
    this.logger.log(`OEM app secret rotated: ${app.appId}`);
    return { appSecret };
  }

  async setStatus(id: string, status: 'active' | 'suspended'): Promise<OemApp | null> {
    const app = await this.getApp(id);
    if (!app) return null;
    await this.db.query('UPDATE jz_oem_apps SET status=$2, updated_at=NOW() WHERE id=$1', [id, status]);
    return this.getApp(id);
  }

  // ===== Token exchange (called by third-party backend) =====

  async issueToken(input: {
    appId: string; appSecret: string; externalUid: string; externalName?: string;
  }): Promise<{ token: string; expiresIn: number; embedUrl: string }> {
    // OEM requires professional edition (depends on MCP external data sources)
    if (this.edition && !this.edition.isProfessional()) {
      throw new ForbiddenException('OEM 接入需要专业版授权');
    }

    const row = await this.getAppByAppId(input.appId);
    if (!row) throw new ForbiddenException('凭据无效');
    if (row.status !== 'active') throw new ForbiddenException('接入方已停用');

    const ok = await bcrypt.compare(input.appSecret, row.app_secret_hash);
    if (!ok) throw new ForbiddenException('凭据无效');

    if (!input.externalUid) throw new BadRequestException('缺少 external_uid');

    // 按 app 限流：token 签发频率
    const rate = await this.checkRate(input.appId, 'token_issue', row.rate_limit || {});
    if (!rate.allowed) throw new HttpException(rate.reason || '请求过于频繁', HttpStatus.TOO_MANY_REQUESTS);

    const userId = await this.resolveShadowUser(row, input.externalUid, input.externalName);

    // Effective scope = app.scope ∩ system-allowed OEM scopes
    const scope = this.sanitizeScope(row.scope);
    const bearer = await this.userService.getUser(userId);

    const token = this.userService.signOemToken({
      userId,
      email: bearer?.email || `${input.externalUid}@oem.local`,
      username: input.externalName || bearer?.username || input.externalUid,
      roleId: bearer?.role.id || 'user',
      permissions: scope,
      appId: input.appId,
      externalUid: input.externalUid,
      expiresInSeconds: TOKEN_TTL_SECONDS,
    });

    this.recordUsage(input.appId, input.externalUid, 'token_issue').catch(() => {});
    return { token, expiresIn: TOKEN_TTL_SECONDS, embedUrl: '/embed/dashboard' };
  }

  /** Map (app_id, external_uid) → a dedicated见智影子用户. Creates one on first sight. */
  private async resolveShadowUser(appRow: any, externalUid: string, externalName?: string): Promise<string> {
    const { rows } = await this.db.query(
      'SELECT user_id FROM jz_oem_shadow_users WHERE app_id=$1 AND external_uid=$2',
      [appRow.app_id, externalUid],
    );
    if (rows[0]) {
      await this.db.query(
        'UPDATE jz_oem_shadow_users SET last_seen_at=NOW(), external_name=COALESCE($3, external_name) WHERE app_id=$1 AND external_uid=$2',
        [appRow.app_id, externalUid, externalName || null],
      );
      return rows[0].user_id;
    }

    // Create a shadow user backing this external identity
    const userId = this.genId();
    const placeholderHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
    const email = `${appRow.app_id}.${externalUid}@oem.local`;
    const name = externalName || externalUid;
    await this.db.query(
      `INSERT INTO jz_users (id, name, username, email, password, role_id, is_oem_shadow, oem_app_id)
       VALUES ($1,$2,$3,$4,$5,'user',TRUE,$6)`,
      [userId, name, name, email, placeholderHash, appRow.app_id],
    );
    await this.db.query(
      `INSERT INTO jz_oem_shadow_users (id, app_id, external_uid, user_id, external_name, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,NOW())`,
      [this.genId(), appRow.app_id, externalUid, userId, externalName || null],
    );
    this.logger.log(`OEM shadow user created: app=${appRow.app_id} ext=${externalUid} → ${userId}`);
    return userId;
  }

  /** Active app's runtime config — bound sources / rate limit / origins / cache policy. */
  async getRuntimeConfig(appId: string): Promise<OemRuntimeConfig | null> {
    const { rows } = await this.db.query(
      "SELECT mcp_bindings, rate_limit, allowed_origins, cache_policy FROM jz_oem_apps WHERE app_id=$1 AND status='active'",
      [appId],
    );
    if (!rows[0]) return null;
    return {
      dataSources: rows[0].mcp_bindings || [],
      rateLimit: rows[0].rate_limit || {},
      allowedOrigins: rows[0].allowed_origins || [],
      cachePolicy: rows[0].cache_policy || 'on',
    };
  }

  // ===== Rate limit / quota (按 app) =====

  /** Sliding-window per-minute check. Records the hit when allowed. */
  private slidingAllow(key: string, limit: number, windowMs = 60_000): boolean {
    const now = Date.now();
    const arr = (this.rlWindows.get(key) || []).filter(t => now - t < windowMs);
    if (arr.length >= limit) { this.rlWindows.set(key, arr); return false; }
    arr.push(now);
    this.rlWindows.set(key, arr);
    return true;
  }

  /**
   * Enforce per-app rate limit / quota for a metric.
   * tokenPerMin / msgPerMin → in-memory sliding window; msgPerDay → DB usage count.
   */
  async checkRate(appId: string, metric: 'token_issue' | 'chat_msg', rateLimit: OemRateLimit): Promise<{ allowed: boolean; reason?: string }> {
    const perMin = metric === 'token_issue' ? rateLimit?.tokenPerMin : rateLimit?.msgPerMin;
    if (perMin && perMin > 0 && !this.slidingAllow(`${appId}:${metric}`, perMin)) {
      return { allowed: false, reason: '超过每分钟频率限制' };
    }
    if (metric === 'chat_msg' && rateLimit?.msgPerDay && rateLimit.msgPerDay > 0) {
      const { rows } = await this.db.query(
        "SELECT COALESCE(SUM(qty),0)::int AS c FROM jz_oem_usage WHERE app_id=$1 AND metric='chat_msg' AND ts >= date_trunc('day', NOW())",
        [appId],
      );
      if (rows[0].c >= rateLimit.msgPerDay) return { allowed: false, reason: '已达每日对话配额' };
    }
    return { allowed: true };
  }

  async recordUsage(appId: string, externalUid: string | null, metric: string, qty = 1): Promise<void> {
    await this.db.query(
      'INSERT INTO jz_oem_usage (app_id, external_uid, metric, qty) VALUES ($1,$2,$3,$4)',
      [appId, externalUid, metric, qty],
    );
  }

  async getUsage(appId: string): Promise<{ metric: string; total: number }[]> {
    const { rows } = await this.db.query(
      'SELECT metric, SUM(qty)::int AS total FROM jz_oem_usage WHERE app_id=$1 GROUP BY metric',
      [appId],
    );
    return rows.map((r: any) => ({ metric: r.metric, total: r.total }));
  }

  private sanitizeScope(scope?: Permission[]): Permission[] {
    const requested = Array.isArray(scope) && scope.length ? scope : (['chat:use', 'dash:view'] as Permission[]);
    return requested.filter(s => OEM_ALLOWED_SCOPES.includes(s));
  }

  private mapApp = (row: any): OemApp => ({
    id: row.id,
    appId: row.app_id,
    name: row.name,
    bearerUserId: row.bearer_user_id,
    scope: row.scope || [],
    mcpBindings: row.mcp_bindings || [],
    branding: row.branding || {},
    allowedOrigins: row.allowed_origins || [],
    cachePolicy: row.cache_policy,
    rateLimit: row.rate_limit || {},
    status: row.status,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
  });
}
