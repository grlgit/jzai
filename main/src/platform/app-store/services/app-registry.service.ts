import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppManifest } from '../validators/manifest.schema';

export type AppStatus = 'installing' | 'active' | 'failed' | 'uninstalling' | 'uninstalled' | 'upgrading' | 'license_expired';

export interface InstalledApp {
  id: string;
  appId: string;
  shortName: string;
  nsPrefix: string;
  version: string;
  name: Record<string, string>;
  manifest: AppManifest;
  config: Record<string, unknown>;
  status: AppStatus;
  installedAt: Date;
  updatedAt: Date;
  installDir?: string;
  licenseBlob?: string | null;
  licenseExpiresAt?: Date | null;
  packageSha256?: string | null;
  signatureVerified?: boolean;
}

const APP_COLUMNS = `id, app_id as "appId", short_name as "shortName", ns_prefix as "nsPrefix",
  version, name, manifest, config, status,
  installed_at as "installedAt", updated_at as "updatedAt", extract_dir as "installDir",
  license_blob as "licenseBlob", license_expires_at as "licenseExpiresAt",
  package_sha256 as "packageSha256", signature_verified as "signatureVerified"`;

@Injectable()
export class AppRegistryService {
  private readonly logger = new Logger(AppRegistryService.name);

  constructor(private readonly db: DbService) {}

  async findAll(): Promise<InstalledApp[]> {
    const { rows } = await this.db.query(
      `SELECT ${APP_COLUMNS}
       FROM jz_installed_apps
       WHERE status != 'uninstalled'
       ORDER BY installed_at`,
    );
    return rows;
  }

  async findOne(appId: string): Promise<InstalledApp | null> {
    const { rows } = await this.db.query(
      `SELECT ${APP_COLUMNS}
       FROM jz_installed_apps
       WHERE app_id = $1`,
      [appId],
    );
    return rows[0] ?? null;
  }

  async create(manifest: AppManifest, config: Record<string, unknown>, installDir: string): Promise<InstalledApp> {
    const { rows } = await this.db.query(
      `INSERT INTO jz_installed_apps
         (app_id, short_name, ns_prefix, version, name, manifest, config, status, installed_at, updated_at, extract_dir)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'installing', NOW(), NOW(), $8)
       RETURNING id, app_id as "appId", short_name as "shortName", ns_prefix as "nsPrefix",
                 version, name, manifest, config, status,
                 installed_at as "installedAt", updated_at as "updatedAt", extract_dir as "installDir"`,
      [
        manifest.appId,
        manifest.shortName,
        manifest.nsPrefix,
        manifest.version,
        JSON.stringify(manifest.name),
        JSON.stringify(manifest),
        JSON.stringify(config),
        installDir,
      ],
    );
    return rows[0];
  }

  async updateStatus(appId: string, status: AppStatus): Promise<void> {
    await this.db.query(
      `UPDATE jz_installed_apps SET status = $1, updated_at = NOW() WHERE app_id = $2`,
      [status, appId],
    );
  }

  /** 写入/刷新 APP 订阅 License（续期覆盖） */
  async updateLicense(appId: string, licenseBlob: string, expiresAt: Date | null): Promise<void> {
    await this.db.query(
      `UPDATE jz_installed_apps
       SET license_blob = $1, license_expires_at = $2, updated_at = NOW()
       WHERE app_id = $3`,
      [licenseBlob, expiresAt, appId],
    );
  }

  /** 记录安装包的完整性信息 */
  async updatePackageIntegrity(appId: string, sha256: string | null, signatureVerified: boolean): Promise<void> {
    await this.db.query(
      `UPDATE jz_installed_apps
       SET package_sha256 = $1, signature_verified = $2, updated_at = NOW()
       WHERE app_id = $3`,
      [sha256, signatureVerified, appId],
    );
  }

  async updateConfig(appId: string, config: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `UPDATE jz_installed_apps SET config = $1, updated_at = NOW() WHERE app_id = $2`,
      [JSON.stringify(config), appId],
    );
  }

  async updateManifest(appId: string, manifest: AppManifest, installDir: string): Promise<void> {
    await this.db.query(
      `UPDATE jz_installed_apps
       SET manifest=$1, version=$2, updated_at=NOW(), extract_dir=$3
       WHERE app_id=$4`,
      [JSON.stringify(manifest), manifest.version, installDir, appId],
    );
  }

  async restore(manifest: AppManifest, config: Record<string, unknown>, installDir: string): Promise<void> {
    await this.db.query(
      `UPDATE jz_installed_apps
       SET short_name=$2, ns_prefix=$3, version=$4, name=$5, manifest=$6, config=$7,
           status='installing', installed_at=NOW(), updated_at=NOW(), extract_dir=$8
       WHERE app_id=$1 AND status='uninstalled'`,
      [
        manifest.appId,
        manifest.shortName,
        manifest.nsPrefix,
        manifest.version,
        JSON.stringify(manifest.name),
        JSON.stringify(manifest),
        JSON.stringify(config),
        installDir,
      ],
    );
  }

  async delete(appId: string): Promise<void> {
    await this.db.query(`DELETE FROM jz_installed_apps WHERE app_id = $1`, [appId]);
  }

  async getExistingIds(): Promise<{
    appIds: Set<string>;
    shortNames: Set<string>;
    nsPrefixes: Set<string>;
    schemaNames: Set<string>;
    panelIds: Set<string>;
    toolIds: Set<string>;
  }> {
    const { rows } = await this.db.query(
      `SELECT app_id, short_name, ns_prefix,
              manifest->'database'->>'schemaName' as schema_name,
              manifest->'panels' as panels,
              manifest->'backend'->'toolProviders' as tool_providers
       FROM jz_installed_apps WHERE status != 'uninstalled'`,
    );

    const appIds = new Set<string>();
    const shortNames = new Set<string>();
    const nsPrefixes = new Set<string>();
    const schemaNames = new Set<string>();
    const panelIds = new Set<string>();
    const toolIds = new Set<string>();

    for (const row of rows) {
      appIds.add(row.app_id);
      shortNames.add(row.short_name);
      nsPrefixes.add(row.ns_prefix);
      if (row.schema_name) schemaNames.add(row.schema_name);
      for (const panel of row.panels ?? []) panelIds.add(panel.id);
      for (const tp of row.tool_providers ?? [])
        for (const tid of tp.toolIds ?? []) toolIds.add(tid);
    }

    return { appIds, shortNames, nsPrefixes, schemaNames, panelIds, toolIds };
  }
}
