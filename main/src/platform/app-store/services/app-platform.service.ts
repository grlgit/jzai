import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { AppManifest } from '../validators/manifest.schema';
import { AppRegistryService } from './app-registry.service';
import { AppLogService, AppLogEntry } from './app-log.service';
import { AppValidatorService } from '../validators/app-validator.service';
import { ToolBridgeService } from '../../../agent/tool-bridge/tool-bridge.service';
import { AppCapabilityService } from './app-capability.service';
import type { AppInstallService } from './app-install.service';
import type { AppUpgradeService } from './app-upgrade.service';
import { AppStagingService } from './app-staging.service';
import { AppInstallOperationService } from './app-install-operation.service';
import { AppLicenseService } from './app-license.service';
import { DbService } from '../../../db/db.service';
import { createServicePrincipal } from '../runtime/invocation-principal';

/**
 * AppInstallService/AppUpgradeService 与 AppActivationService 存在构造期循环
 * （activation → app-platform → install → activation）。
 * 这两个类只能 import type + 调用时 lazy require，不可顶层 import 运行时值。
 */
function lazyInstall(): typeof AppInstallService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./app-install.service').AppInstallService;
}
function lazyUpgrade(): typeof AppUpgradeService {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('./app-upgrade.service').AppUpgradeService;
}

/**
 * 首方运行时通道（design-app-dev-mcp §3.4 AppContext.platform）。
 * 仅注入给声明 appstore:* 且通过首方校验的扩展包（jz-devtools）。
 * 跨模块服务经 ModuleRef 惰性解析，避免 DI 循环。
 */
export interface AppPlatformFacade {
  stageAndInstall?(
    files: Record<string, string>,
    config?: Record<string, unknown>,
  ): Promise<{ appId: string; status: string }>;
  upgrade?(appId: string, files: Record<string, string>): Promise<{ ok: true }>;
  validatePackage?(
    files: Record<string, string>,
  ): Promise<{ ok: boolean; issues: Array<{ code: string; path?: string; message: string; hint?: string }> }>;
  listPlatformTools?(): Promise<Array<{ id: string; group?: string; description?: string; source: string }>>;
  describeTool?(toolId: string): Promise<unknown>;
  callTool?(toolId: string, params: unknown): Promise<unknown>;
  readLogs?(appId: string, since?: number): Promise<AppLogEntry[]>;
  /**
   * 官网商城中性原语（appstore:market）。
   * 安全模型：商城 HTTP、订阅判定、License 验签、包验签全部在调用方（闭源 APP）内完成；
   * 主台只提供本机凭据读取与安装/落库机制，这些原语无法帮助伪造授权——
   * token 签不出 license，setAppLicense 自身验签，安装链路强制包验签。
   */
  market?: {
    websiteUrl(): Promise<string>;
    installationToken(): Promise<string>;
    installationId(): Promise<string>;
    listInstalledApps(): Promise<Array<{
      appId: string; version: string; status: string;
      licenseBlob: string | null; licenseExpiresAt: string | null;
      installDir: string | null;
    }>>;
    installPackage(packagePath: string): Promise<{ appId: string }>;
    upgradePackage(appId: string, packagePath: string): Promise<void>;
    setAppLicense(appId: string, licenseBlob: string): Promise<void>;
    /** 授权审计回写：仅限 'active' | 'license_expired'（其他状态由运行时状态机管理） */
    setAppStatus(appId: string, status: 'active' | 'license_expired'): Promise<void>;
  };
}

export const FIRST_PARTY_APP_ID = /^com\.(jianzhi|menhu)\./;

@Injectable()
export class AppPlatformService {
  private readonly logger = new Logger(AppPlatformService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly registry: AppRegistryService,
    private readonly logs: AppLogService,
    private readonly capabilities: AppCapabilityService,
    private readonly db: DbService,
    private readonly staging: AppStagingService,
    private readonly operations: AppInstallOperationService,
    private readonly appLicenses: AppLicenseService,
  ) {}

  /**
   * 按 manifest 声明构建门控门面。
   * 非首方 appId / 未声明 appstore:* → undefined（普通包拿不到平台能力）。
   */
  buildFacade(manifest: AppManifest): AppPlatformFacade | undefined {
    if (!FIRST_PARTY_APP_ID.test(manifest.appId)) return undefined;
    const caps = manifest.platformCapabilities ?? [];
    const facade: AppPlatformFacade = {};

    if (caps.includes('appstore:manage')) {
      facade.stageAndInstall = (files, config) => this.stageAndInstall(files, config);
      facade.upgrade = (appId, files) => this.upgradeApp(appId, files);
      facade.validatePackage = files => this.validatePackage(files);
      facade.listPlatformTools = () => this.listPlatformTools();
      facade.describeTool = toolId => this.describeTool(toolId);
      const principal = createServicePrincipal(manifest.appId, 'app-platform', ['app:invoke']);
      facade.callTool = (toolId, params) =>
        this.moduleRef.get(ToolBridgeService, { strict: false }).callTool(toolId, params, principal);
    }
    if (caps.includes('appstore:read-logs')) {
      facade.readLogs = (appId, since) => Promise.resolve(this.logs.read(appId, since ?? 0));
    }
    if (caps.includes('appstore:market')) {
      facade.market = {
        websiteUrl: () => Promise.resolve(
          (process.env.JIANZHI_WEBSITE_URL || 'http://198.18.4.231').replace(/\/$/, ''),
        ),
        installationToken: () => this.getInstallationToken(),
        installationId: () => this.getInstallationId(),
        listInstalledApps: () => this.listInstalledApps(),
        installPackage: packagePath => this.installPackage(packagePath),
        upgradePackage: (appId, packagePath) =>
          this.moduleRef.get(lazyUpgrade(), { strict: false }).upgrade(appId, packagePath),
        setAppLicense: (appId, licenseBlob) => this.appLicenses.setLicense(appId, licenseBlob),
        setAppStatus: (appId, status) => this.setAppStatus(appId, status),
      };
    }
    return Object.keys(facade).length > 0 ? facade : undefined;
  }

  // ── market 原语实现 ──

  private async setAppStatus(appId: string, status: 'active' | 'license_expired'): Promise<void> {    if (!['active', 'license_expired'].includes(status)) {
      throw new Error(`setAppStatus 仅允许 active | license_expired，收到 ${status}`);
    }
    const app = await this.registry.findOne(appId);
    if (!app) throw new Error(`App ${appId} not found`);
    // 只允许在授权相关状态间迁移，不干预 installing/upgrading/failed 等运行时状态
    if (!['active', 'license_expired'].includes(app.status)) {
      throw new Error(`App ${appId} 当前状态 ${app.status} 不允许审计回写`);
    }
    await this.registry.updateStatus(appId, status);
  }

  private async getInstallationToken(): Promise<string> {
    let rows: any[];
    try {
      ({ rows } = await this.db.query(
        `SELECT installation_token, previous_token, previous_token_expires
         FROM jz_installation
         ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1`,
      ));
    } catch {
      // 老库无 previous_token 列（043 迁移前）
      ({ rows } = await this.db.query(
        `SELECT installation_token FROM jz_installation
         ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1`,
      ));
    }
    const row = rows[0];
    if (row?.installation_token) return row.installation_token;
    if (row?.previous_token && row.previous_token_expires && new Date(row.previous_token_expires) > new Date()) {
      return row.previous_token;
    }
    throw new Error('本实例尚未注册官网账号，无法访问应用商城');
  }

  private async getInstallationId(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT id FROM jz_installation
       ORDER BY installation_token IS NOT NULL DESC, setup_phase DESC LIMIT 1`,
    );
    if (!rows[0]?.id) throw new Error('本实例 installationId 尚未初始化');
    return rows[0].id;
  }

  private async listInstalledApps() {
    const apps = await this.registry.findAll();
    return apps.map(a => ({
      appId: a.appId,
      version: a.version,
      status: a.status,
      licenseBlob: a.licenseBlob ?? null,
      licenseExpiresAt: a.licenseExpiresAt ? a.licenseExpiresAt.toISOString() : null,
      installDir: a.installDir ?? null,
    }));
  }

  /** stage → 等待校验通过 → installFromStage（同步完成，失败抛错） */
  private async installPackage(packagePath: string): Promise<{ appId: string }> {
    const op = this.staging.start(packagePath);
    const deadline = Date.now() + 10 * 60 * 1000;
    let status = op;
    while (Date.now() < deadline) {
      status = this.operations.get(op.stageId);
      if (status.phase === 'ready') break;
      if (['failed', 'expired'].includes(status.phase)) {
        throw new Error(status.errors.join('; ') || status.message);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (status.phase !== 'ready') throw new Error('安装准备超时');

    const stageDir = this.operations.getInstallStageDir(op.stageId);
    const integrity = this.operations.getIntegrity(op.stageId);
    try {
      await this.moduleRef.get(lazyInstall(), { strict: false }).installFromStage(
        stageDir, {}, () => {},
        {
          purgeOrphanedData: false,
          packageSha256: integrity?.packageSha256 ?? null,
          signatureVerified: integrity?.signatureVerified ?? false,
        },
      );
      this.operations.succeed(op.stageId);
    } finally {
      this.operations.clearStageDir(op.stageId);
    }
    return { appId: status.manifest!.appId };
  }

  // ── 实现 ──

  private async stageAndInstall(
    files: Record<string, string>,
    config?: Record<string, unknown>,
  ): Promise<{ appId: string; status: string }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-install-'));
    try {
      await this.writeFiles(dir, files);
      const manifest = this.readManifest(dir);
      await this.moduleRef.get(lazyInstall(), { strict: false })
        .installFromStage(dir, config ?? {}, () => {}, {});
      return { appId: manifest.appId, status: 'active' };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  private async upgradeApp(appId: string, files: Record<string, string>): Promise<{ ok: true }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-upgrade-'));
    const zipPath = path.join(os.tmpdir(), `jzdev_${Date.now()}.jzapp`);
    try {
      await this.writeFiles(dir, files);
      await this.zipDir(dir, zipPath);
      await this.moduleRef.get(lazyUpgrade(), { strict: false }).upgrade(appId, zipPath);
      return { ok: true };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
      fs.rm(zipPath, { force: true }, () => {});
    }
  }

  private async validatePackage(
    files: Record<string, string>,
  ): Promise<{ ok: boolean; issues: Array<{ code: string; path?: string; message: string; hint?: string }> }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jzdev-validate-'));
    try {
      await this.writeFiles(dir, files);
      const ids = await this.registry.getExistingIds();
      const report = await this.moduleRef.get(AppValidatorService, { strict: false }).validate(
        dir, ids.appIds, ids.shortNames, ids.nsPrefixes, ids.schemaNames, ids.panelIds, ids.toolIds,
      );
      const issues = [...report.criticals, ...report.warnings].map((c: any) => ({
        code: c.code,
        message: c.message,
        path: c.details,
        hint: this.hintFor(c.code),
      }));
      return { ok: report.passed, issues };
    } finally {
      fs.rm(dir, { recursive: true, force: true }, () => {});
    }
  }

  /** 机器可读修复建议（dev agent 自纠用） */
  private hintFor(code: string): string | undefined {
    const hints: Record<string, string> = {
      MISSING_MANIFEST: '在包根目录添加 manifest.json（参照 jzdev://docs/manifest-schema）',
      INVALID_MANIFEST: '按 jzdev://docs/manifest-schema 修正字段格式',
      DUPLICATE_APP_ID: '更换 appId（反向域名，全局唯一）',
      DUPLICATE_SHORT_NAME: '更换 shortName',
      DUPLICATE_NS_PREFIX: '更换 nsPrefix，并同步改所有标识符前缀',
      AGENT_TOOL_NOT_DECLARED: '把该工具加入 manifest backend.toolProviders[].toolIds，或从 agent yaml 的 tools 中移除',
      PLATFORM_TOOL_NOT_ALLOWED: '从 usesPlatformTools 移除该工具；仅 L1 数据生成/L2 连接器只读/L3 界面控制类可声明',
      DEV_CAP_NOT_FIRST_PARTY: 'appstore:* 能力仅首方包可声明，请移除',
      MCP_EXPOSE_NOT_FIRST_PARTY: 'mcpExposed 仅首方包可声明，请移除',
      MIGRATION_VERSION_GAP: 'migrations 版本号从 1 开始连续编号',
      MIGRATION_FILE_MISSING: '补齐迁移 SQL 文件或从 manifest.migrations 移除该条',
      MISSING_README: '补充 README.md（≥200 字符，说明用途与配置）',
    };
    return hints[code];
  }

  private async listPlatformTools(): Promise<Array<{ id: string; group?: string; description?: string; source: string }>> {
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const catalog = bridge.getCatalog();
    const sourceMap = await this.capabilities.getSourceMap();
    const appTools = sourceMap.get('tool') ?? new Map();
    return catalog.map((e: any) => {
      const src = appTools.get(e.id ?? e.name);
      return {
        id: e.id ?? e.name,
        group: e.group,
        description: e.description,
        source: src ? `app:${src.name}` : 'builtin',
      };
    });
  }

  private async describeTool(toolId: string): Promise<unknown> {
    const all = await this.listPlatformTools();
    const found = all.find(t => t.id === toolId);
    if (!found) throw new Error(`Tool not found: ${toolId}`);
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const full = bridge.getCatalog().find((e: any) => (e.id ?? e.name) === toolId);
    return { ...found, parameters: (full as any)?.parameters ?? null };
  }

  // ── 工具方法 ──

  private async writeFiles(dir: string, files: Record<string, string>): Promise<void> {
    const entries = Object.entries(files);
    if (entries.length > 5000) throw new Error('Too many files: maximum is 5000');
    const totalBytes = entries.reduce((sum, [, content]) => sum + Buffer.byteLength(content, 'utf-8'), 0);
    if (totalBytes > 200 * 1024 * 1024) throw new Error('File content exceeds 200MB limit');

    const seen = new Map<string, string>();
    for (const [rel, content] of entries) {
      if (!rel || rel.includes('\0') || rel.includes('\\') || path.posix.isAbsolute(rel)
        || path.win32.isAbsolute(rel) || rel.split('/').includes('..')) {
        throw new Error(`Illegal file path: ${rel}`);
      }
      const normalized = path.posix.normalize(rel);
      const lower = normalized.toLocaleLowerCase('en-US');
      const previous = seen.get(lower);
      if (previous) throw new Error(`Duplicate or case-conflicting file path: ${previous} / ${rel}`);
      seen.set(lower, normalized);

      const target = path.resolve(dir, normalized);
      if (!target.startsWith(path.resolve(dir) + path.sep)) throw new Error(`Illegal file path: ${rel}`);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.writeFile(target, content);
    }
  }

  private readManifest(dir: string): AppManifest {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
  }

  private zipDir(dir: string, out: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const zip = spawn('zip', ['-qry', out, '.', '-x', '._*', '*/._*', '.DS_Store', '*/.DS_Store'], { cwd: dir });
      zip.on('close', code => (code === 0 ? resolve() : reject(new Error(`zip exited ${code}`))));
      zip.on('error', reject);
    });
  }
}
