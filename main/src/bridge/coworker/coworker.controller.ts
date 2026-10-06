import {
  Controller, Get, Post, Put, Delete, Body, Param, Query, Req, Res,
  ForbiddenException, NotFoundException, ConflictException, BadRequestException,
  UseGuards, UseInterceptors, UploadedFile, Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Public } from '../../platform/auth/public.decorator';
import { CoWorkerAuthGuard } from './coworker-auth.guard';
import * as express from 'express';
import * as fs from 'fs';
import * as os from 'os';
import { CoWorkerService } from './coworker.service';
import type { CoWorkerCapabilities } from './coworker.service';
import { CoWorkerConfigService, OPENCLAW_BUILTIN_TOOLS } from './coworker-config.service';
import { CoWorkerProxyService } from './coworker-proxy.service';
import { CoWorkerGateway } from './coworker.gateway';
import { CoWorkerBuildService } from './coworker-build.service';
import { CoWorkerOpenClawService } from './coworker-openclaw.service';
import { CoWorkerAnalyticsService } from './coworker-analytics.service';
import { CoWorkerPostMeetingService } from './coworker-post-meeting.service';
import { UserService, Permission } from '../../user/user.service';
import { DbService } from '../../db/db.service';
import { KnowledgeToolsService } from '../../knowledge/tools/knowledge-tools.service';
import { SkillRegistryService } from '../../capability/skill/skill-registry.service';
import { CoWorkerAppService } from './coworker-app.service';
import { CoWorkerWinBuildService } from './coworker-win-build.service';
import { ToolBridgeService } from '../../agent/tool-bridge/tool-bridge.service';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { WorkflowTransactionService, CreateWorkflowOptions, WorkflowStep } from './workflow-transaction.service';
import { GatewayHealthService } from './gateway-health.service';
import type { CrashReport, HealthSnapshot } from './gateway-health.service';

@Controller('api')
export class CoWorkerController {
  private readonly logger = new Logger(CoWorkerController.name);

  constructor(
    private readonly cwService: CoWorkerService,
    private readonly cwConfig: CoWorkerConfigService,
    private readonly cwProxy: CoWorkerProxyService,
    private readonly cwGateway: CoWorkerGateway,
    private readonly cwBuild: CoWorkerBuildService,
    private readonly cwOpenClaw: CoWorkerOpenClawService,
    private readonly cwAnalytics: CoWorkerAnalyticsService,
    private readonly cwPostMeeting: CoWorkerPostMeetingService,
    private readonly cwApp: CoWorkerAppService,
    private readonly cwWinBuild: CoWorkerWinBuildService,
    private readonly userService: UserService,
    private readonly db: DbService,
    private readonly mcpTools: KnowledgeToolsService,
    private readonly skillRegistry: SkillRegistryService,
    private readonly toolBridge: ToolBridgeService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly workflowService: WorkflowTransactionService,
    private readonly gatewayHealth: GatewayHealthService,
  ) {}

  // ===== CoWorker Management (Admin) =====

  @Get('coworkers')
  async list(@Req() req: any) {
    this.requirePermission(req, 'cw:view');
    const coworkers = await this.cwService.list();

    // Attach online status from assignments
    const result: any[] = [];
    for (const cw of coworkers) {
      const assignments = await this.cwService.listAssignments(cw.id);
      const onlineCount = assignments.filter(a => {
        if (!a.lastSeen) return false;
        return Date.now() - new Date(a.lastSeen).getTime() < 90000; // 90s heartbeat window
      }).length;
      result.push({ ...cw, assignmentCount: assignments.length, onlineCount });
    }
    return result;
  }

  @Post('coworkers')
  async create(@Req() req: any, @Body() body: any) {
    this.requirePermission(req, 'cw:manage');
    const { body: payload, rejected } = await this.applyCapabilityDerivation(body);
    const cw = await this.cwService.create({ ...payload, createdBy: req.user.id });
    return rejected.length ? { ...cw, rejectedCapabilities: rejected } : cw;
  }

  // ===== Tool Catalog (must be before :id routes) =====

  @Get('coworkers/tool-catalog')
  async toolCatalog(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    const mainTools = await this.mcpTools.getAvailableTools();
    return this.cwConfig.getToolCatalog(mainTools);
  }

  // Capability catalog for the admin authorization UI (builtin / mcp / skills tabs).
  @Get('coworkers/capability-catalog')
  async capabilityCatalog(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    const mainTools = await this.mcpTools.getAvailableTools();
    const skills = this.skillRegistry.getAll().map(s => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      hasHandler: s.hasHandler,
    }));
    const builtinTools = this.cwOpenClaw.getToolsManifest();
    const mcpServers = this.mcpRegistry.getEnabled();
    return this.cwConfig.getCapabilityCatalog(mainTools, skills, builtinTools, this.toolBridge.getCatalog(), mcpServers);
  }

  // ===== OpenClaw 源管理 (admin manual fetch/upgrade) =====

  @Get('coworkers/openclaw/status')
  async openclawStatus(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    return this.cwOpenClaw.getStatus();
  }

  @Post('coworkers/openclaw/install')
  async openclawInstall(@Req() req: any, @Body() body: any) {
    this.requirePermission(req, 'cw:manage');
    return this.cwOpenClaw.install(body?.version);
  }

  @Get('coworkers/openclaw/install/progress')
  async openclawProgress(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    return this.cwOpenClaw.getProgress();
  }

  @Post('coworkers/openclaw/runtime-win')
  async installWinRuntime(@Req() req: any, @Body() body: { artifactUrl?: string }) {
    this.requirePermission(req, 'cw:manage');
    return this.cwOpenClaw.installWinRuntime(body?.artifactUrl);
  }

  @Get('coworkers/openclaw/runtime-win/status')
  async winRuntimeStatus(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    const info = this.cwOpenClaw.getWinRuntimeFile();
    if (!info) {
      return { installed: false, version: null, size: 0 };
    }
    return {
      installed: true,
      version: info.version,
      size: info.size,
      sizeMb: (info.size / 1024 / 1024).toFixed(2),
    };
  }

  @Post('coworkers/openclaw/rollback')
  async openclawRollback(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    return this.cwOpenClaw.rollback();
  }

  /**
   * Serve the admin-pinned OpenClaw prebuilt asset to users at INSTALL time.
   * Users pull OpenClaw from 见智 (never GitHub/DockerHub) → all users of this 见智 instance
   * run the SAME version. Guarded by the CoWorker (user JWT) token.
   */
  @Get('coworkers/openclaw/asset')
  async openclawAsset(@Query('token') token: string, @Res() res: express.Response) {
    const user = this.userService.verifyToken(token || '');
    if (!user) throw new ForbiddenException('无效令牌');
    const info = this.cwOpenClaw.getAssetFile();
    if (!info) throw new NotFoundException('OpenClaw 资产未安装，请管理员先在后台下载 OpenClaw 源');
    res.setHeader('X-OpenClaw-Version', info.version);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="openclaw-${info.version}.tar.gz"`);
    fs.createReadStream(info.path).pipe(res);
  }

  /**
   * Serve the Windows runtime asset (runtime-win-x64.tar.gz).
   * This is the prebuilt Windows runtime with node.exe and win-x64 node_modules.
   * Guarded by the CoWorker (user JWT) token.
   */
  @Get('coworkers/openclaw/runtime-win/asset')
  async winRuntimeAsset(@Query('token') token: string, @Res() res: express.Response) {
    const user = this.userService.verifyToken(token || '');
    if (!user) throw new ForbiddenException('无效令牌');
    const info = this.cwOpenClaw.getWinRuntimeFile();
    if (!info) throw new NotFoundException('Windows 运行时未安装，请管理员先安装 Windows 运行时');
    res.setHeader('X-OpenClaw-Win-Version', info.version);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="openclaw-runtime-win-x64-${info.version}.tar.gz"`);
    fs.createReadStream(info.path).pipe(res);
  }

  // ===== Analytics (must be before :id routes) =====

  @Get('coworkers/analytics/dashboard')
  async analyticsDashboard(@Req() req: any) {
    this.requirePermission(req, 'cw:view');
    const days = parseInt(req.query?.days || '30', 10);
    return this.cwAnalytics.getDashboard(days);
  }

  /**
   * Windows App Enrollment Endpoint
   * Used by the native Windows app to fetch configuration and extensions.
   * Token = enrollment token (generated per assignment) or assignment ID (dev mode).
   * Returns openclaw.json config + extension manifest.
   *
   * IMPORTANT: This route must be defined BEFORE coworkers/:id to avoid 'enroll' being
   * captured as an :id parameter by the dynamic route.
   */
  @Public()
  @Get('coworkers/enroll')
  async enroll(@Req() req: any, @Query('token') token: string) {
    if (!token) throw new ForbiddenException('缺少激活令牌');

    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.headers['x-real-ip'] as string
      || req.ip
      || req.socket?.remoteAddress;

    const userAgent = req.headers['user-agent'] as string;

    const result = await this.cwService.enroll(token, ip, userAgent);
    if (!result) throw new ForbiddenException('无效的激活令牌或 CoWorker 未发布');

    const mainUrl = this.getMainUrl(req);
    const configJson = this.cwConfig.generateConfigJson(result.coworker, mainUrl, result.apiKey);

    return {
      coworkerId: result.coworker.id,
      coworkerName: result.coworker.name,
      assignmentId: result.assignmentId,
      apiKey: result.apiKey,
      token: result.apiKey,
      enrollToken: token,
      user: {
        id: result.user.id,
        name: result.user.name,
        email: result.user.email,
      },
      config: configJson,
      // 人格指令：客户端写入 workspace 根目录的 SOUL.md（不能进 openclaw.json，新版会校验失败）
      soul: this.cwConfig.generateSoulMarkdown(result.coworker),
      mainUrl,
      extensions: [
        { name: 'jianzhi-bridge', required: true, description: '见智审计/回传桥' },
        { name: 'openclaw-weixin', required: false, description: '微信频道支持（可选）' },
      ],
    };
  }

  @Get('coworkers/:id')
  async getById(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:view');
    const cw = await this.cwService.getById(id);
    if (!cw) throw new NotFoundException('CoWorker 不存在');
    const assignments = await this.cwService.listAssignments(id);

    // capabilities 是保存时的事实来源，tools 是其派生产物。
    // 新保存的行 capabilities 有非空 builtin/mcp，直接返回即可。
    // 仅当 capabilities 为空（旧数据）或仅有 skills（015 回填）时，从 tools 反推。
    if ((!cw.capabilities?.builtin?.length && !cw.capabilities?.mcp?.length) && cw.tools?.length) {
      const registry = await this.buildToolRegistry();
      const skills = cw.capabilities?.skills?.length ? cw.capabilities.skills : cw.skills;
      const synthesized = this.cwConfig.synthesizeCapabilities(cw.tools, skills, registry);
      return { ...cw, capabilities: synthesized, assignments };
    }

    return { ...cw, assignments };
  }

  @Put('coworkers/:id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: any) {
    this.requirePermission(req, 'cw:manage');
    const { body: payload, rejected } = await this.applyCapabilityDerivation(body);
    const cw = await this.cwService.update(id, payload);
    if (!cw) throw new NotFoundException('CoWorker 不存在');

    // Push config update to connected OpenClaw instances (hot-reload)
    const assignments = await this.cwService.listAssignments(id);
    if (assignments.length > 0) {
      const latestVersion = Math.max(...assignments.map(a => a.configVersion));
      this.cwGateway.pushConfigUpdate(id, latestVersion);
    }

    return rejected.length ? { ...cw, rejectedCapabilities: rejected } : cw;
  }

  @Delete('coworkers/:id')
  async remove(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:manage');
    const deleted = await this.cwService.delete(id);
    if (!deleted) throw new NotFoundException('CoWorker 不存在');
    return { deleted: true };
  }

  @Post('coworkers/:id/publish')
  async publish(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:manage');
    const cw = await this.cwService.publish(id);
    if (!cw) throw new NotFoundException('CoWorker 不存在');
    return cw;
  }

  // ===== Assignments =====

  @Post('coworkers/:id/assign')
  async assign(@Req() req: any, @Param('id') id: string, @Body() body: { userId: string }) {
    this.requirePermission(req, 'cw:manage');
    try {
      return await this.cwService.assign(id, body.userId);
    } catch (err: any) {
      if (err.code === '23505') throw new ConflictException('该员工已分配此 CoWorker');
      throw err;
    }
  }

  @Delete('coworkers/:id/assign/:userId')
  async unassign(@Req() req: any, @Param('id') id: string, @Param('userId') userId: string) {
    this.requirePermission(req, 'cw:manage');
    const removed = await this.cwService.unassign(id, userId);
    if (!removed) throw new NotFoundException('分配记录不存在');
    return { deleted: true };
  }

  @Get('coworkers/:id/assignments')
  async listAssignments(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:view');
    return this.cwService.listAssignments(id);
  }

  @Get('coworkers/:id/analytics')
  async coworkerAnalytics(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:view');
    const days = parseInt(req.query?.days || '30', 10);
    return this.cwAnalytics.getCoWorkerStats(id, days);
  }

  @Get('coworkers/:id/messages')
  async coworkerMessages(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:view');
    const limit = parseInt(req.query?.limit || '50', 10);
    const offset = parseInt(req.query?.offset || '0', 10);
    return this.cwAnalytics.getMessages(id, limit, offset);
  }

  // ===== Post-Meeting Analysis (会后分析) =====

  /** 跑一次会后分析：用 live 蒸馏工具规格对该分配的会话窗口程序化打分 */
  @Post('coworkers/:id/assignments/:assignmentId/post-meeting')
  async runPostMeeting(
    @Req() req: any,
    @Param('assignmentId') assignmentId: string,
    @Body() body: { limit?: number; sinceMinutes?: number },
  ) {
    this.requirePermission(req, 'cw:view');
    return this.cwPostMeeting.analyze({
      assignmentId,
      limit: body?.limit,
      sinceMinutes: body?.sinceMinutes,
      createdBy: req.user?.id,
    });
  }

  /** 历史会后分析列表 */
  @Get('coworkers/:id/assignments/:assignmentId/post-meeting')
  async listPostMeeting(@Req() req: any, @Param('assignmentId') assignmentId: string) {
    this.requirePermission(req, 'cw:view');
    return this.cwPostMeeting.listAnalyses(assignmentId);
  }

  /** 单份会后分析详情 */
  @Get('coworkers/:id/post-meeting/:analysisId')
  async getPostMeeting(@Req() req: any, @Param('analysisId') analysisId: string) {
    this.requirePermission(req, 'cw:view');
    const a = await this.cwPostMeeting.getAnalysis(analysisId);
    if (!a) throw new NotFoundException('会后分析不存在');
    return a;
  }

  // ===== Config Generation =====

  @Get('coworkers/:id/config')
  async getConfig(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:manage');
    const cw = await this.cwService.getById(id);
    if (!cw) throw new NotFoundException('CoWorker 不存在');
    const mainUrl = this.getMainUrl(req);
    return {
      yaml: this.cwConfig.generateConfig(cw, mainUrl),
      dockerCompose: this.cwConfig.generateDockerCompose(cw),
      envTemplate: this.cwConfig.generateEnvTemplate(cw, mainUrl),
    };
  }

  /**
   * Generate enrollment token for an assignment.
   * Used by admin to generate tokens for Windows app distribution.
   */
  @Post('coworkers/assignments/:id/enroll-token')
  async generateEnrollToken(@Req() req: any, @Param('id') assignmentId: string) {
    this.requirePermission(req, 'cw:manage');
    const token = await this.cwService.generateEnrollToken(assignmentId);
    if (!token) throw new NotFoundException('分配记录不存在');
    return { assignmentId, token };
  }

  /**
   * Windows App Download Endpoint
   * Serves the universal Windows installer (见智CoWorker-Setup-x64.exe).
   * Tracks download statistics.
   */
  @Get('coworkers/app/win')
  async downloadWinApp(@Req() req: any, @Res() res: express.Response) {
    const info = this.cwApp.getCurrentInstaller();

    if (!info || !info.available || !info.path) {
      throw new NotFoundException('Windows 安装器暂未就绪，请联系管理员');
    }

    // 记录下载统计
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.headers['x-real-ip'] as string
      || req.ip
      || req.socket?.remoteAddress
      || 'unknown';
    const userAgent = req.headers['user-agent'] as string || 'unknown';
    const userId = req.user?.id || null;

    // 异步记录统计（不阻塞下载）
    this.cwApp.recordDownload(userId, ip, userAgent).catch(err => {
      console.error('[WinApp] 记录下载统计失败:', err);
    });

    const fileName = info.filename || '见智CoWorker-Setup-x64.exe';

    // 设置响应头
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURI(fileName)}"`);
    res.setHeader('Content-Length', info.size.toString());

    // 流式传输文件
    const fileStream = fs.createReadStream(info.path);
    fileStream.pipe(res);

    // 错误处理
    fileStream.on('error', (err) => {
      console.error('[WinApp] 传输错误:', err);
      if (!res.headersSent) {
        res.status(500).send('下载失败');
      }
    });
  }

  /**
   * Check Windows app availability (for UI display)
   */
  @Get('coworkers/app/win/status')
  async winAppStatus(@Req() req: any) {
    const info = this.cwApp.getCurrentInstaller();
    if (!info) {
      return { available: false, version: null, size: 0 };
    }
    return {
      available: info.available,
      version: info.version,
      size: info.size,
    };
  }

  /**
   * Upload signed Windows installer (admin only)
   * Stores the installer in the app storage directory and updates metadata.
   */
  @Post('coworkers/app/win/upload')
  @UseInterceptors(FileInterceptor('file', {
    storage: diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, _file, cb) => cb(null, `cw-upload-${Date.now()}.exe`),
    }),
    limits: { fileSize: 300 * 1024 * 1024 },
  }))
  async uploadWinInstaller(@Req() req: any, @UploadedFile() file: Express.Multer.File) {
    this.requirePermission(req, 'cw:manage');

    if (!file) {
      throw new BadRequestException('未收到文件');
    }

    try {
      const result = await this.cwApp.storeInstaller(file.path);
      await this.cwApp.cleanupOldVersions();
      return {
        success: true,
        ...result,
        downloadUrl: '/api/coworkers/app/win',
      };
    } finally {
      fs.unlink(file.path, () => {});
    }
  }

  /**
   * Download latest Windows installer from website (admin only)
   * Triggers download from官网 and installs it locally.
   */
  @Post('coworkers/app/win/install')
  async installWinApp(@Req() req: any, @Body() body: { version?: string }) {
    this.requirePermission(req, 'cw:manage');
    return this.cwApp.install(body?.version);
  }

  /**
   * Get Windows app install progress (admin only)
   */
  @Get('coworkers/app/win/install/progress')
  async getWinAppInstallProgress(@Req() req: any) {
    this.requirePermission(req, 'cw:view');
    return this.cwApp.getProgress();
  }

  /**
   * Get Windows app download statistics (admin only)
   */
  @Get('coworkers/app/win/stats')
  async winAppStats(@Req() req: any) {
    this.requirePermission(req, 'cw:view');
    const days = parseInt(req.query?.days || '30', 10);
    return this.cwApp.getDownloadStats(days);
  }

  /**
   * Build Windows installer (admin only)
   * Triggers the Windows installer build process on the server.
   */
  @Post('coworkers/build-win')
  async buildWinInstaller(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    const result = await this.cwWinBuild.startBuild();
    return result;
  }

  /**
   * Get Windows build status (admin only)
   */
  @Get('coworkers/build-win/status')
  async getWinBuildStatus(@Req() req: any): Promise<{
    running: boolean;
    phase: string;
    message?: string;
    error?: string;
    startedAt?: string;
    finishedAt?: string;
    output?: string;
  }> {
    this.requirePermission(req, 'cw:view');
    return this.cwWinBuild.getProgress();
  }

  /**
   * Check Windows build environment (admin only)
   */
  @Get('coworkers/build-win/check-env')
  async checkWinBuildEnv(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    return this.cwWinBuild.checkEnvironment();
  }

  /**
   * Download Windows installer with token config
   * Returns a ZIP file containing:
   * - 见智CoWorker-Setup-x64.exe (installer)
   * - jzai-config.json (token config for auto-activation)
   */
  @Get('coworkers/app/win/download')
  async downloadWinInstallerWithToken(
    @Req() req: any,
    @Query('token') token: string,
    @Res() res: express.Response,
  ) {
    if (!token) {
      throw new ForbiddenException('缺少 token 参数');
    }

    // 验证 token 并获取 CoWorker 信息
    const user = this.userService.verifyToken(token || '');
    if (!user) {
      // 如果是 enroll token，尝试通过 enroll API 验证
      try {
        const enrollData = await this.cwService.enroll(token, req.ip, req.headers['user-agent'] as string);
        if (!enrollData) {
          throw new ForbiddenException('无效的激活令牌');
        }
      } catch {
        throw new ForbiddenException('无效的激活令牌');
      }
    }

    // 获取安装器信息
    const installerInfo = this.cwWinBuild.getInstallerInfo();
    if (!installerInfo || !installerInfo.available) {
      throw new NotFoundException('Windows 安装器暂未就绪，请联系管理员先构建');
    }

    // 生成 token 配置
    const mainUrl = this.getMainUrl(req);
    const tokenConfig = this.cwWinBuild.generateTokenConfig(token, mainUrl);

    // 创建 ZIP 文件
    const archiver = require('archiver');
    const zip = archiver('zip', { zlib: { level: 9 } });

    // 设置响应头
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="jzai-coworker.zip"`);

    // 错误处理
    zip.on('error', (err: any) => {
      console.error('[ZIP] 创建失败:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'ZIP 文件创建失败' });
      }
    });

    // 管道输出
    zip.pipe(res);

    // 添加安装器
    zip.file(installerInfo.path!, { name: '见智CoWorker-Setup-x64.exe' });

    // 添加 token 配置
    zip.append(tokenConfig, { name: 'jzai-config.json' });

    // 完成 ZIP
    await zip.finalize();
  }

  // ===== Build & Download =====

  @Post('coworkers/:id/build')
  async build(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:build');
    const mainUrl = this.getMainUrl(req);
    const pkg = await this.cwBuild.generatePackage(id, mainUrl);
    await this.cwService.markBuilt(id);
    return { filename: pkg.filename, fileCount: pkg.files.length, files: pkg.files.map(f => f.path) };
  }

  @Get('coworkers/:id/build/download')
  async download(@Req() req: any, @Res() res: express.Response, @Param('id') id: string) {
    this.requirePermission(req, 'cw:build');
    const mainUrl = this.getMainUrl(req);
    const pkg = await this.cwBuild.generatePackage(id, mainUrl);

    // Return as JSON with all file contents (frontend can assemble into zip/tar)
    // For true tar.gz, would use archiver library — MVP uses JSON download
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${pkg.filename}.json"`);
    res.json({ filename: pkg.filename, files: pkg.files });
  }

  // ===== Employee Endpoints =====

  @Get('my/coworkers')
  async myCoWorkers(@Req() req: any) {
    const list = await this.cwService.getMyCoWorkers(req.user.id);
    return list.map(item => ({
      ...item,
      downloadLinks: {
        installer: {
          windows: `/api/my/coworkers/${item.coworker.id}/download/installer?platform=win32`,
          macos: `/api/my/coworkers/${item.coworker.id}/download/installer?platform=darwin`,
        },
        config: `/api/my/coworkers/${item.coworker.id}/download/config`,
        guide: `/api/my/coworkers/${item.coworker.id}/download/guide`,
      },
    }));
  }

  @Get('my/coworkers/:id/download/:kind')
  async downloadMyCoWorkerFile(
    @Req() req: any,
    @Res() res: express.Response,
    @Param('id') coworkerId: string,
    @Param('kind') kind: string,
    @Query('platform') platform?: string,
  ) {
    const myList = await this.cwService.getMyCoWorkers(req.user.id);
    const mine = myList.find(m => m.coworker.id === coworkerId || m.coworkerId === coworkerId);
    if (!mine) throw new ForbiddenException('无权访问');

    const mainUrl = this.getMainUrl(req);

    if (kind === 'config') {
      const yaml = this.cwConfig.generateConfig(mine.coworker, mainUrl);
      res.setHeader('Content-Type', 'application/x-yaml');
      res.setHeader('Content-Disposition', `attachment; filename="${mine.coworker.name}.yaml"`);
      return res.send(yaml);
    }

    if (kind === 'guide') {
      const guide = `# ${mine.coworker.name} 使用说明\n\n${mine.coworker.description || '暂无说明'}\n\n## 工作范围\n\n${mine.coworker.workScope || '未配置'}\n`;
      res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${mine.coworker.name}-guide.md"`);
      return res.send(guide);
    }

    if (kind === 'installer') {
      const ext = platform === 'darwin' ? 'dmg' : 'exe';
      const fname = platform === 'darwin' ? '见智CoWorker.dmg' : '见智CoWorker-Setup-x64.exe';
      const candidates = [
        require('path').join(process.cwd(), 'resources', fname),
        require('path').join(process.cwd(), '..', 'resources', fname),
      ];
      const filePath = candidates.find(p => fs.existsSync(p));
      if (!filePath) {
        return res.status(404).json({ message: `安装包 (${ext}) 暂未上传，请联系管理员` });
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
      return res.sendFile(filePath);
    }

    throw new NotFoundException('未知的下载类型');
  }

  @Get('my/coworkers/:id/config')
  async myCoWorkerConfig(@Req() req: any, @Param('id') coworkerId: string) {
    const myList = await this.cwService.getMyCoWorkers(req.user.id);
    const mine = myList.find(m => m.coworkerId === coworkerId);
    if (!mine) throw new ForbiddenException('无权访问');
    const mainUrl = this.getMainUrl(req);
    return {
      configVersion: mine.configVersion,
      yaml: this.cwConfig.generateConfig(mine.coworker, mainUrl),
    };
  }

  // ===== LLM Proxy (called by OpenClaw instances) =====

  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/llm/v1/chat/completions')
  async llmProxy(@Req() req: any, @Res() res: express.Response, @Body() body: any) {
    const assignmentId = await this.resolveAssignment(req);
    await this.cwProxy.chatCompletions(body, assignmentId, res);
  }

  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/llm/v1/embeddings')
  async embeddingsProxy(@Req() req: any, @Res() res: express.Response, @Body() body: any) {
    await this.cwProxy.embeddings(body, res);
  }

  // ===== MCP/Tool Proxy (called by OpenClaw instances) =====

  /**
   * Unified MCP endpoint for OpenClaw streamable-http transport.
   * Handles MCP JSON-RPC 2.0 requests with method routing.
   * Request format: { "method": "tools/list", "params": {} }
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/mcp')
  async genericMcp(@Req() req: any, @Body() body: any, @Res() res: express.Response) {
    // JSON-RPC 2.0：响应必须带 jsonrpc/id 信封，且始终以 HTTP 200 返回。
    // OpenClaw 用 zod union 校验 streamable-http 响应，裸载荷或非 200 会让
    // 整个 MCP server 启动失败（连带所有主台/知识库工具都不可用）。
    const rpcId = body?.id ?? null;
    const ok = (result: any) => res.status(200).json({ jsonrpc: '2.0', id: rpcId, result });
    const fail = (code: number, message: string) =>
      res.status(200).json({ jsonrpc: '2.0', id: rpcId, error: { code, message } });

    try {
      const method = body?.method;
      if (!method || typeof method !== 'string') {
        return fail(-32600, 'Invalid Request: missing or invalid method field');
      }

      // notification（无 id）按协议不能回响应体，例如 notifications/initialized。
      if ((body?.id === undefined || body?.id === null) && method.startsWith('notifications/')) {
        return res.status(202).end();
      }

      let assignmentId: string;
      try {
        assignmentId = await this.resolveAssignment(req);
      } catch (err: any) {
        return fail(-32603, `Forbidden: ${err.message}`);
      }

      switch (method) {
        case 'initialize': {
          // MCP initialization handshake
          return ok({
            protocolVersion: '2024-11-05',
            serverInfo: { name: 'jianzhi-main', version: '1.0.0' },
            capabilities: {
              tools: {},
            },
          });
        }

        case 'tools/list': {
          const allowedTools = await this.cwService.getAuthorizedTools(assignmentId);
          const emptySchema = { type: 'object', properties: {} };

          // 合并远程工具（主台）和知识库工具
          // 主台工具：从 ToolBridgeService 获取（数据库、Excel、PDF、邮件等）
          // MCP 子工具（mcp_*）按逐条授权过滤；jianzhi_mcp 为旧组级授权，向后兼容。
          const mainToolsCatalog = this.toolBridge.getCatalog();
          const hasGroupMcpAuth = allowedTools.includes('jianzhi_mcp');
          const nonMcpMain = mainToolsCatalog.filter(t => t.id !== 'mcp' && allowedTools.includes(`jianzhi_${t.id}`));
          const hasIndividualMcpAuth = allowedTools.some(t => t.startsWith('mcp_'));

          let remoteTools: any[] = [];
          if (nonMcpMain.length > 0) {
            const user = await this.userService.getUser(req.user?.id || '');
            const built = await this.toolBridge.buildForAgent(
              nonMcpMain.map(t => t.id),
              { userId: user?.id, userEmail: user?.email },
            );
            remoteTools = built.map(t => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.parameters || emptySchema,
            }));
          }

          // MCP 适配器工具：组级授权（jianzhi_mcp）返回全部，逐条授权仅返回 allowed 中的
          if (hasGroupMcpAuth || hasIndividualMcpAuth) {
            const user = await this.userService.getUser(req.user?.id || '');
            const builtMcp = await this.toolBridge.buildForAgent(['mcp'], { userId: user?.id, userEmail: user?.email });
            const filteredMcp = hasGroupMcpAuth
              ? builtMcp
              : builtMcp.filter(t => allowedTools.includes(t.name));
            remoteTools.push(...filteredMcp.map(t => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.parameters || emptySchema,
            })));
          }

          // 知识库工具：从 McpToolsService 获取
          const kbTools = await this.mcpTools.getAvailableTools();
          const filteredKbTools = kbTools
            .filter(t => {
              const canonicalId = `jianzhi_${t.name}`;
              return allowedTools.includes(canonicalId);
            })
            .map(t => ({
              name: t.name,
              description: t.description || '',
              inputSchema: t.inputSchema || emptySchema,
            }));

          // 内置工具（user-info）
          const builtinTools = [
            {
              name: 'user_info',
              description: '获取当前用户的基本联系信息（邮箱、电话等），支持默认邮箱回退',
              inputSchema: emptySchema,
            },
          ];

          return ok({ tools: [...remoteTools, ...filteredKbTools, ...builtinTools] });
        }

        case 'tools/call': {
          const toolName = body?.params?.name;
          const toolArguments = body?.params?.arguments || {};
          if (!toolName || typeof toolName !== 'string') {
            return fail(-32602, 'Invalid params: missing or invalid tool name');
          }
          const allowedTools = await this.cwService.getAuthorizedTools(assignmentId);

          // 内置工具特殊处理：user-info 不需要授权检查
          const isBuiltinTool = toolName === 'user_info';

          // MCP 子工具（mcp_<server>_<tool>）授权：
          // - 新模式：逐条 mcp_{server}_{tool} 在 allowedTools 中
          // - 旧模式：jianzhi_mcp 组级授权（向后兼容）
          const isMcpSubTool = toolName.startsWith('mcp_');
          if (isMcpSubTool) {
            if (!allowedTools.includes(toolName) && !allowedTools.includes('jianzhi_mcp')) {
              return fail(-32603, `Tool ${toolName} is not authorized for this CoWorker`);
            }
          } else if (!isBuiltinTool && !allowedTools.includes(`jianzhi_${toolName}`)) {
            return fail(-32603, `Tool ${toolName} is not authorized for this CoWorker`);
          }

          let result: any;

          // 处理内置工具
          if (isBuiltinTool) {
            try {
              const user = await this.userService.getUser(req.user?.id || '');
              const profile = await this.userService.getUserProfile(req.user?.id || '');

              result = {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      email: user?.email || '',
                      emailSource: 'user',
                      emailVerified: !!user?.email,
                      name: user?.name || '',
                      phone: profile?.phone || '',
                      department: profile?.department || '',
                      position: profile?.position || '',
                    }, null, 2),
                  },
                ],
                isError: false,
              };
            } catch (err: any) {
              this.logger.error(`user_info tool error: ${err.message}`);
              return fail(-32603, `user_info tool failed: ${err.message}`);
            }
          } else {
            // 判断工具来源：主台工具（含 MCP 子工具） vs 知识库工具
            const mainToolsCatalog = this.toolBridge.getCatalog();
            const isMainTool = mainToolsCatalog.some(t => t.id === toolName) || isMcpSubTool;

            if (isMainTool) {
              // 主台工具：通过 ToolBridgeService 调用
              try {
                // 获取用户信息用于构建上下文
                const user = await this.userService.getUser(req.user?.id || '');
                const ctx = {
                  userId: user?.id,
                  userEmail: user?.email,
                };

                // buildForAgent 按 provider trigger id 解析，返回该 provider 的全部工具。
                // MCP 子工具需用 trigger id 'mcp' 构建（返回全部 mcp_*_* 实例），
                // 再按 toolName 精确挑选；其他主台工具直接用自身 id 构建。
                const buildId = isMcpSubTool ? 'mcp' : toolName;
                const tools = await this.toolBridge.buildForAgent([buildId], ctx);
                const tool = tools.find(t => t.name === toolName);
                if (!tool) {
                  return fail(-32601, `Tool ${toolName} not found or failed to build`);
                }

                const toolResult = await tool.execute('', toolArguments);

                // wrapWithSafety 会吞掉异常并把错误塞进 details.__error，catch 不会触发。
                if (toolResult?.details?.__error) {
                  this.logger.error(`Main tool ${toolName} error: ${JSON.stringify(toolResult.details.__error)}`);
                  return fail(-32603, `Tool ${toolName} execution failed: ${toolResult.details.__error?.message || toolResult.details.__error}`);
                }

                // 提取文件信息（如果有）
                const fileInfo = toolResult?.details?.fileId
                  ? {
                      fileId: toolResult.details.fileId,
                      filename: toolResult.details.filename || toolResult.details.fileId,
                    }
                  : undefined;

                result = {
                  content: [
                    {
                      type: 'text',
                      text: toolResult?.content?.[0]?.text || JSON.stringify(toolResult),
                    },
                  ],
                  isError: false,
                  // _meta 是 MCP 规范预留的扩展槽，用于携带工作流上下文所需的文件信息
                  ...(fileInfo ? { _meta: { fileInfo } } : {}),
                };
              } catch (err: any) {
                this.logger.error(`Main tool ${toolName} error: ${err.message}`);
                return fail(-32603, `Tool ${toolName} execution failed: ${err.message}`);
              }
            } else {
              // 知识库工具：callTool 返回 { content: string }，需归一为 MCP content block 数组
              const kbResult = await this.mcpTools.callTool(toolName, toolArguments);
              result = {
                content: [{ type: 'text', text: kbResult?.content ?? '' }],
                isError: false,
              };
            }
          }

          return ok(result);
        }

        case 'prompts/list':
          return ok({ prompts: [] });

        case 'resources/list':
          return ok({ resources: [] });

        default:
          return fail(-32601, `Method not supported: ${method}`);
      }
    } catch (err: any) {
      this.logger.error(`[MCP] Generic endpoint error: ${err.message}`);
      return fail(-32603, `Internal error: ${err.message}`);
    }
  }

  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/mcp/tools/list')
  async listMcpTools(@Req() req: any) {
    const assignmentId = await this.resolveAssignment(req);
    const allowedTools = await this.cwService.getAuthorizedTools(assignmentId);
    const allTools = await this.mcpTools.getAvailableTools();

    // Filter: only return tools whose canonical ID (jianzhi_{name}) is in the allow list
    const filtered = allTools.filter(t => {
      const canonicalId = `jianzhi_${t.name}`;
      return allowedTools.includes(canonicalId);
    });
    return { tools: filtered };
  }

  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/mcp/tools/call')
  async callMcpTool(@Req() req: any, @Body() body: { name: string; arguments?: Record<string, any> }) {
    if (!body.name || typeof body.name !== 'string') throw new ForbiddenException('缺少工具名称');
    const assignmentId = await this.resolveAssignment(req);
    const allowedTools = await this.cwService.getAuthorizedTools(assignmentId);

    // Strict match: canonical ID must be in the allow list
    const canonicalId = `jianzhi_${body.name}`;
    if (!allowedTools.includes(canonicalId)) {
      throw new ForbiddenException(`工具 ${body.name} 未授权给此 CoWorker`);
    }

    const result = await this.mcpTools.callTool(body.name, body.arguments || {});
    return result;
  }

  // ===== Message/Event Reporting (called by OpenClaw instances) =====

  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/report/messages')
  async reportMessages(@Req() req: any, @Body() body: { messages: any[] }) {
    const assignmentId = await this.resolveAssignment(req);
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const count = await this.cwService.recordMessages(assignmentId, messages);
    return { received: count };
  }

  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/report/events')
  async reportEvents(@Req() req: any, @Body() body: { events: any[] }) {
    const assignmentId = await this.resolveAssignment(req);
    const events = Array.isArray(body.events) ? body.events : [];

    for (const evt of events) {
      if (evt.type === 'heartbeat') {
        await this.cwService.updateHeartbeat(assignmentId);
        continue;
      }
      await this.cwService.recordEvent(assignmentId, evt.type, evt.payload);
    }
    return { received: events.length };
  }

  // ===== Helpers =====

  private extractToken(req: any): string {
    const auth = req.headers?.authorization || '';
    return auth.startsWith('Bearer ') ? auth.slice(7) : '';
  }

  /**
   * 汇总三个工具 id 命名空间，供 capabilities → tools 派生与存量反推使用。
   */
  private async buildToolRegistry(): Promise<{
    builtinIds: Set<string>;
    hostIds: Set<string>;
    kbNames: Set<string>;
    skillNames: Set<string>;
    mcpServerTools: Map<string, Set<string>>;
  }> {
    const manifest = this.cwOpenClaw.getToolsManifest();
    const builtinSource = manifest?.length ? manifest : OPENCLAW_BUILTIN_TOOLS;
    const kbTools = await this.mcpTools.getAvailableTools();
    const mcpServerTools = new Map<string, Set<string>>();
    for (const server of this.mcpRegistry.getEnabled()) {
      if (!server.tools?.length || !server.handlerCode) continue;
      mcpServerTools.set(server.name, new Set(server.tools.map(t => t.name)));
    }
    return {
      builtinIds: new Set(builtinSource.map(t => t.id)),
      hostIds: new Set(this.toolBridge.getCatalog().map(t => t.id)),
      kbNames: new Set(kbTools.map(t => t.name)),
      skillNames: new Set(this.skillRegistry.getAll().map(s => s.name)),
      mcpServerTools,
    };
  }

  /**
   * capabilities 是管理界面写入的事实来源；tools/skills 由它派生。
   * 放在 controller 而非 CoWorkerService：后者注入 ToolBridgeService/McpToolsService
   * 会形成 AgentModule → BridgeModule 循环依赖。
   * 只发 tools 不发 capabilities 的老调用方行为不变。
   */
  private async applyCapabilityDerivation(body: any): Promise<{ body: any; rejected: string[] }> {
    if (!body || body.capabilities === undefined) return { body, rejected: [] };

    const registry = await this.buildToolRegistry();
    const { tools, skills, rejected } = this.cwConfig.deriveTools(body.capabilities, registry);
    if (rejected.length) {
      this.logger.warn(`能力派生忽略了未知条目: ${rejected.join(', ')}`);
    }
    return { body: { ...body, tools, skills }, rejected };
  }

  private requirePermission(req: any, permission: Permission) {
    const token = this.extractToken(req);
    if (!token || !this.userService.hasPermission(token, permission)) {
      throw new ForbiddenException('权限不足');
    }
  }

  private getMainUrl(req: any): string {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:1111';
    return `${proto}://${host}`;
  }

  @Post('coworkers/_push-api-keys')
  async pushApiKeysToAll(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');
    const pushed = await this.cwGateway.pushApiKeyConfigToAll();
    return { pushed, message: `已推送 API Key 配置到 ${pushed} 个在线AI员工` };
  }

  /**
   * Resolve the CoWorker assignment from the request.
   * For CW proxy endpoints, the JWT contains both user id and coworker id.
   * The coworkerId is included in the JWT claims (via signCoWorkerToken).
   * Falls back to X-Coworker-Id header for backward compatibility.
   */
  private async resolveAssignment(req: any): Promise<string> {
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('未授权');

    // Try to get coworkerId from JWT claims first (new flow)
    let coworkerId = req.user?.coworkerId;

    // Fallback to X-Coworker-Id header (old flow for backward compatibility)
    if (!coworkerId) {
      coworkerId = req.headers['x-coworker-id'];
    }

    if (!coworkerId) throw new ForbiddenException('缺少 CoWorker ID (JWT中未找到且未提供X-Coworker-Id请求头)');

    const assignmentId = await this.cwService.resolveAssignmentId(userId, coworkerId);
    if (!assignmentId) throw new ForbiddenException('无有效的 CoWorker 分配');
    return assignmentId;
  }

  // ===== Workflow Transaction API =====

  /**
   * 创建新的工作流事务
   * 用于启动一个多步骤的工作流，支持失败补偿
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/workflow/create')
  async createWorkflow(@Req() req: any, @Body() body: {
    workflowType: string;
    description?: string;
    steps: WorkflowStep[];
    initialContext?: Record<string, any>;
  }) {
    const assignmentId = await this.resolveAssignment(req);

    // 获取 CoWorker 和用户信息
    const assignment = await this.cwService.getAssignment(assignmentId);
    if (!assignment) throw new NotFoundException('分配记录不存在');

    const options: CreateWorkflowOptions = {
      workflowType: body.workflowType,
      description: body.description,
      // 只取白名单字段：补偿动作由服务端按工具名推导，客户端不得指定
      steps: (body.steps || []).map((s: any) => ({
        stepNumber: s.stepNumber,
        stepName: s.stepName,
        toolName: s.toolName,
        inputParams: s.inputParams || {},
      })),
      initialContext: body.initialContext,
    };

    const workflow = await this.workflowService.createWorkflow(
      assignmentId,
      assignment.coworkerId,
      assignment.userId,
      options,
    );

    return {
      workflowId: workflow.workflowId,
      status: workflow.status,
      stepsCount: options.steps.length,
    };
  }

  /**
   * 启动工作流执行
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/workflow/:workflowId/start')
  async startWorkflow(@Req() req: any, @Param('workflowId') workflowId: string) {
    const assignmentId = await this.resolveAssignment(req);

    // 验证工作流属于该分配
    const workflow = await this.workflowService.getWorkflow(workflowId);
    if (workflow.assignmentId !== assignmentId) {
      throw new ForbiddenException('无权访问此工作流');
    }

    const updated = await this.workflowService.startWorkflow(workflowId);

    // 异步执行工作流
    this.workflowService.executeWorkflow(workflowId, async (toolName, params, context) => {
      // 执行工具的逻辑
      // 判断工具来源并调用
      const mainToolsCatalog = this.toolBridge.getCatalog();
      const isMainTool = mainToolsCatalog.some(t => t.id === toolName);

      if (isMainTool) {
        // 主台工具
        const user = await this.userService.getUser(req.user?.id || '');
        const ctx = { userId: user?.id, userEmail: user?.email };
        const tools = await this.toolBridge.buildForAgent([toolName], ctx);
        const tool = tools.find(t => t.name === toolName);
        if (!tool) throw new Error(`Tool ${toolName} not found`);
        return await tool.execute('', params);
      } else {
        // MCP/知识库工具
        const result = await this.mcpTools.callTool(toolName, params);
        return { content: [{ type: 'text', text: result }] };
      }
    }).catch(err => {
      this.logger.error(`Workflow execution failed: ${err.message}`);
    });

    return updated;
  }

  /**
   * 手动补偿工作流
   * 撤销已完成步骤的副作用（删除产出文件）
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/workflow/:workflowId/compensate')
  async compensateWorkflow(@Req() req: any, @Param('workflowId') workflowId: string, @Body() body: { reason?: string }) {
    const assignmentId = await this.resolveAssignment(req);

    const workflow = await this.workflowService.getWorkflow(workflowId);
    if (workflow.assignmentId !== assignmentId) {
      throw new ForbiddenException('无权访问此工作流');
    }

    const reason = body?.reason || '调用方请求补偿';
    const compensatedSteps = await this.workflowService.compensateWorkflow(workflowId, reason);
    const updated = await this.workflowService.failWorkflow(workflowId, reason);

    return { workflowId, status: updated.status, compensatedSteps };
  }

  /**
   * 获取工作流状态
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Get('cw/workflow/:workflowId')
  async getWorkflowStatus(@Req() req: any, @Param('workflowId') workflowId: string) {
    const assignmentId = await this.resolveAssignment(req);

    const workflow = await this.workflowService.getWorkflow(workflowId);
    if (workflow.assignmentId !== assignmentId) {
      throw new ForbiddenException('无权访问此工作流');
    }

    const steps = await this.workflowService.getSteps(workflowId);
    const attachments = await this.workflowService.getAttachments(workflowId);

    return {
      ...workflow,
      steps,
      attachments,
    };
  }

  /**
   * 获取工作流附件列表
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Get('cw/workflow/:workflowId/attachments')
  async getWorkflowAttachments(@Req() req: any, @Param('workflowId') workflowId: string, @Query('role') role?: string) {
    const assignmentId = await this.resolveAssignment(req);

    const workflow = await this.workflowService.getWorkflow(workflowId);
    if (workflow.assignmentId !== assignmentId) {
      throw new ForbiddenException('无权访问此工作流');
    }

    return await this.workflowService.getAttachments(workflowId, role);
  }

  /**
   * 添加工作流附件
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/workflow/:workflowId/attachments')
  async addWorkflowAttachment(
    @Req() req: any,
    @Param('workflowId') workflowId: string,
    @Body() body: {
      fileId: string;
      filename: string;
      fileType: string;
      role: 'input' | 'output' | 'attachment';
      stepId?: string;
      metadata?: Record<string, any>;
    },
  ) {
    const assignmentId = await this.resolveAssignment(req);

    const workflow = await this.workflowService.getWorkflow(workflowId);
    if (workflow.assignmentId !== assignmentId) {
      throw new ForbiddenException('无权访问此工作流');
    }

    await this.workflowService.addAttachment(
      workflowId,
      body.fileId,
      body.filename,
      body.fileType,
      body.role,
      body.stepId,
      body.metadata,
    );

    return { success: true };
  }

  // ===== User Profile Management =====

  /**
   * 获取当前用户个人信息
   * 用于CoWorker客户端获取用户邮箱等信息
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Get('cw/user/profile')
  async getUserProfile(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('未授权');

    const profile = await this.userService.getUserProfile(userId);
    if (!profile) {
      // 如果没有profile，创建默认的
      const user = await this.userService.getUser(userId);
      if (!user) throw new NotFoundException('用户不存在');

      return {
        userId: user.id,
        userName: user.name,
        userEmail: user.email,
        email: null,
        phone: null,
        department: null,
        position: null,
        location: null,
        preferences: {},
        isFirstFill: true,
        isComplete: false,
      };
    }

    // 检查信息是否完整
    const isComplete = await this.userService.isProfileComplete(userId);

    return {
      ...profile,
      isComplete,
    };
  }

  /**
   * 更新当前用户个人信息
   * 用于CoWorker客户端更新用户邮箱等信息
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Post('cw/user/profile')
  async updateUserProfile(@Req() req: any, @Body() body: {
    email?: string;
    phone?: string;
    department?: string;
    position?: string;
    location?: string;
    preferences?: Record<string, any>;
  }) {
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('未授权');

    try {
      const updated = await this.userService.updateUserProfile(userId, body);

      // 如果信息更新了，通知所有连接的客户端（通过WebSocket）
      if (body.email || body.phone || body.department || body.position) {
        this.cwGateway.broadcastUserProfileUpdate(userId, updated);
      }

      return {
        success: true,
        profile: updated,
      };
    } catch (err: any) {
      if (err.message.includes('邮箱')) {
        throw new ForbiddenException(err.message);
      }
      throw err;
    }
  }

  /**
   * 检查用户信息是否完整
   * 用于CoWorker客户端判断是否需要提示用户补充信息
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Get('cw/user/profile/complete')
  async checkProfileComplete(@Req() req: any) {
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('未授权');

    const isComplete = await this.userService.isProfileComplete(userId);
    const profile = await this.userService.getUserProfile(userId);

    return {
      isComplete,
      isFirstFill: profile?.isFirstFill || true,
      missingFields: this.getMissingFields(profile),
    };
  }

  /**
   * 获取用户信息变更历史
   */
  @Public()
  @UseGuards(CoWorkerAuthGuard)
  @Get('cw/user/profile/history')
  async getProfileHistory(@Req() req: any, @Query('limit') limit?: string) {
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('未授权');

    const history = await this.userService.getProfileChangeHistory(userId, limit ? parseInt(limit) : 20);

    return {
      history,
      total: history.length,
    };
  }

  /**
   * 辅助方法：获取缺失的必填字段
   */
  private getMissingFields(profile: any): string[] {
    const missing: string[] = [];
    if (!profile || profile.isFirstFill) {
      if (!profile?.email) missing.push('email');
    }
    return missing;
  }

  // ===== Soul Sync Optimization API =====

  /**
   * 获取CoWorker的Soul同步健康状态
   */
  @Get('coworkers/:id/sync-health')
  async getSoulSyncHealth(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:view');

    const health = await this.cwService.checkSoulSyncHealth(id);
    return health;
  }

  /**
   * 获取CoWorker的Soul同步历史
   */
  @Get('coworkers/:id/sync-history')
  async getSoulSyncHistory(@Req() req: any, @Param('id') id: string, @Query('limit') limit?: string) {
    this.requirePermission(req, 'cw:view');

    const history = await this.cwService.getSoulSyncHistory(id, limit ? parseInt(limit) : 20);
    return {
      coworkerId: id,
      history,
      total: history.length,
    };
  }

  /**
   * 获取CoWorker的当前版本号（用于乐观锁）
   */
  @Get('coworkers/:id/version')
  async getCoWorkerVersion(@Req() req: any, @Param('id') id: string) {
    this.requirePermission(req, 'cw:view');

    const version = await this.cwService.getCoWorkerVersion(id);
    return {
      coworkerId: id,
      version,
    };
  }

  /**
   * 使用乐观锁更新CoWorker（带版本检查）
   */
  @Put('coworkers/:id/versioned-update')
  async updateWithOptimisticLock(
    @Req() req: any,
    @Param('id') id: string,
    @Body() body: {
      expectedVersion: number;
      updates: Partial<{
        name: string; description: string; avatarUrl: string; soul: string;
        modelLevel: string; tools: string[]; skills: string[]; mcpServers: string[];
        capabilities: CoWorkerCapabilities;
        workScope: string; configOverrides: Record<string, any>; wechatConfig: Record<string, any>;
        kbBindings: string[];
      }>;
    },
  ) {
    this.requirePermission(req, 'cw:manage');

    try {
      const { body: updates } = await this.applyCapabilityDerivation(body.updates);
      const updated = await this.cwService.updateWithOptimisticLock(id, updates, body.expectedVersion);

      // 推送配置更新到所有连接的CoWorker
      if (updated) {
        const assignments = await this.cwService.listAssignments(id);
        if (assignments.length > 0) {
          this.cwGateway.pushConfigUpdate(id, updated.configVersion);
        }
      }

      return updated;
    } catch (err: any) {
      if (err.message.includes('乐观锁冲突')) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  /**
   * 获取系统级Soul同步状态摘要
   */
  @Get('coworkers/sync-status-summary')
  async getSyncStatusSummary(@Req() req: any) {
    this.requirePermission(req, 'cw:view');

    const summary = await this.cwGateway.getSyncStatusSummary();
    return summary;
  }

  /**
   * 检查Gateway是否可以安全重载
   */
  @Get('coworkers/gateway-can-reload')
  async canGatewayReload(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');

    const result = await this.cwGateway.canGatewayReload();
    return result;
  }

  // ===== Gateway Health Monitoring (Task #12) =====

  /**
   * 客户端报告Gateway崩溃事件
   * POST /api/cw/gateway/crash-report
   */
  @Public()
  @Post('cw/gateway/crash-report')
  async reportGatewayCrash(@Body() report: CrashReport) {
    this.logger.warn(`Gateway crash reported: ${report.assignmentId.slice(0,8)} reason=${report.crashReason}`);

    const result = await this.gatewayHealth.reportCrash(report);
    return {
      success: result.recorded,
      crashId: result.crashId,
      message: result.recorded ? '崩溃报告已记录' : '记录失败',
    };
  }

  /**
   * 客户端保存健康状态快照
   * POST /api/cw/gateway/health-snapshot
   */
  @Public()
  @Post('cw/gateway/health-snapshot')
  async saveHealthSnapshot(@Body() snapshot: HealthSnapshot) {
    const result = await this.gatewayHealth.saveHealthSnapshot(snapshot);
    return {
      success: result.saved,
    };
  }

  /**
   * 更新Gateway崩溃恢复信息
   * PUT /api/cw/gateway/crash/:crashId/recovery
   */
  @Public()
  @Put('cw/gateway/crash/:crashId/recovery')
  async updateCrashRecovery(
    @Param('crashId') crashId: string,
    @Body() body: { recoveredAt: string; success: boolean },
  ) {
    const result = await this.gatewayHealth.updateRecoveryInfo(
      crashId,
      new Date(body.recoveredAt),
      body.success,
    );
    return {
      success: result.updated,
    };
  }

  /**
   * 获取Gateway健康统计数据（管理员）
   * GET /api/coworkers/gateway-health-stats
   */
  @Get('coworkers/gateway-health-stats')
  async getGatewayHealthStats(
    @Req() req: any,
    @Query('timeWindow') timeWindow?: string,
  ) {
    this.requirePermission(req, 'cw:view');

    const stats = await this.gatewayHealth.getHealthStats(timeWindow || '24 hours');
    return stats;
  }

  /**
   * 获取特定分配的崩溃历史（管理员）
   * GET /api/coworkers/assignment/:assignmentId/crash-history
   */
  @Get('coworkers/assignment/:assignmentId/crash-history')
  async getAssignmentCrashHistory(
    @Req() req: any,
    @Param('assignmentId') assignmentId: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    this.requirePermission(req, 'cw:view');

    const history = await this.gatewayHealth.getCrashHistory(
      assignmentId,
      limit ? parseInt(limit) : 50,
      offset ? parseInt(offset) : 0,
    );

    return {
      assignmentId,
      history,
      total: history.length,
    };
  }

  /**
   * 获取Gateway在线状态（管理员）
   * GET /api/coworkers/gateway-online-status
   */
  @Get('coworkers/gateway-online-status')
  async getGatewayOnlineStatus(@Req() req: any) {
    this.requirePermission(req, 'cw:view');

    const onlineStatus = this.cwGateway.getOnlineStatus();
    return {
      connections: onlineStatus.size,
      assignments: Array.from(onlineStatus.entries()).map(([coworkerId, info]) => ({
        coworkerId,
        assignmentId: info.assignmentId,
        socketId: info.socketId,
        userId: info.userId,
      })),
    };
  }

  /**
   * 手动清理旧的健康数据（管理员）
   * POST /api/coworkers/gateway-health-cleanup
   */
  @Post('coworkers/gateway-health-cleanup')
  async cleanupGatewayHealthData(@Req() req: any) {
    this.requirePermission(req, 'cw:manage');

    const result = await this.gatewayHealth.cleanupOldData();
    return {
      cleaned: true,
      crashesCleaned: result.crashesCleaned,
      snapshotsCleaned: result.snapshotsCleaned,
      message: `已清理 ${result.crashesCleaned} 条崩溃记录和 ${result.snapshotsCleaned} 条健康快照`,
    };
  }

  // ===== Activation Status Reset (L-03) =====

  /**
   * 重置激活状态（客户端调用）
   * POST /api/cw/assignment/:assignmentId/reset
   *
   * 客户端在重置激活时调用此接口，服务器端执行原子性重置操作
   */
  @Public()
  @Post('cw/assignment/:assignmentId/reset')
  async resetAssignmentActivation(
    @Param('assignmentId') assignmentId: string,
    @Body() body: { action?: 'reset_start' | 'reset_confirm'; timestamp?: number; clearApiKey?: boolean },
  ) {
    this.logger.log(`Assignment reset requested: ${assignmentId.slice(0,8)} action=${body.action || 'none'}`);

    const result = await this.cwService.resetActivationStatus(assignmentId, body);

    if (result.success) {
      // 通知Gateway推送新配置（如果在线）
      this.cwGateway.pushConfigUpdate(assignmentId, result.newConfigVersion || Date.now());
    }

    return result;
  }

  /**
   * 批量重置用户的所有分配（管理员）
   * POST /api/coworkers/user/:userId/reset-all
   */
  @Post('coworkers/user/:userId/reset-all')
  async resetAllUserAssignments(
    @Req() req: any,
    @Param('userId') userId: string,
    @Body() body: { clearApiKeys?: boolean },
  ) {
    this.requirePermission(req, 'cw:manage');

    this.logger.log(`Reset all assignments for user ${userId}`);

    const result = await this.cwService.resetAllUserAssignments(userId, body);

    return {
      userId,
      resetCount: result.resetCount,
      failures: result.failures,
      message: result.resetCount > 0
        ? `已重置 ${result.resetCount} 个分配${result.failures.length > 0 ? `，${result.failures.length} 个失败` : ''}`
        : '没有需要重置的分配',
    };
  }

  /**
   * 获取分配的激活状态（用于前端显示）
   * GET /api/cw/assignment/:assignmentId/activation-status
   */
  @Public()
  @Get('cw/assignment/:assignmentId/activation-status')
  async getAssignmentActivationStatus(
    @Param('assignmentId') assignmentId: string,
  ) {
    const assignment = await this.cwService.getAssignment(assignmentId);

    if (!assignment) {
      throw new NotFoundException('分配不存在');
    }

    // 检查是否在重置过程中
    const resetTimestamp = await this.db.query(
      'SELECT * FROM jz_soul_sync_history WHERE assignment_id = $1 AND trigger_source = $2 ORDER BY started_at DESC LIMIT 1',
      [assignmentId, 'manual'],
    );

    const isResetting = resetTimestamp.rows.length > 0 &&
      Date.now() - new Date(resetTimestamp.rows[0].started_at).getTime() < 300000; // 5分钟内

    return {
      assignmentId: assignment.id,
      configVersion: assignment.configVersion,
      syncStatus: assignment.syncStatus || 'idle',
      lastSyncAt: assignment.lastSyncAt,
      isResetting,
      hasApiKey: !!assignment.apiKey,
      status: assignment.status,
    };
  }

  // ===== Onboarding State Management (P1) =====

  /**
   * 获取引导状态
   * GET /api/cw/assignment/:assignmentId/onboarding
   */
  @Public()
  @Get('cw/assignment/:assignmentId/onboarding')
  async getOnboardingState(@Param('assignmentId') assignmentId: string) {
    const { rows } = await this.db.query(
      'SELECT onboarding_state FROM jz_coworker_assignments WHERE id = $1',
      [assignmentId],
    );

    if (rows.length === 0) {
      throw new NotFoundException('分配不存在');
    }

    const state = rows[0].onboarding_state || {
      completed: false,
      step: 0,
      skipped: [],
      profileCompleted: false,
    };

    return {
      assignmentId,
      onboarding: state,
    };
  }

  /**
   * 更新引导状态
   * POST /api/cw/assignment/:assignmentId/onboarding
   */
  @Public()
  @Post('cw/assignment/:assignmentId/onboarding')
  async updateOnboardingState(
    @Param('assignmentId') assignmentId: string,
    @Body() body: {
      step?: number;
      completed?: boolean;
      skipped?: string[];
      profileCompleted?: boolean;
    },
  ) {
    const { rows } = await this.db.query(
      'SELECT onboarding_state FROM jz_coworker_assignments WHERE id = $1',
      [assignmentId],
    );

    if (rows.length === 0) {
      throw new NotFoundException('分配不存在');
    }

    const currentState = rows[0].onboarding_state || {
      completed: false,
      step: 0,
      skipped: [],
      profileCompleted: false,
      startedAt: null,
      lastAt: null,
    };

    // 更新状态
    const newState = {
      ...currentState,
      ...(body.step !== undefined && { step: body.step }),
      ...(body.completed !== undefined && { completed: body.completed }),
      ...(body.skipped !== undefined && { skipped: body.skipped }),
      ...(body.profileCompleted !== undefined && { profileCompleted: body.profileCompleted }),
      lastAt: new Date().toISOString(),
    };

    // 如果是第一次更新，记录开始时间
    if (!currentState.startedAt) {
      newState.startedAt = new Date().toISOString();
    }

    await this.db.query(
      'UPDATE jz_coworker_assignments SET onboarding_state = $1 WHERE id = $2',
      [JSON.stringify(newState), assignmentId],
    );

    this.logger.log(`Onboarding state updated: ${assignmentId.slice(0,8)} step=${newState.step} completed=${newState.completed}`);

    return {
      assignmentId,
      onboarding: newState,
    };
  }

  /**
   * 跳过引导
   * POST /api/cw/assignment/:assignmentId/onboarding/skip
   */
  @Public()
  @Post('cw/assignment/:assignmentId/onboarding/skip')
  async skipOnboarding(
    @Param('assignmentId') assignmentId: string,
    @Body() body: { reason?: string },
  ) {
    const skipState = {
      completed: true,
      step: -1,  // -1 表示跳过
      skipped: ['all'],
      profileCompleted: false,
      skippedAt: new Date().toISOString(),
      skipReason: body.reason || 'user_skipped',
    };

    await this.db.query(
      'UPDATE jz_coworker_assignments SET onboarding_state = $1 WHERE id = $2',
      [JSON.stringify(skipState), assignmentId],
    );

    this.logger.log(`Onboarding skipped: ${assignmentId.slice(0,8)} reason=${body.reason || 'none'}`);

    return {
      assignmentId,
      onboarding: skipState,
      message: '引导已跳过',
    };
  }

  /**
   * 重置引导状态（重新开始）
   * POST /api/cw/assignment/:assignmentId/onboarding/reset
   */
  @Public()
  @Post('cw/assignment/:assignmentId/onboarding/reset')
  async resetOnboarding(@Param('assignmentId') assignmentId: string) {
    const resetState = {
      completed: false,
      step: 0,
      skipped: [],
      profileCompleted: false,
      startedAt: new Date().toISOString(),
      lastAt: new Date().toISOString(),
      resetCount: 1,
    };

    await this.db.query(
      'UPDATE jz_coworker_assignments SET onboarding_state = $1 WHERE id = $2',
      [JSON.stringify(resetState), assignmentId],
    );

    this.logger.log(`Onboarding reset: ${assignmentId.slice(0,8)}`);

    return {
      assignmentId,
      onboarding: resetState,
      message: '引导已重置，将重新开始',
    };
  }

  /**
   * 获取需要引导的分配列表（管理员）
   * GET /api/coworkers/onboarding/pending
   */
  @Get('coworkers/onboarding/pending')
  async getPendingOnboarding(@Req() req: any) {
    this.requirePermission(req, 'cw:view');

    const { rows } = await this.db.query(`
      SELECT
        a.id as assignment_id,
        a.user_id,
        a.coworker_id,
        a.onboarding_state,
        a.created_at,
        u.name as user_name,
        u.email as user_email,
        c.name as coworker_name
      FROM jz_coworker_assignments a
      JOIN jz_users u ON a.user_id = u.id
      JOIN jz_coworkers c ON a.coworker_id = c.id
      WHERE (a.onboarding_state->>'completed') = 'false'
      ORDER BY a.created_at DESC
    `);

    return {
      pending: rows.map((row: any) => ({
        assignmentId: row.assignment_id,
        userId: row.user_id,
        coworkerId: row.coworker_id,
        userName: row.user_name,
        userEmail: row.user_email,
        coworkerName: row.coworker_name,
        onboarding: row.onboarding_state,
        createdAt: row.created_at,
      })),
      total: rows.length,
    };
  }
}
