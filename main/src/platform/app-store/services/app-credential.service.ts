import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { CredentialService } from '../../../capability/skill/credential.service';
import { AppRegistryService } from './app-registry.service';

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

  async setSecret(appId: string, key: string, value: string): Promise<void> {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);

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

  /** Resolve all secret:// references in a config object to their real values */
  async resolveConfig(appId: string, config: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resolved: Record<string, unknown> = { ...config };
    for (const [k, v] of Object.entries(resolved)) {
      if (typeof v === 'string' && v.startsWith(`secret://${appId}/`)) {
        const secretKey = v.slice(`secret://${appId}/`.length);
        resolved[k] = await this.getSecret(appId, secretKey);
      }
    }
    return resolved;
  }

  private encrypt(plaintext: string): string {
    return this.credentialService.encrypt(plaintext);
  }

  private decrypt(ciphertext: string): string {
    return this.credentialService.decrypt(ciphertext);
  }
}
