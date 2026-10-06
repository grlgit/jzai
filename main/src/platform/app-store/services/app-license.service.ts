import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppRegistryService } from './app-registry.service';
import { isAppLicenseExpired, verifyAppLicense } from '../../../edition/app-license';

/**
 * APP 订阅 License 机制层（验签 + 落库 + 安装门控判定）。
 *
 * 解耦边界（设计方案 v1.1）：本服务只提供机制，不含授权审计策略——
 * 每日到期审计循环由闭源 app-store APP 驱动（其本地自验后经
 * facade setAppStatus 回写状态），避免审计被篡改的开源主台禁用。
 */
@Injectable()
export class AppLicenseService {
  private readonly logger = new Logger(AppLicenseService.name);
  private installationId: string | null = null;

  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
  ) {}

  /** 本实例 installationId（与 edition.service 同一数据源） */
  private async getInstallationId(): Promise<string> {
    if (this.installationId) return this.installationId;
    const { rows } = await this.db.query(
      'SELECT id FROM jz_installation ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1',
    );
    const id = rows[0]?.id as string | undefined;
    if (!id) throw new Error('Local installation ID not initialized');
    this.installationId = id;
    return id;
  }

  /**
   * 写入/刷新 APP 的订阅 License（订阅拉取成功后调用）。
   * 验签通过才落库；若 APP 当前处于 license_expired 且新 license 有效，恢复 active。
   */
  async setLicense(appId: string, licenseBlob: string): Promise<void> {
    const installationId = await this.getInstallationId();
    const payload = verifyAppLicense(licenseBlob, installationId, appId); // throws on invalid
    const expiresAt = new Date(payload.expiresAt * 1000);

    await this.registry.updateLicense(appId, licenseBlob, expiresAt);

    const app = await this.registry.findOne(appId);
    if (app?.status === 'license_expired' && !isAppLicenseExpired(payload)) {
      await this.registry.updateStatus(appId, 'active');
      this.logger.log(`App ${appId} license renewed — status restored to active`);
    }
  }

  /** 检查给定 license_blob 对本实例该 APP 是否有效且未过期（安装/升级门控用） */
  async hasValidLicense(appId: string, licenseBlob?: string | null): Promise<boolean> {
    if (!licenseBlob) return false;
    try {
      const installationId = await this.getInstallationId();
      const payload = verifyAppLicense(licenseBlob, installationId, appId);
      return !isAppLicenseExpired(payload);
    } catch {
      return false;
    }
  }
}
