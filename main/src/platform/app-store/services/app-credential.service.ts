import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { CredentialService } from '../../../capability/skill/credential.service';
import { AppRegistryService } from './app-registry.service';
import { AppManifest } from '../validators/manifest.schema';

export const SECRET_REF_PREFIX = 'secret://';

/**
 * Stores and retrieves secret-type config fields for installed apps.
 * Secret values are encrypted at rest using the shared CredentialService (AES-256-GCM).
 * Config column in jz_installed_apps stores a secret:// reference instead.
 */
@Injectable()
export class AppCredentialService {
  private readonly logger = new Logger(AppCredentialService.name);

  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
    private readonly credentialService: CredentialService,
  ) {}

  /** manifest.configSchema 中声明为 type=secret 的字段 key 列表 */
  getSecretFieldKeys(manifest: AppManifest | undefined | null): string[] {
    return (manifest?.configSchema?.fields ?? [])
      .filter(f => f.type === 'secret')
      .map(f => f.key);
  }

  /**
   * 安装/配置更新入口：把 config 中 secret 字段的明文值加密写入 credential store，
   * 返回仅含 secret:// 引用的新 config。幂等：已是引用的值原样保留。
   * 空串/null 表示清除该 secret。
   */
  async extractAndStoreSecrets(
    appId: string,
    config: Record<string, unknown>,
    manifest: AppManifest,
  ): Promise<Record<string, unknown>> {
    const secretKeys = new Set(this.getSecretFieldKeys(manifest));
    if (secretKeys.size === 0) return config;
    const out: Record<string, unknown> = { ...config };
    for (const key of secretKeys) {
      if (!(key in out)) continue;
      const value = out[key];
      if (value === '' || value === null) {
        await this.deleteSecret(appId, key);
        out[key] = null;
        continue;
      }
      if (typeof value !== 'string') continue;
      if (value.startsWith(SECRET_REF_PREFIX)) continue;
      await this.setSecret(appId, key, value);
      out[key] = this.secretRef(appId, key);
    }
    return out;
  }

  /**
   * 对外展示用：secret 字段只回报是否已配置，永不返回引用或明文。
   */
  maskConfig(config: Record<string, unknown>, manifest: AppManifest | undefined | null): Record<string, unknown> {
    const secretKeys = this.getSecretFieldKeys(manifest);
    if (secretKeys.length === 0) return config;
    const out: Record<string, unknown> = { ...config };
    for (const key of secretKeys) {
      if (key in out) out[key] = out[key] ? '[configured]' : null;
    }
    return out;
  }

  async listSecretKeys(appId: string): Promise<string[]> {
    const res = await this.db.query(
      `SELECT key FROM jz_credentials WHERE scope=$1`,
      [`app:${appId}`],
    );
    return res.rows.map((r: { key: string }) => r.key);
  }

  async deleteAllSecrets(appId: string): Promise<void> {
    await this.db.query(`DELETE FROM jz_credentials WHERE scope=$1`, [`app:${appId}`]);
  }

  async setSecret(appId: string, key: string, value: string): Promise<void> {
    const encrypted = this.encrypt(value);
    await this.db.query(
      `INSERT INTO jz_credentials (scope, key, value_enc)
       VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO UPDATE SET value_enc=$3`,
      [`app:${appId}`, key, encrypted],
    );
  }

  async getSecret(appId: string, key: string): Promise<string | null> {
    const res = await this.db.query(
      `SELECT value_enc FROM jz_credentials
       WHERE scope=$1 AND key=$2`,
      [`app:${appId}`, key],
    );
    if (res.rows.length === 0) return null;
    return this.decrypt(res.rows[0].value_enc);
  }

  async deleteSecret(appId: string, key: string): Promise<void> {
    await this.db.query(
      `DELETE FROM jz_credentials WHERE scope=$1 AND key=$2`,
      [`app:${appId}`, key],
    );
  }

  /**
   * Resolve all secret:// references in a config object to their real values.
   * 引用无法解析（已删除/错误引用）时明确失败，不静默注入 null。
   */
  async resolveConfig(appId: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = { ...config };
    for (const [k, v] of Object.entries(resolved)) {
      if (typeof v === 'string' && v.startsWith(`${SECRET_REF_PREFIX}${appId}/`)) {
        const secretKey = v.slice(`${SECRET_REF_PREFIX}${appId}/`.length);
        const value = await this.getSecret(appId, secretKey);
        if (value === null) {
          throw new NotFoundException(`Secret not found for ${appId}: ${v}`);
        }
        resolved[k] = value;
      }
    }
    return resolved;
  }

  private secretRef(appId: string, key: string): string {
    return `${SECRET_REF_PREFIX}${appId}/${key}`;
  }

  private encrypt(plaintext: string): string {
    return this.credentialService.encrypt(plaintext);
  }

  private decrypt(ciphertext: string): string {
    return this.credentialService.decrypt(ciphertext);
  }
}
