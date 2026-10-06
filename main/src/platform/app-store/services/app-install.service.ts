import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

/**
 * fs.cpSync 的兼容替代：部分文件系统（macOS Docker Desktop gRPC FUSE、某些 NFS）
 * 不支持 cpSync 内部使用的 copyfile/clonefile 调用，会确定性 EACCES 并留下
 * mode-200 空文件。改用 mkdir + readFile/writeFile 的朴素递归复制。
 */
export function copyDirCompat(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirCompat(s, d);
    } else if (entry.isFile()) {
      fs.writeFileSync(d, fs.readFileSync(s));
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(s), d);
    }
  }
}
import { WorkspaceService } from '../../../workspace/workspace.service';
import { AppManifest, AppManifestSchema } from '../validators/manifest.schema';
import { AppValidatorService } from '../validators/app-validator.service';
import { AppRegistryService } from './app-registry.service';
import { AppSchemaService } from './app-schema.service';
import { AppMigrationService } from './app-migration.service';
import { AppPoolService } from './app-pool.service';
import { AppActivationService } from './app-activation.service';
import { AppCapabilityService } from './app-capability.service';
import { AppCredentialService } from './app-credential.service';
import { AppLicenseService } from './app-license.service';
import { SafeArchiveService } from './safe-archive.service';
import { PackageSignatureService } from './package-signature.service';
import { FIRST_PARTY_APP_ID } from './app-platform.service';
import { emitAppUpdated } from '../runtime/app-events';

export type AppInstallProgressReporter = (
  phase: 'installing' | 'provisioning' | 'migrating' | 'activating',
  percent: number,
  message: string,
) => void;

export const ORPHANED_DATABASE_RESOURCES_ERROR = 'APP_DATABASE_RESIDUE';

export interface AppInstallOptions {
  purgeOrphanedData?: boolean;
  /** stage 阶段已计算的包完整性信息（直接 install() 路径现场计算） */
  packageSha256?: string | null;
  signatureVerified?: boolean;
}

interface FailedInstallResources {
  installDirCreated: boolean;
  registryCreated: boolean;
  registryRestored: boolean;
  schemaCreated: boolean;
  poolCreated: boolean;
  activationStarted: boolean;
}

@Injectable()
export class AppInstallService {
  private readonly logger = new Logger(AppInstallService.name);

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly archives: SafeArchiveService,
    private readonly validator: AppValidatorService,
    private readonly registry: AppRegistryService,
    private readonly schema: AppSchemaService,
    private readonly migrations: AppMigrationService,
    private readonly pools: AppPoolService,
    private readonly activation: AppActivationService,
    private readonly capabilities: AppCapabilityService,
    private readonly credentials: AppCredentialService,
    private readonly signatures: PackageSignatureService,
    private readonly appLicenses: AppLicenseService,
  ) {}

  async validatePackage(packagePath: string) {
    const extractDir = await this.extractToTemp(packagePath);
    try {
      const ids = await this.registry.getExistingIds();
      return await this.validator.validate(
        extractDir,
        ids.appIds,
        ids.shortNames,
        ids.nsPrefixes,
        ids.schemaNames,
        ids.panelIds,
        ids.toolIds,
      );
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  async install(
    packagePath: string,
    config: Record<string, unknown> = {},
    reportProgress?: AppInstallProgressReporter,
  ): Promise<void> {
    const packageSha256 = await this.signatures.hashFile(packagePath);
    const extractDir = await this.extractToTemp(packagePath);
    try {
      await this.installFromStage(extractDir, config, reportProgress, { packageSha256 });
    } finally {
      fs.rmSync(extractDir, { recursive: true, force: true });
    }
  }

  async installFromStage(
    extractDir: string,
    config: Record<string, unknown> = {},
    reportProgress?: AppInstallProgressReporter,
    options: AppInstallOptions = {},
  ): Promise<void> {
    reportProgress?.('installing', 50, '正在复核应用包…');
    const ids = await this.registry.getExistingIds();
    const report = await this.validator.validate(
      extractDir,
      ids.appIds,
      ids.shortNames,
      ids.nsPrefixes,
      ids.schemaNames,
      ids.panelIds,
      ids.toolIds,
    );

    if (!report.passed) {
      throw new BadRequestException(
        `Package validation failed: ${report.criticals.map(critical => critical.message).join('; ')}`,
      );
    }

    const manifest = AppManifestSchema.parse(
      JSON.parse(fs.readFileSync(path.join(extractDir, 'manifest.json'), 'utf-8')),
    );

    // 包签名验签（install 为最终强制点；stage 已做 fail-fast）
    const sigResult = this.signatures.verifyDirectory(extractDir);
    const sigCheck = this.signatures.check(sigResult, FIRST_PARTY_APP_ID.test(manifest.appId));
    if (!sigCheck.ok) {
      throw new BadRequestException(sigCheck.warning);
    }
    const signatureVerified = sigResult.status === 'valid';

    const existing = await this.registry.findOne(manifest.appId);
    const restoring = existing?.status === 'uninstalled';
    if (existing && !restoring) {
      throw new BadRequestException(`App ${manifest.appId} is already registered`);
    }
    if (restoring) {
      this.assertRestorableDatabase(existing.manifest, manifest);
    } else if (manifest.database) {
      const resources = await this.schema.getResourceState(manifest);
      if (resources.roleExists || resources.schemaExists) {
        if (!options.purgeOrphanedData) {
          throw new BadRequestException(ORPHANED_DATABASE_RESOURCES_ERROR);
        }
        await this.schema.purgeOrphanedResources(manifest);
      }
    }

    reportProgress?.('provisioning', 60, '正在准备应用运行环境…');
    if (manifest.database) {
      const canCreate = await this.schema.checkCreaterolePrivilege();
      if (!canCreate) {
        throw new BadRequestException(
          'The platform database user does not have CREATEROLE privilege. ' +
          'Cannot create per-app PostgreSQL schema. Please grant CREATEROLE to the platform DB user.',
        );
      }
    }

    // 版本目录协议：app-store/<shortName>/versions/<version>，registry extract_dir 即 active 指针
    const appRootDir = path.join(this.workspace.getRoot(), 'app-store', manifest.shortName);
    const installDir = path.join(appRootDir, 'versions', manifest.version);
    const resources: FailedInstallResources = {
      installDirCreated: false,
      registryCreated: false,
      registryRestored: false,
      schemaCreated: false,
      poolCreated: false,
      activationStarted: false,
    };

    try {
      if (fs.existsSync(installDir)) {
        throw new BadRequestException(`Install directory already exists for app ${manifest.appId}`);
      }
      // 全新安装不允许残留应用根目录（旧版本目录属于其他版本升级场景，不在安装路径出现）
      if (!restoring && fs.existsSync(appRootDir) && fs.readdirSync(appRootDir).length > 0) {
        throw new BadRequestException(`Install directory already exists for app ${manifest.appId}`);
      }
      fs.mkdirSync(installDir, { recursive: true });
      resources.installDirCreated = true;
      copyDirCompat(extractDir, installDir);

      // secret 字段：密文入 credential store，registry 只保留 secret:// 引用（先 extract 再落库，避免明文写入）
      config = await this.credentials.extractAndStoreSecrets(manifest.appId, config, manifest);
      if (restoring) {
        await this.registry.restore(manifest, config, installDir);
        resources.registryRestored = true;
      } else {
        await this.registry.create(manifest, config, installDir);
        resources.registryCreated = true;
      }
      await this.registry.updatePackageIntegrity(
        manifest.appId, options.packageSha256 ?? null, signatureVerified,
      );

      if (manifest.database) {
        const rolePassword = crypto.randomBytes(32).toString('hex');
        if (restoring) {
          await this.schema.restoreSchemaAndRole(manifest, rolePassword);
        } else {
          await this.schema.createSchemaAndRole(manifest, rolePassword);
          resources.schemaCreated = true;
        }

        const connection = this.getDatabaseConnection();
        await this.pools.createPool(manifest.appId, {
          ...connection,
          user: this.schema.getRoleName(manifest)!,
          password: rolePassword,
          max: manifest.database.poolMax ?? 3,
        });
        resources.poolCreated = true;

        reportProgress?.('migrating', 75, '正在执行应用数据库迁移…');
        const plan = await this.migrations.plan(manifest.appId, manifest, installDir);
        await this.migrations.up(manifest.appId, plan, installDir);
      }

      reportProgress?.('activating', 90, '正在激活应用面板和工具…');
      resources.activationStarted = true;
      await this.activation.activateApp(manifest.appId, installDir, manifest);

      // 订阅 License 门控：requiresLicense 且无有效 license → license_expired（安装成功但不可用）
      let finalStatus: 'active' | 'license_expired' = 'active';
      if (manifest.requiresLicense) {
        const licensed = await this.appLicenses.hasValidLicense(manifest.appId, existing?.licenseBlob);
        if (!licensed) {
          finalStatus = 'license_expired';
          reportProgress?.('activating', 95, '应用已安装，需在应用商城订阅授权后使用');
          this.logger.log(`App ${manifest.appId} requires license — installed as license_expired`);
        }
      }
      await this.registry.updateStatus(manifest.appId, finalStatus);
      emitAppUpdated(manifest.appId, manifest.version);
      this.logger.log(`App ${manifest.appId} installed successfully`);
    } catch (err) {
      await this.cleanupFailedInstall(manifest, installDir, resources);
      // 清理版本目录的父目录（versions/ 与 <shortName>/），保持安装失败无残留
      this.pruneEmptyParents(installDir);
      throw err;
    }
  }

  /** 删除 installDir 之上为空的 versions/ 与 <shortName>/ 目录（仅空目录才删，天然幂等） */
  private pruneEmptyParents(installDir: string): void {
    let dir = path.dirname(installDir);
    for (let i = 0; i < 2; i++) {
      try {
        fs.rmdirSync(dir); // 仅当目录为空时成功
      } catch {
        break;
      }
      dir = path.dirname(dir);
    }
  }

  private assertRestorableDatabase(previous: AppManifest, next: AppManifest): void {
    const previousSchema = previous.database?.schemaName;
    const nextSchema = next.database?.schemaName;
    if (previousSchema !== nextSchema) {
      throw new BadRequestException('保留数据的应用不能在重新安装时更改数据库 schema。请先彻底卸载旧数据。');
    }
  }

  private getDatabaseConnection(): { host: string; port: number; database: string } {
    const connectionUrl = process.env.DATABASE_URL;
    if (connectionUrl) {
      const connection = new URL(connectionUrl);
      return {
        host: connection.hostname,
        port: parseInt(connection.port || '5432'),
        database: connection.pathname.slice(1),
      };
    }

    return {
      host: process.env.PG_HOST ?? 'localhost',
      port: Number(process.env.PG_PORT ?? '5432'),
      database: process.env.PG_DATABASE ?? 'jianzhi',
    };
  }

  private async cleanupFailedInstall(
    manifest: AppManifest,
    installDir: string,
    resources: FailedInstallResources,
  ): Promise<void> {
    await this.cleanupStep(`removing secrets for app ${manifest.appId}`, () =>
      this.credentials.deleteAllSecrets(manifest.appId),
    );
    if (resources.registryCreated) {
      await this.cleanupStep(`marking app ${manifest.appId} as failed`, () =>
        this.registry.updateStatus(manifest.appId, 'failed'),
      );
    }
    if (resources.registryRestored) {
      await this.cleanupStep(`restoring app ${manifest.appId} to uninstalled`, () =>
        this.registry.updateStatus(manifest.appId, 'uninstalled'),
      );
    }
    if (resources.activationStarted) {
      await this.cleanupStep(`deactivating app ${manifest.appId}`, () =>
        this.deactivatePartialApp(manifest),
      );
    }
    if (resources.poolCreated) {
      await this.cleanupStep(`destroying pool for app ${manifest.appId}`, () =>
        this.pools.destroyPool(manifest.appId),
      );
    }
    if (resources.schemaCreated) {
      await this.cleanupStep(`removing migration metadata for app ${manifest.appId}`, () =>
        this.migrations.dropAll(manifest.appId),
      );
      await this.cleanupStep(`dropping schema for app ${manifest.appId}`, () =>
        this.schema.dropSchemaAndRole(manifest),
      );
    }
    if (resources.installDirCreated) {
      await this.cleanupStep(`removing install directory for app ${manifest.appId}`, () =>
        fs.rmSync(installDir, { recursive: true, force: true }),
      );
    }
    if (resources.registryCreated) {
      await this.cleanupStep(`removing registry record for app ${manifest.appId}`, () =>
        this.registry.delete(manifest.appId),
      );
    }
  }

  private async cleanupStep(label: string, operation: () => void | Promise<void>): Promise<void> {
    try {
      await operation();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Failed while ${label}: ${message}`);
    }
  }

  private async deactivatePartialApp(manifest: AppManifest): Promise<void> {
    await this.activation.deactivateApp(manifest.appId, 'uninstall');
    await this.activation.removePanels(manifest.appId);
    this.activation.removeAgents(manifest);
    this.activation.removeSkills(manifest);
    this.activation.reloadRegistries();
    await this.capabilities.removeForApp(manifest.appId);
  }

  private async extractToTemp(packagePath: string): Promise<string> {
    const tempDir = path.join(
      os.tmpdir(),
      `jzapp_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    );
    await this.archives.extract(packagePath, tempDir);
    return tempDir;
  }
}
