import { Injectable, Logger, ForbiddenException, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../db/db.service';
import { randomUUID } from 'crypto';
import { Edition, EDITION_FEATURES, FeatureGates, InstallationRecord } from './edition.types';
import { AnalyticsService } from '../platform/analytics/analytics.service';
import { LicensePayload, verifyLicense, isLicenseExpired, DEFAULT_COMMUNITY_FEATURES } from './license';

const HEARTBEAT_INTERVAL = 2 * 60 * 60 * 1000;       // 2 hours (stats reporting only)
const LICENSE_CHECK_INTERVAL = 24 * 60 * 60 * 1000;   // 24 hours (local license check)
const LICENSE_RENEW_THRESHOLD_DAYS = 30;               // auto-renew when ≤30 days remaining

@Injectable()
export class EditionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EditionService.name);
  private readonly websiteUrl: string;
  private installation: InstallationRecord | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private licenseCheckTimer: ReturnType<typeof setInterval> | null = null;
  private _tokenInvalid = false;   // 官网拒绝 installation token 时置位（社区版对话/计费会用到）
  private _recovering = false;     // 防止并发恢复
  private _replaced = false;       // 本实例已被同一手机号下的新实例取代 → 停止自动恢复，需人工重新注册

  // License-derived state (cached in memory, never persisted as plaintext)
  private licensePayload: LicensePayload | null = null;
  private licenseExpired = false;
  private _licenseIssue: string | null = null; // 'verification_failed' when local license cannot be verified
  private _cachedUpdate: any = null;

  // Credits balance cache (P0-2: avoid HTTP round-trip on every message)
  private creditsCache: { balance: number; at: number; token: string; negative: boolean } | null = null;
  private creditsFetchPromise: Promise<number> | null = null;
  private readonly CREDITS_CACHE_TTL_MS = 60 * 1000;          // 1 minute
  private readonly CREDITS_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes for negative balances

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly analytics: AnalyticsService,
  ) {
    this.websiteUrl = this.config.get('JIANZHI_WEBSITE_URL', 'http://198.18.4.231');
    this.logger.log(`Website: ${this.websiteUrl}`);
  }

  async onModuleInit() {
    await this.loadInstallation();

    // Auto-register if no valid license (missing, tampered, or expired)
    if (!this.licensePayload) {
      await this.autoRegister();
    } else {
      // 本地 license 有效但官网可能已不认其 installation token（轮换过期/记录变动）。
      // 仅在系统启动时校验一次并尝试自愈，不入侵任何业务路径；失败则置标志由 UI 引导用户重新注册。
      this.validateTokenAtStartup().catch(() => { /* 非关键，不阻塞启动 */ });
    }

    // Daily local license check (with auto-renewal attempt)
    this.licenseCheckTimer = setInterval(() => this.checkLicenseExpiry(), LICENSE_CHECK_INTERVAL);

    // Periodic heartbeat for stats reporting only (no license refresh)
    this.heartbeatTimer = setInterval(() => this.autoHeartbeat(), HEARTBEAT_INTERVAL);
    setTimeout(() => this.autoHeartbeat(), 5 * 60 * 1000); // first heartbeat after 5 min
  }

  onModuleDestroy() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.licenseCheckTimer) clearInterval(this.licenseCheckTimer);
  }

  // ── Edition queries (all derived from license) ──

  getEdition(): Edition {
    return this.licensePayload?.edition || (this.config.get('JIANZHI_EDITION', 'community') as Edition);
  }
  isCommunity(): boolean { return this.getEdition() === 'community'; }
  isProfessional(): boolean { return this.getEdition() === 'professional'; }

  getFeatureGates(): FeatureGates {
    if (this.licensePayload && !this.licenseExpired) {
      return this.licensePayload.features;
    }
    // Fallback: degraded community features
    return EDITION_FEATURES[this.getEdition()] || DEFAULT_COMMUNITY_FEATURES;
  }

  getInstallation(): InstallationRecord | null { return this.installation; }
  isRegistered(): boolean { return !!this.licensePayload; }
  getLicenseIssue(): string | null { return this._licenseIssue; }

  // ── Installation token 失效自愈（社区版对话报 "invalid installation token" 时）──
  isTokenInvalid(): boolean { return this._tokenInvalid; }
  isReplaced(): boolean { return this._replaced; }
  markTokenInvalid(): void { this._tokenInvalid = true; }

  /**
   * token 被官网拒绝时自动恢复：用本地企业信息重新注册换取新 token。
   * 成功 → 清除失效标志；失败（需短信验证/无企业信息）→ 置标志，由 UI 引导用户手动重新注册。
   * 实例已被取代（INSTALLATION_REPLACED）时不自动恢复，避免两个实例互相顶号。
   */
  async recoverToken(): Promise<{ recovered: boolean; needsManual: boolean }> {
    if (this._recovering) return { recovered: false, needsManual: false };
    if (this._replaced) return { recovered: false, needsManual: true };
    this._recovering = true;
    try {
      this.logger.warn('Installation token 失效 — 尝试自动重新注册恢复');
      const ok = await this.autoRegister();   // 成功则更新 installation_token + license
      if (ok && this.isRegistered() && !this.licenseExpired) {
        this._tokenInvalid = false;
        this.logger.log('Installation token 已通过重新注册恢复');
        return { recovered: true, needsManual: false };
      }
      this._tokenInvalid = true;
      this.logger.warn('自动恢复失败（需短信验证或手动重新注册）');
      return { recovered: false, needsManual: true };
    } finally {
      this._recovering = false;
    }
  }

  /** 启动时一次性校验 installation token 是否被官网接受；401/403 即失效 → 尝试自愈。网络异常不处理。 */
  private async validateTokenAtStartup(): Promise<void> {
    const token = this.getInstallationToken();
    if (!token) return;
    let resp: Response;
    try {
      resp = await fetch(`${this.websiteUrl}/api/v1/credits/balance`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return; // 网络不可达 → 视为未知，不动
    }
    if (resp.status === 401 || resp.status === 403) {
      // 区分"实例被取代"与普通 token 失效：被取代时不自动恢复，避免两个实例互相顶号
      let code = '';
      try { code = (await resp.json())?.code || ''; } catch { /* ignore */ }
      if (code === 'INSTALLATION_REPLACED') {
        this._replaced = true;
        this._tokenInvalid = true;
        this.logger.warn('启动校验：本安装实例已被同一手机号下的新实例取代 — 停止自动恢复，等待人工重新注册');
        return;
      }
      this.logger.warn('启动校验：installation token 被官网拒绝，尝试自动恢复');
      await this.recoverToken(); // 成功清标志；失败置 _tokenInvalid，UI 引导手动重注册
    } else {
      this._tokenInvalid = false; // 官网接受 → 确保标志清零
    }
  }

  /** Read current product version from version.json */
  getCurrentVersion(): string {
    try {
      const paths = [
        require('path').join(process.cwd(), 'version.json'),
        require('path').join(process.cwd(), 'config', 'version.json'),
      ];
      for (const p of paths) {
        if (require('fs').existsSync(p)) {
          return JSON.parse(require('fs').readFileSync(p, 'utf8')).version;
        }
      }
    } catch { /* ignore */ }
    return 'unknown';
  }

  /** Cached update info from last heartbeat */
  getCachedUpdate(): any { return this._cachedUpdate; }

  /** Unified accessor for installation token (never read from license) */
  private getInstallationToken(): string | null {
    return this.installation?.installationToken || null;
  }

  getEditionInfo() {
    const payload = this.licensePayload;
    const now = Math.floor(Date.now() / 1000);

    return {
      // Basic info
      edition: this.getEdition(),
      editionLabel: this.getEdition() === 'professional' ? '专业版' : '社区版',
      features: this.getFeatureGates(),

      // Registration info
      registered: this.isRegistered(),
      tokenInvalid: this._tokenInvalid,   // 令牌被官网拒绝 → UI 提示重新注册
      replaced: this._replaced,           // 实例被同手机号新实例取代 → UI 提示人工重新注册
      companyName: this.installation?.companyName || null,
      contactPhone: this.installation?.contactPhone || null,
      installationId: this.installation?.id || null,

      // License info
      licenseExpired: this.licenseExpired,
      licenseIssuedAt: payload?.issuedAt ? new Date(payload.issuedAt * 1000).toISOString() : null,
      licenseExpiresAt: payload?.expiresAt
        ? (payload.expiresAt === 0 ? null : new Date(payload.expiresAt * 1000).toISOString())
        : null,
      licenseNeverExpires: payload?.expiresAt === 0,
      licenseDaysRemaining: payload?.expiresAt && payload.expiresAt > 0
        ? Math.max(0, Math.ceil((payload.expiresAt - now) / 86400))
        : null,

      // Website info
      websiteUrl: this.websiteUrl,
      lastSync: this.installation?.lastSync || null,

      // Setup lifecycle
      setupPhase: this.installation?.setupPhase || 'pending',
      needsGuidedConfig: this.installation?.needsGuidedConfig ?? true,

      // License issue (verification_failed, etc.)
      licenseIssue: this._licenseIssue,
    };
  }

  // ── Feature gating ──

  checkCoWorkerLimit(currentCount: number): void {
    const max = this.getFeatureGates().maxCoWorkers;
    if (currentCount >= max) {
      throw new ForbiddenException(
        `当前版本最多创建 ${max} 个AI员工，已有 ${currentCount} 个。升级专业版可解除限制。`,
      );
    }
  }

  checkModelConfigEditable(): void {
    if (!this.getFeatureGates().modelConfigEditable) {
      throw new ForbiddenException('当前版本不支持自定义模型配置。升级专业版可解除限制。');
    }
  }

  // ── Installation identity (no machine fingerprint since license v2) ──

  /**
   * Stable installation ID: persisted in the local DB (survives container
   * rebuilds), shared with the website as jzw_installations.id.
   * Honors JIANZHI_INSTALLATION_ID (injected by the installer) on first boot.
   */
  private async ensureLocalInstallationId(): Promise<string> {
    if (this.installation?.id) return this.installation.id;
    const envId = this.config.get('JIANZHI_INSTALLATION_ID', '');
    try {
      const { rows } = await this.db.query(
        'SELECT id, installation_token FROM jz_installation ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1',
      );
      if (rows[0]?.id) {
        // Placeholder row created at first boot + installer-provided id → adopt installer id
        // so the installer's registration/token stays valid for this same instance.
        if (envId && !rows[0].installation_token && rows[0].id !== envId) {
          await this.db.query('UPDATE jz_installation SET id = $1 WHERE id = $2', [envId, rows[0].id]);
          return envId;
        }
        return rows[0].id;
      }
    } catch { /* fall through */ }
    return envId || randomUUID();
  }

  // ── Re-activation (license issue / manual re-verify from UI) ──

  /**
   * Re-activate this installation: re-run registration with the same stable
   * installationId. The website upserts the same instance and (取代制)
   * supersedes any other active installation of this customer.
   */
  async reactivate(): Promise<{ success: boolean; error?: string }> {
    const ok = await this.autoRegister();
    if (ok && this.isRegistered() && !this.licenseExpired) {
      this._licenseIssue = null;
      this._tokenInvalid = false;
      this._replaced = false;
      this.logger.log('Re-activation successful');
      return { success: true };
    }
    return { success: false, error: '重新验证未生效，请检查网络连接或联系管理员' };
  }

  // ── Auto-registration ──

  async autoRegister(smsCode?: string, overrides?: { companyName?: string; contactPerson?: string; contactPhone?: string }): Promise<boolean> {
    const installationId = await this.ensureLocalInstallationId();
    const companyName = overrides?.companyName || this.installation?.companyName || this.config.get('COMPANY_NAME', '未命名企业');
    const contactPerson = overrides?.contactPerson || this.installation?.contactPerson || '';
    const contactPhone = overrides?.contactPhone || this.installation?.contactPhone || this.config.get('CONTACT_PHONE', '');

    if (!contactPhone) {
      this.logger.warn('Auto-register skipped: no CONTACT_PHONE configured');
      return false;
    }

    try {
      const resp = await fetch(`${this.websiteUrl}/api/v1/installations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          installationId,
          edition: this.config.get('JIANZHI_EDITION', 'community'),
          companyName,
          contactPerson,
          contactPhone,
          currentVersion: this.getCurrentVersion(),
          ...(smsCode ? { smsCode } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });

      const rawText = await resp.text();
      let data: any = {};
      try { data = rawText ? JSON.parse(rawText) : {}; } catch { /* 非 JSON */ }

      if (data.needsVerification) {
        this.logger.warn(`Auto-register: phone ${data.phone} needs SMS verification`);
        return false;
      }

      if (!resp.ok) {
        throw new Error(data.error || `Registration failed: ${resp.status}`);
      }

      if (!data.license) {
        throw new Error('Server returned no license');
      }

      // Verify license before storing (v2: bound to installationId + phone)
      const payload = verifyLicense(data.license, installationId);
      // installationToken is returned separately (not embedded in license)
      const installationToken = data.installationToken;

      // Save license blob and token to DB (single-row upsert by stable id)
      await this.db.query(
        `INSERT INTO jz_installation (id, edition, company_name, contact_person, contact_phone, installation_token, license_blob)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           license_blob = $7, installation_token = $6, company_name = $3, contact_person = $4, contact_phone = $5, edition = $2`,
        [installationId, payload.edition, companyName, contactPerson, contactPhone, installationToken, data.license],
      );

      this.licensePayload = payload;
      this.licenseExpired = false;
      this._licenseIssue = null;
      await this.loadInstallation();

      // Advance setup phase: pending → registered
      await this.db.query(
        "UPDATE jz_installation SET setup_phase = 'registered' WHERE setup_phase = 'pending'",
      );
      this.logger.log(`Auto-registered: ${companyName}, edition=${payload.edition}`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Auto-register failed (will retry on next startup): ${err.message}`);
      return false;
    }
  }

  // ── Registration (for frontend manual flow) ──

  async register(dto: { companyName: string; contactPerson: string; contactPhone: string }) {
    const url = `${this.websiteUrl}/api/v1/register`;
    this.logger.log(`Register → POST ${url}`);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
        signal: AbortSignal.timeout(15000),
      });
      const text = await resp.text();
      this.logger.log(`Register ← ${resp.status} ${text.substring(0, 200)}`);
      let data: any = {};
      try { data = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 响应 */ }
      if (!resp.ok) throw new Error(data.error || data.message || `Registration failed: ${resp.status} - ${text.substring(0, 100)}`);
      return data;
    } catch (err: any) {
      this.logger.error(`Registration failed: ${err.message}`);
      throw err;
    }
  }

  async verifyPhone(dto: { contactPhone: string; code: string }) {
    try {
      const resp = await fetch(`${this.websiteUrl}/api/v1/register/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(dto),
        signal: AbortSignal.timeout(15000),
      });
      const vText = await resp.text();
      let data: any = {};
      try { data = vText ? JSON.parse(vText) : {}; } catch { /* 非 JSON */ }
      if (!resp.ok) throw new Error(data.error || `Verification failed: ${resp.status}`);
      await this.autoRegister(undefined, { contactPhone: dto.contactPhone });
      return data;
    } catch (err: any) {
      this.logger.error(`Phone verification failed: ${err.message}`);
      throw err;
    }
  }

  // ── Credits ──

  /**
   * Query credits balance.
   *
   * For the message hot path (`force=false`), a short-lived in-memory cache is used
   * to avoid an HTTP round-trip on every user message. The controller/ settings page
   * can pass `force=true` to get a fresh value.
   */
  async syncCredits(force = false): Promise<number> {
    const token = this.getInstallationToken();
    if (!token) {
      this.creditsCache = null;
      return 0;
    }

    const now = Date.now();
    if (!force && this.creditsCache && this.creditsCache.token === token) {
      const ttl = this.creditsCache.negative ? this.CREDITS_NEGATIVE_CACHE_TTL_MS : this.CREDITS_CACHE_TTL_MS;
      if (now - this.creditsCache.at < ttl) {
        return this.creditsCache.balance;
      }
    }

    // Deduplicate concurrent credit fetches
    if (this.creditsFetchPromise) {
      return this.creditsFetchPromise;
    }

    this.creditsFetchPromise = this.fetchCredits(token).finally(() => {
      this.creditsFetchPromise = null;
    });
    return this.creditsFetchPromise;
  }

  private async fetchCredits(token: string): Promise<number> {
    try {
      const resp = await fetch(`${this.websiteUrl}/api/v1/credits/balance`, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        this.logger.warn(`Credits sync failed: ${resp.status}`);
        return this.staleCreditsOr(0);
      }
      const data = await resp.text().then(t => t ? JSON.parse(t) : {});
      const balance = data.balance ?? 0;
      this.creditsCache = {
        balance,
        at: Date.now(),
        token,
        negative: balance < 0,
      };
      return balance;
    } catch (err: any) {
      this.logger.warn(`Failed to sync credits: ${err.message}`);
      return this.staleCreditsOr(0);
    }
  }

  private staleCreditsOr(fallback: number): number {
    const token = this.getInstallationToken();
    if (this.creditsCache && this.creditsCache.token === token) {
      return this.creditsCache.balance;
    }
    return fallback;
  }

  // ── LLM proxy config ──

  getLlmProxyConfig(): { baseUrl: string; installationToken: string; model: string } | null {
    const token = this.getInstallationToken();
    if (!token || !this.isRegistered()) return null;
    return {
      baseUrl: `${this.websiteUrl}/api/v1/llm/proxy`,
      installationToken: token,
      model: 'jianzhi-chat',
    };
  }

  // ── License renewal ──

  /** Renew license (triggered by admin from settings or by daily auto-check) */
  async renewLicense(durationMonths?: number): Promise<void> {
    const token = this.getInstallationToken();
    if (!token) throw new Error('Not registered');

    const resp = await fetch(`${this.websiteUrl}/api/v1/license/renew`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({ licenseDurationMonths: durationMonths }),
      signal: AbortSignal.timeout(15000),
    });

    const renewText = await resp.text();
    let data: any = {};
    try { data = renewText ? JSON.parse(renewText) : {}; } catch { /* 非 JSON */ }

    if (!resp.ok) {
      throw new Error(data.error || `Renewal failed: ${resp.status}`);
    }

    if (!data.license) {
      throw new Error('Server returned no license');
    }

    // Verify and store new license (v2: bound to installationId + phone)
    if (!this.installation?.id) throw new Error('No local installation record');
    const payload = verifyLicense(data.license, this.installation.id);

    await this.db.query(
      'UPDATE jz_installation SET license_blob = $1, edition = $2, last_sync = NOW() WHERE id = $3',
      [data.license, payload.edition, this.installation?.id],
    );

    this.licensePayload = payload;
    this.licenseExpired = false;
    this.logger.log(`License renewed: edition=${payload.edition}, expiresAt=${payload.expiresAt === 0 ? 'never' : new Date(payload.expiresAt * 1000).toISOString()}`);
  }

  // ── Daily license check (with auto-renewal) ──

  private async checkLicenseExpiry(): Promise<void> {
    if (!this.licensePayload) {
      this.logger.warn('No license found — running in degraded community mode');
      return;
    }

    // Never expires (community, expiresAt=0) — still sync in case edition changed on website
    if (this.licensePayload.expiresAt === 0) {
      try {
        await this.renewLicense();
      } catch { /* silent — community keeps running regardless */ }
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    const daysRemaining = Math.ceil((this.licensePayload.expiresAt - now) / 86400);

    // Plenty of time remaining → no action
    if (daysRemaining > LICENSE_RENEW_THRESHOLD_DAYS) return;

    // Approaching expiry or already expired → attempt auto-renewal
    this.logger.log(
      daysRemaining > 0
        ? `License expires in ${daysRemaining} days — attempting auto-renewal`
        : `License expired ${-daysRemaining} days ago — attempting auto-renewal`,
    );

    try {
      await this.renewLicense();
    } catch (err: any) {
      // Renewal failed — update expired state
      this.licenseExpired = isLicenseExpired(this.licensePayload);
      this.logger.warn(`License auto-renewal failed: ${err.message}`);
    }
  }

  // ── Heartbeat (stats reporting only, no license refresh) ──

  /** 当日活跃汇总（按实例聚合；官网按手机号维度归集，不再上报用户明细） */
  private async collectTodayActivity(): Promise<{ userCount: number; messageCount: number }> {
    try {
      const { rows } = await this.db.query(
        `SELECT COUNT(DISTINCT e.user_id)::int as user_count, COUNT(*)::int as msg_count
         FROM jz_events e
         WHERE e.type = 'conversation_message'
           AND e.created_at >= date_trunc('day', NOW())
           AND e.user_id IS NOT NULL`,
      );
      return { userCount: rows[0]?.user_count || 0, messageCount: rows[0]?.msg_count || 0 };
    } catch {
      return { userCount: 0, messageCount: 0 };
    }
  }

  async sendHeartbeat(stats?: Record<string, any>): Promise<any> {
    const token = this.getInstallationToken();
    if (!token) return null;
    try {
      const resp = await fetch(`${this.websiteUrl}/api/v1/heartbeat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ edition: this.getEdition(), stats, currentVersion: this.getCurrentVersion() }),
        signal: AbortSignal.timeout(30000),
      });
      if (resp.ok) {
        const data = await resp.json();
        this.logger.debug('Heartbeat sent');
        return data;
      }
      // token 被拒：区分"实例被取代"（停止自动恢复）与普通失效
      if (resp.status === 401 || resp.status === 403) {
        let code = '';
        try { code = (await resp.json())?.code || ''; } catch { /* ignore */ }
        if (code === 'INSTALLATION_REPLACED') {
          this._replaced = true;
          this._tokenInvalid = true;
          this.logger.warn('心跳被拒：本安装实例已被同一手机号下的新实例取代 — 停止自动恢复，等待人工重新注册');
        } else {
          this._tokenInvalid = true;
          this.logger.warn('心跳被拒：installation token 无效');
        }
      }
    } catch { /* non-critical */ }
    return null;
  }

  private async autoHeartbeat() {
    const token = this.getInstallationToken();
    if (!token) return;
    try {
      const dashboard = await this.analytics.getDashboard();
      const todayActive = await this.collectTodayActivity();
      const stats = {
        totalMessages: dashboard.overview.totalMessages,
        weekMessages: dashboard.overview.weekMessages,
        totalTokens: dashboard.overview.totalTokens,
        totalTokensInput: dashboard.overview.totalTokensInput,
        totalTokensOutput: dashboard.overview.totalTokensOutput,
        totalCost: dashboard.overview.totalCost,
        localCount: dashboard.overview.localCount,
        cloudCount: dashboard.overview.cloudCount,
        localRate: dashboard.overview.localRate,
        satisfactionRate: dashboard.overview.satisfactionRate,
        feedbackCount: dashboard.overview.feedbackCount,
        timeSavedHours: dashboard.overview.timeSavedHours,
        kbSearches: dashboard.knowledge.totalSearches,
        kbHitRate: dashboard.knowledge.hitRate,
        kbMissedQueries: dashboard.knowledge.topMissedQueries,
        topTools: dashboard.topTools,
        activeUsers: dashboard.userStats.length,
        dailyTrend: dashboard.dailyTrend,
        roi: dashboard.roi,
        todayActive,
        collectedAt: new Date().toISOString(),
      };
      const heartbeatResult = await this.sendHeartbeat(stats);
      // Handle token rotation from website
      if (heartbeatResult?.newInstallationToken) {
        await this.db.query(
          'UPDATE jz_installation SET installation_token = $1 WHERE id = $2',
          [heartbeatResult.newInstallationToken, this.installation?.id],
        );
        if (this.installation) {
          this.installation.installationToken = heartbeatResult.newInstallationToken;
        }
        this.logger.log('Installation token rotated by website');
      }
      // Cache update info from heartbeat response
      if (heartbeatResult?.update) {
        this._cachedUpdate = heartbeatResult.update;
        if (heartbeatResult.update.available) {
          this.logger.log(`Update available: ${heartbeatResult.update.version}`);
        }
      }
      this.logger.debug('Heartbeat sent with analytics data');
    } catch (err: any) {
      this.logger.debug(`Heartbeat failed: ${err.message}`);
    }
  }

  // ── Internal ──

  private async loadInstallation() {
    try {
      const { rows } = await this.db.query('SELECT * FROM jz_installation ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1');
      if (rows[0]) {
        this.installation = {
          id: rows[0].id,
          edition: rows[0].edition,
          companyName: rows[0].company_name,
          contactPerson: rows[0].contact_person,
          contactPhone: rows[0].contact_phone,
          installationToken: rows[0].installation_token,
          licenseBlob: rows[0].license_blob,
          creditsBalance: Number(rows[0].credits_balance) || 0,
          registeredAt: rows[0].registered_at,
          lastSync: rows[0].last_sync,
          setupPhase: rows[0].setup_phase || 'pending',
          needsGuidedConfig: rows[0].needs_guided_config ?? true,
        };

        // Try to verify license from DB (v2: bound to this installation's stable id)
        if (this.installation.licenseBlob) {
          try {
            this.licensePayload = verifyLicense(this.installation.licenseBlob, this.installation.id);
            this.licenseExpired = isLicenseExpired(this.licensePayload);
            if (this.licenseExpired) {
              this.logger.warn('License expired — running in degraded mode, will attempt renewal on next daily check');
            } else {
              this.logger.log(`License verified: edition=${this.licensePayload.edition}, expiresAt=${this.licensePayload.expiresAt === 0 ? 'never' : new Date(this.licensePayload.expiresAt * 1000).toISOString()}`);
            }
          } catch (err: any) {
            // Legacy v1 licenses land here too → startup auto-register will fetch a fresh v2 license
            this.logger.error(`License verification failed: ${err.message} — running without license`);
            this.licensePayload = null;
            this._licenseIssue = 'verification_failed';
          }
        }
      }
    } catch (err: any) {
      this.logger.warn(`loadInstallation failed: ${err.message}`);
    }
  }
}
