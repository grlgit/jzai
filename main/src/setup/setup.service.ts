import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import * as path from 'path';
import { DbService } from '../db/db.service';
import { EditionService } from '../edition/edition.service';
import { ModelRouterService } from '../model-router/model-router.service';
import { ConfigService } from '@nestjs/config';

export type SetupPhase = 'pending' | 'registered' | 'complete';

export interface SetupStatus {
  phase: SetupPhase;
  registered: boolean;
  needsGuidedConfig: boolean;
  companyName?: string;
  currentVersion?: string;
  updateAvailable?: boolean;
  licenseIssue?: string;
  tokenInvalid?: boolean;   // 启动校验发现 installation token 被官网拒绝且自愈失败 → UI 引导重新注册
}

export interface HealthResult {
  db: { status: 'ok' | 'error'; message?: string };
  kb: { status: 'ok' | 'error'; message?: string };
  localModel: { status: 'ok' | 'error'; message?: string; models?: string[] };
  cloudModel: { status: 'ok' | 'error'; message?: string };
  overall: boolean;
}

@Injectable()
export class SetupService {
  private readonly logger = new Logger(SetupService.name);

  constructor(
    private readonly db: DbService,
    private readonly edition: EditionService,
    private readonly modelRouter: ModelRouterService,
    private readonly config: ConfigService,
  ) {}

  async getSetupStatus(): Promise<SetupStatus> {
    try {
      const { rows } = await this.db.query(
        'SELECT setup_phase, needs_guided_config FROM jz_installation ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1',
      );
      if (!rows[0]) {
        return { phase: 'pending', registered: false, needsGuidedConfig: true };
      }
      return {
        phase: rows[0].setup_phase as SetupPhase,
        registered: this.edition.isRegistered(),
        needsGuidedConfig: rows[0].needs_guided_config,
        companyName: this.edition.getInstallation()?.companyName || undefined,
        currentVersion: this.edition.getCurrentVersion(),
        updateAvailable: this.edition.getCachedUpdate()?.available || false,
        licenseIssue: this.edition.getLicenseIssue() || undefined,
        tokenInvalid: this.edition.isTokenInvalid(),
      };
    } catch {
      return { phase: 'pending', registered: false, needsGuidedConfig: true };
    }
  }

  async setAdminPassword(password: string): Promise<void> {
    // Phase gate: only allowed during 'registered' phase
    const status = await this.getSetupStatus();
    if (status.phase !== 'registered') {
      throw new ForbiddenException('当前阶段不允许设置密码');
    }

    // Validate password
    if (!password || password.length < 8) {
      throw new Error('密码长度至少8位');
    }
    if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      throw new Error('密码需包含字母和数字');
    }

    // Find admin user
    const { rows } = await this.db.query(
      "SELECT id FROM jz_users WHERE role_id = 'admin' LIMIT 1",
    );
    if (!rows[0]) {
      throw new Error('管理员账户不存在');
    }

    // Update password + mark as changed
    const hash = await bcrypt.hash(password, 10);
    await this.db.query(
      'UPDATE jz_users SET password = $1, password_changed = TRUE WHERE id = $2',
      [hash, rows[0].id],
    );

    // Advance phase to 'complete' and dismiss guided config banner
    await this.db.query(
      "UPDATE jz_installation SET setup_phase = 'complete', needs_guided_config = FALSE",
    );

    // Delete init password file if exists
    try {
      const pwFile = path.join(process.cwd(), '.init-admin-password');
      if (fs.existsSync(pwFile)) {
        fs.unlinkSync(pwFile);
        this.logger.log('Deleted .init-admin-password file');
      }
    } catch (err: any) {
      this.logger.warn(`Failed to delete .init-admin-password: ${err.message}`);
    }

    this.logger.log('Admin password set via setup wizard, phase advanced to complete');
  }

  async getHealth(): Promise<HealthResult> {
    const result: HealthResult = {
      db: { status: 'error' },
      kb: { status: 'error' },
      localModel: { status: 'error' },
      cloudModel: { status: 'error' },
      overall: false,
    };

    // DB check
    try {
      await this.db.query('SELECT 1');
      result.db = { status: 'ok' };
    } catch (err: any) {
      result.db = { status: 'error', message: err.message };
    }

    // KB check（知识库已并入主台：检查企业空间是否就绪）
    try {
      const { rows } = await this.db.query(
        "SELECT 1 FROM jz_kb_spaces WHERE slug = 'ent-default' LIMIT 1",
      );
      result.kb = rows.length > 0 ? { status: 'ok' } : { status: 'error', message: '企业空间未初始化' };
    } catch (err: any) {
      result.kb = { status: 'error', message: err.message };
    }

    // Local model (Ollama)
    const ollamaEndpoint = this.config.get('OLLAMA_ENDPOINT', 'http://localhost:11434');
    try {
      const resp = await fetch(`${ollamaEndpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const models = (data.models || []).map((m: any) => m.name);
        result.localModel = { status: 'ok', models };
      } else {
        result.localModel = { status: 'error', message: `HTTP ${resp.status}` };
      }
    } catch {
      result.localModel = { status: 'error', message: 'Ollama 未连接' };
    }

    // Cloud model — has own key OR registered (fallback to official proxy)
    const hasOwnKey = this.modelRouter.getConfig().hasCloudKey;
    const canUseOfficialProxy = !hasOwnKey && this.edition.isRegistered();
    if (hasOwnKey || canUseOfficialProxy) {
      result.cloudModel = { status: 'ok' };
    } else {
      result.cloudModel = { status: 'error', message: 'API Key 未配置' };
    }

    // Overall: DB ok + at least one model source
    result.overall = result.db.status === 'ok' &&
      (result.localModel.status === 'ok' || result.cloudModel.status === 'ok');

    return result;
  }

  async completeGuidedConfig(): Promise<void> {
    await this.db.query(
      'UPDATE jz_installation SET needs_guided_config = FALSE',
    );
  }

  /** Called by EditionService after successful registration to advance phase */
  async advanceToRegistered(): Promise<void> {
    try {
      const { rows } = await this.db.query(
        "SELECT setup_phase FROM jz_installation ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1",
      );
      if (rows[0]?.setup_phase === 'pending') {
        await this.db.query(
          "UPDATE jz_installation SET setup_phase = 'registered'",
        );
        this.logger.log('Setup phase advanced to registered');
      }
    } catch (err: any) {
      this.logger.warn(`advanceToRegistered failed: ${err.message}`);
    }
  }
}
