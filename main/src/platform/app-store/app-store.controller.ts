import {
  Controller, Get, Post, Delete, Param, Body, Query,
  UseGuards, HttpCode, HttpStatus, UploadedFile,
  UseInterceptors, Res, Req, BadRequestException, NotFoundException,
  ForbiddenException, Logger, Sse, MessageEvent,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { AppRegistryService } from './services/app-registry.service';
import { AppInstallService, ORPHANED_DATABASE_RESOURCES_ERROR } from './services/app-install.service';
import { APP_CONFIG_ARTIFACT_PERMISSION } from './services/app-activation.service';
import { AppUninstallService } from './services/app-uninstall.service';
import { AppUpgradeService } from './services/app-upgrade.service';
import { AppGrantService } from './services/app-grant.service';
import { AppAuditService } from './services/app-audit.service';
import { AppStagingService } from './services/app-staging.service';
import { AppInstallOperationService } from './services/app-install-operation.service';
import { AppInstanceService } from './services/app-instance.service';
import { AppAssetService } from './services/app-asset.service';
import { AppCredentialService } from './services/app-credential.service';
import { DynamicModuleLoader } from './runtime/dynamic-module.loader';
import { AppLogService, AppLogEntry } from './services/app-log.service';
import { parseManifestCapabilities } from './services/app-capability.service';
import { Public } from '../auth/public.decorator';
import { memStorage } from './dto/mem-storage';

@Controller('api/app-store')
export class AppStoreController {
  private readonly logger = new Logger(AppStoreController.name);

  constructor(
    private readonly registry: AppRegistryService,
    private readonly install: AppInstallService,
    private readonly uninstall: AppUninstallService,
    private readonly upgrade: AppUpgradeService,
    private readonly grants: AppGrantService,
    private readonly audit: AppAuditService,
    private readonly staging: AppStagingService,
    private readonly operations: AppInstallOperationService,
    private readonly instances: AppInstanceService,
    private readonly assets: AppAssetService,
    private readonly credentials: AppCredentialService,
    private readonly loader: DynamicModuleLoader,
    private readonly appLogs: AppLogService,
  ) {}

  // ------------------------------------------------------------------
  // App listing & detail
  // ------------------------------------------------------------------

  @Get('apps')
  async listApps() {
    return this.registry.findAll();
  }

  @Get('apps/:appId')
  async getApp(@Param('appId') appId: string, @Req() req: any) {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);
    return {
      ...app,
      // manifest 中的署名与描述提升为顶层字段，供详情页直接展示
      author: app.manifest?.author ?? null,
      description: app.manifest?.description?.zh ?? app.manifest?.description?.en ?? null,
      capabilities: parseManifestCapabilities(app.manifest),
      usage: this.readUsage(app.installDir, app.version, req),
    };
  }

  /**
   * 读取包根目录的 USAGE.md（可选），将占位符替换为实际地址后返回。
   * 支持的占位符：
   *   {{BASE_URL}} — 实例地址（按当前请求的来源推导，用户浏览器可直接拷贝使用）
   *   {{MCP_URL}}  — 开发 MCP 端点（BASE_URL + /api/dev/mcp）
   *   {{APP_ID}} / {{VERSION}}
   */
  private readUsage(installDir: string | undefined, version: string, req: any): string | null {
    if (!installDir) return null;
    const usagePath = path.join(installDir, 'USAGE.md');
    if (!fs.existsSync(usagePath)) return null;
    try {
      const proto = (req.headers['x-forwarded-proto'] as string) ?? req.protocol ?? 'http';
      const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:8899';
      const baseUrl = `${proto}://${host}`;
      const raw = fs.readFileSync(usagePath, 'utf-8');
      const appId = req.params?.appId ?? '';
      return raw
        .replaceAll('{{BASE_URL}}', baseUrl)
        .replaceAll('{{MCP_URL}}', `${baseUrl}/api/dev/mcp`)
        .replaceAll('{{APP_ID}}', appId)
        .replaceAll('{{VERSION}}', version);
    } catch {
      return null;
    }
  }

  /**
   * SDK download — bundled at build time into dist/assets/sdk (nest assets).
   * Always matches the running instance's version; JWT login is the only credential needed.
   */
  @Get('sdk.tgz')
  downloadSdk(@Res() res: Response) {
    const sdkDir = path.join(__dirname, '..', '..', 'assets', 'sdk');
    if (!fs.existsSync(sdkDir)) throw new NotFoundException('SDK not bundled with this build');
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', 'attachment; filename="jz-sdk.tgz"');
    const tar = spawn('tar', ['-czf', '-', '-C', path.dirname(sdkDir), 'sdk']);
    tar.stdout.pipe(res);
    tar.stderr.on('data', (d: Buffer) => this.logger.warn(`sdk.tgz: ${d.toString().trim()}`));
  }

  // ------------------------------------------------------------------
  // Stage (validate before confirming install)
  // ------------------------------------------------------------------

  @Post('stage')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseInterceptors(FileInterceptor('package', { storage: memStorage() }))
  async stagePackage(@UploadedFile() file: Express.Multer.File) {
    if (!file) throw new BadRequestException('No package file uploaded');
    return this.staging.start(this.writeTempFile(file));
  }

  @Get('stage/:stageId')
  getStageStatus(@Param('stageId') stageId: string) {
    return this.operations.get(stageId);
  }

  // ------------------------------------------------------------------
  // Install
  // ------------------------------------------------------------------

  @Post('apps')
  @HttpCode(HttpStatus.ACCEPTED)
  async installApp(@Body() body: {
    stageId?: string;
    config?: Record<string, unknown>;
    purgeOrphanedData?: boolean;
  }) {
    if (!body?.stageId) throw new BadRequestException('stageId is required');
    const config = body.config && typeof body.config === 'object' && !Array.isArray(body.config)
      ? body.config
      : {};
    const purgeOrphanedData = body.purgeOrphanedData === true;
    const stageDir = this.operations.getInstallStageDir(body.stageId, purgeOrphanedData);
    this.operations.update(body.stageId, 'installing', 50, '正在安装应用…');
    void this.installStagedPackage(body.stageId, stageDir, config, { purgeOrphanedData });
    return this.operations.get(body.stageId);
  }

  private async installStagedPackage(
    stageId: string,
    stageDir: string,
    config: Record<string, unknown>,
    options: { purgeOrphanedData: boolean },
  ): Promise<void> {
    try {
      await this.install.installFromStage(stageDir, config, (phase, percent, message) => {
        this.operations.update(stageId, phase, percent, message);
      }, options);
      this.operations.clearStageDir(stageId);
      this.operations.succeed(stageId);
    } catch (err: any) {
      this.logger.error(`App installation failed for stage ${stageId}: ${err.message}`, err.stack);
      const message = this.getInstallFailureMessage(err);
      const canPurgeOrphanedData = this.isOrphanedDatabaseResourcesError(err);
      this.operations.fail(
        stageId,
        message,
        message,
        canPurgeOrphanedData ? 'purge-orphaned-data' : undefined,
      );
      if (!canPurgeOrphanedData) this.operations.clearStageDir(stageId);
    }
  }

  private isOrphanedDatabaseResourcesError(error: unknown): boolean {
    const detail = error instanceof Error ? error.message : '';
    return detail.includes(ORPHANED_DATABASE_RESOURCES_ERROR);
  }

  private isConfigArtifactPermissionError(error: unknown): boolean {
    const detail = error instanceof Error ? error.message : '';
    return detail.includes(APP_CONFIG_ARTIFACT_PERMISSION);
  }

  private getInstallFailureMessage(error: unknown): string {
    const detail = error instanceof Error ? error.message : '';

    if (this.isConfigArtifactPermissionError(error)) {
      return '应用配置目录权限不足。请由管理员清理或修复旧的挂载配置文件后重试。';
    }
    if (this.isOrphanedDatabaseResourcesError(error)) {
      return '发现同名应用的遗留数据库。请确认清除遗留数据后重试；此操作会永久删除旧应用数据。';
    }
    if (/CREATEROLE|permission denied|must be owner/i.test(detail)) {
      return '应用数据库权限不足，请联系管理员授予平台数据库用户创建应用角色和 schema 的权限。';
    }
    if (/Invalid URL|DATABASE_URL|PG_(HOST|PORT|DATABASE)/i.test(detail)) {
      return '平台数据库连接配置无效，请检查数据库主机、端口和数据库名称。';
    }
    if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|authentication failed|connection terminated/i.test(detail)) {
      return '无法连接应用数据库，请检查数据库服务、网络和平台数据库凭据。';
    }
    if (/migration|SQLSTATE|syntax error at or near/i.test(detail)) {
      return '应用数据库迁移失败，请检查应用包中的迁移脚本后重新上传。';
    }
    if (/Backend entry not found|Cannot find module|tool provider|activat/i.test(detail)) {
      return '应用后端激活失败，请检查应用包的后端入口和工具配置后重新上传。';
    }
    if (error instanceof BadRequestException) {
      return error.message;
    }
    return '应用安装运行失败，系统已清理本次安装残留。请刷新应用列表后重新上传，或联系管理员查看服务端日志。';
  }

  // ------------------------------------------------------------------
  // Upgrade
  // ------------------------------------------------------------------

  @Post('apps/:appId/upgrade')
  @UseInterceptors(FileInterceptor('package', { storage: memStorage() }))
  async upgradeApp(
    @Param('appId') appId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No package file uploaded');
    const tmp = this.writeTempFile(file);
    try {
      await this.upgrade.upgrade(appId, tmp);
      return { ok: true };
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }

  // ------------------------------------------------------------------
  // Uninstall
  // ------------------------------------------------------------------

  @Delete('apps/:appId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async uninstallApp(
    @Param('appId') appId: string,
    @Query('purgeData') purgeData?: string,
  ) {
    await this.uninstall.uninstall(appId, { purgeData: purgeData === 'true' });
  }

  // ------------------------------------------------------------------
  // Grants
  // ------------------------------------------------------------------

  @Get('apps/:appId/grants')
  async getGrants(@Param('appId') appId: string) {
    return this.grants.getGrants(appId);
  }

  @Post('apps/:appId/grants')
  async setGrant(@Param('appId') appId: string, @Body() body: any) {
    await this.grants.setGrant({ appId, ...body });
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Invoke — 扩展包后端统一调用入口（T2.6）
  // ------------------------------------------------------------------

  /**
   * POST /api/app-store/apps/:appId/invoke/:handler
   *
   * handler 格式 "ClassName.methodName"，必须在 manifest.backend.controllers[].handlers
   * 白名单中声明。鉴权：JWT（全局守卫）+ sys:admin 或应用授权。
   * 返回值直接 JSON 序列化。
   */
  @Post('apps/:appId/invoke/:handler')
  async invokeHandler(
    @Param('appId') appId: string,
    @Param('handler') handler: string,
    @Body() body: any,
    @Req() req: any,
  ) {
    // 格式校验（顺带挡掉 constructor/__proto__/toString 等危险路径）
    if (!/^[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(handler)) {
      throw new BadRequestException(`Invalid handler format: ${handler}`);
    }

    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);

    // 白名单校验
    const declared = (app.manifest?.backend?.controllers ?? []).flatMap(c => c.handlers ?? []);
    if (!declared.includes(handler)) {
      throw new NotFoundException(`Handler ${handler} not declared in manifest`);
    }

    // 授权：管理员放行，否则必须持有该应用的任意有效授权
    const userId: string | undefined = req.user?.id;
    const isAdmin = req.user?.role?.permissions?.includes('sys:admin') === true;
    if (!isAdmin) {
      if (!userId || !(await this.grants.hasAppAccess(appId, userId))) {
        throw new ForbiddenException(`No grant for app ${appId}`);
      }
    }

    // 解析控制器实例并调用
    const moduleRef = this.loader.getModuleRef(appId) as any;
    const [className, methodName] = handler.split('.');
    const instance = moduleRef?.controllers?.[className];
    if (!instance || typeof instance[methodName] !== 'function') {
      throw new NotFoundException(`Controller ${className}.${methodName} not available for app ${appId}`);
    }

    return instance[methodName](body ?? {}, { userId });
  }

  // ------------------------------------------------------------------
  // Audit log
  // ------------------------------------------------------------------

  @Get('apps/:appId/audit')
  async getAuditLog(
    @Param('appId') appId: string,
    @Query('limit') limit?: string,
  ) {
    return this.audit.getLogs(appId, limit ? parseInt(limit) : 100);
  }

  // ------------------------------------------------------------------
  // Instances
  // ------------------------------------------------------------------

  @Get('instances')
  async getInstances() {
    return this.instances.getAll();
  }

  // ------------------------------------------------------------------
  // Config / credentials
  // ------------------------------------------------------------------

  @Post('apps/:appId/config')
  async updateConfig(@Param('appId') appId: string, @Body() body: any) {
    await this.registry.updateConfig(appId, body);
    return { ok: true };
  }

  // ------------------------------------------------------------------
  // Logs (per-app ring buffer, SSE stream)
  // ------------------------------------------------------------------

  /**
   * GET /api/app-store/apps/:appId/logs?since=<ts>
   * 应用日志流（环形缓冲回放 + 实时推送）。鉴权：sys:admin 或持该应用授权。
   * 缓冲为易失调试设施，进程重启即空；持久审计走 /audit。
   */
  @Sse('apps/:appId/logs')
  async streamLogs(
    @Param('appId') appId: string,
    @Query('since') since: string,
    @Req() req: any,
  ): Promise<Observable<MessageEvent>> {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);
    const userId: string | undefined = req.user?.id;
    const isAdmin = req.user?.role?.permissions?.includes('sys:admin') === true;
    if (!isAdmin && (!userId || !(await this.grants.hasAppAccess(appId, userId)))) {
      throw new ForbiddenException(`No grant for app ${appId}`);
    }

    const sinceTs = since ? parseInt(since) : 0;
    const logs = this.appLogs;
    return new Observable<MessageEvent>(subscriber => {
      for (const entry of logs.read(appId, sinceTs)) {
        subscriber.next({ data: entry } as MessageEvent);
      }
      const unsubscribe = logs.subscribe(appId, (entry: AppLogEntry) => {
        subscriber.next({ data: entry } as MessageEvent);
      });
      return () => unsubscribe();
    });
  }

  // ------------------------------------------------------------------
  // Assets (serve static files from install dir)
  // ------------------------------------------------------------------  // Public：浏览器 ESM import() 无法携带 Authorization 头。
  // 与 /api/files/view 同一先例；资产是可执行代码而非用户数据，
  // 且仅当应用已安装（installDir 存在）才可读，路径经防穿越校验。
  @Public()
  @Get('apps/:appId/assets/*')
  async serveAsset(
    @Param('appId') appId: string,
    @Req() req: any,
    @Res() res: Response,
  ) {
    const app = await this.registry.findOne(appId);
    if (!app || !app.installDir) throw new NotFoundException();

    // Express 5（NestJS 11）不再通过 params['0'] 暴露未命名通配符的捕获段，
    // 改为从 URL 派生（同时兜底 params 数组，兼容旧行为）。
    const assetPath: string | undefined =
      (Array.isArray(req.params) ? req.params[0] : req.params?.[0]) ??
      (() => {
        const idx = req.path.indexOf('/assets/');
        return idx >= 0 ? req.path.slice(idx + '/assets/'.length) : undefined;
      })();
    if (!assetPath) throw new NotFoundException();

    const data = this.assets.readAsset(app.installDir, assetPath);
    if (!data) throw new NotFoundException();
    // ESM import() 对 MIME 有严格要求：必须按扩展名返回 JavaScript 类型，
    // 不能用 listAssets（仅列根目录）匹配，否则一律回落 octet-stream 导致模块加载失败。
    res.setHeader('Content-Type', this.assets.mimeOf(assetPath));
    res.send(data);
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private writeTempFile(file: Express.Multer.File): string {
    const tmp = path.join(os.tmpdir(), `jzapp_upload_${crypto.randomBytes(4).toString('hex')}.jzapp`);
    fs.writeFileSync(tmp, file.buffer);
    return tmp;
  }
}
