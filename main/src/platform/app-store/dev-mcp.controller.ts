import {
  Controller, Post, Get, Delete, Body, Req, Headers, Param,
  UnauthorizedException, NotFoundException, ForbiddenException,
  ServiceUnavailableException, BadRequestException, Logger,
  UseInterceptors, UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import { DevMcpService } from './services/dev-mcp.service';
import { DevUploadService } from './services/dev-upload.service';
import { Public } from '../auth/public.decorator';
import { APP_ARCHIVE_LIMITS } from './services/safe-archive.service';

/**
 * Dev MCP facade（design-app-dev-mcp §3.2）。
 *
 * POST /api/dev/mcp — MCP JSON-RPC 端点（streamable-http 风格，initialize/tools/resources）。
 *   鉴权：Authorization: Bearer <dev-token>；默认关闭（system.json devMcp.enabled）。
 *   泛化自 /api/cw/mcp 的手写 JSON-RPC 模式，不引入 MCP SDK server。
 *
 * /api/dev/token — dev token 管理（JWT + sys:admin）。
 */
@Controller('api/dev')
export class DevMcpController {
  private readonly logger = new Logger(DevMcpController.name);

  constructor(
    private readonly devMcp: DevMcpService,
    private readonly uploads: DevUploadService,
  ) {}

  // ── token 管理（主台 JWT 鉴权，sys:admin）──

  @Post('token')
  async issueToken(@Req() req: any, @Body() body: any) {
    this.requireAdmin(req);
    const { token, tokenId } = await this.devMcp.issueToken(req.user?.id ?? 'unknown', body?.scopes);
    // token 仅在本次响应完整返回一次
    return { token, tokenId, note: '请妥善保存，仅本次完整显示；丢失请吊销后重新签发' };
  }

  @Get('token')
  async tokenStatus(@Req() req: any) {
    this.requireAdmin(req);
    const enabled = this.devMcp.isEnabled();
    return { enabled, ...(await this.devMcp.getTokenStatus()) };
  }

  @Delete('token')
  async revokeToken(@Req() req: any, @Body() body: any) {
    this.requireAdmin(req);
    await this.devMcp.revokeToken(req.user?.id ?? 'unknown', body?.tokenId);
    return { ok: true };
  }

  // ── 大包上传通道（multipart 不经 JSON body，规避 1mb 限制）──

  /**
   * 上传 .jzapp 包（multipart 字段 package）。
   * uploadId 可选：传了则绑定 jd_upload_begin 预留的句柄，缺省直接建档。
   * 返回 { uploadId, status: 'ready', size, sha256, expiresAt }。
   */
  @Public()
  @Post('uploads')
  @UseInterceptors(FileInterceptor('package', {
    storage: diskStorage({
      destination: (_req, _file, cb) => cb(null, os.tmpdir()),
      filename: (_req, _file, cb) =>
        cb(null, `jzdev-upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jzapp`),
    }),
    limits: { fileSize: APP_ARCHIVE_LIMITS.maxArchiveBytes },
  }))
  async upload(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: any,
    @Headers('authorization') auth: string,
  ) {
    // multer 先于鉴权落盘，鉴权失败须清理临时文件
    const fail = (err: unknown) => { if (file?.path) fs.rm(file.path, { force: true }, () => {}); throw err; };
    if (!this.devMcp.isEnabled()) return fail(new NotFoundException());
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const verified = await this.devMcp.verifyToken(token);
    if (!verified) return fail(new UnauthorizedException('Invalid or missing dev token'));
    if (!verified.scopes.includes('manage')) {
      return fail(new ForbiddenException('Dev token missing required scope: manage'));
    }
    if (!file) throw new BadRequestException('未收到文件（multipart 字段名须为 package）');

    const record = await this.uploads.attach(body?.uploadId, file.path, file.size);
    this.logger.log(`dev upload ready: ${record.uploadId} (${record.size}B) by dev-mcp:${verified.tokenId}`);
    return record;
  }

  /** 上传句柄状态查询（任意有效 dev token）。 */
  @Public()
  @Get('uploads/:uploadId')
  async uploadStatus(@Param('uploadId') uploadId: string, @Headers('authorization') auth: string) {
    if (!this.devMcp.isEnabled()) throw new NotFoundException();
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const verified = await this.devMcp.verifyToken(token);
    if (!verified) throw new UnauthorizedException('Invalid or missing dev token');
    return this.uploads.get(uploadId);
  }

  // ── MCP JSON-RPC 端点（dev token 鉴权，@Public 跳过 JWT 守卫）──

  @Public()
  @Post('mcp')
  async mcp(@Body() body: any, @Headers('authorization') auth: string) {
    if (!this.devMcp.isEnabled()) throw new NotFoundException();
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    const verified = await this.devMcp.verifyToken(token);
    if (!verified) {
      throw new UnauthorizedException('Invalid or missing dev token');
    }

    // 审计 principal 使用稳定 tokenId，绝不使用原始 token
    const actorId = `dev-mcp:${verified.tokenId}`;
    const { id, method, params } = body ?? {};
    try {
      const result = await this.dispatch(method, params ?? {}, actorId, verified.scopes);
      return { jsonrpc: '2.0', id: id ?? null, result };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32000, message: err.message ?? 'internal error' },
      };
    }
  }

  private requireScope(scopes: readonly string[], scope: string) {
    if (!scopes.includes(scope)) {
      throw new Error(`Dev token missing required scope: ${scope}`);
    }
  }

  private async dispatch(method: string, params: any, actorId: string, scopes: readonly string[]): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: 'jianzhi-dev-mcp', version: '1.0.0' },
        };
      case 'ping':
        return {};
      case 'tools/list':
        this.requireScope(scopes, 'read');
        return { tools: await this.devMcp.listTools() };
      case 'tools/call': {
        this.requireScope(scopes, 'invoke');
        // 安装/升级/卸载/上传类工具要求 manage scope（最小授权）
        if (/install|upgrade|uninstall|upload/i.test(String(params?.name ?? ''))) {
          this.requireScope(scopes, 'manage');
        }
        const result = await this.devMcp.callTool(params.name, params.arguments ?? {}, actorId);
        return {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        };
      }
      case 'resources/list':
        this.requireScope(scopes, 'read');
        return { resources: await this.devMcp.listResources() };
      case 'resources/read':
        this.requireScope(scopes, 'read');
        return { contents: [await this.devMcp.readResource(params.uri)] };
      default:
        if (method?.startsWith('notifications/')) return null;
        throw new Error(`Method not supported: ${method}`);
    }
  }

  private requireAdmin(req: any) {
    if (req.user?.role?.permissions?.includes('sys:admin') !== true) {
      throw new ForbiddenException('需要管理员权限');
    }
    if (!this.devMcp.isEnabled()) {
      throw new ServiceUnavailableException('devMcp 未启用（system.json devMcp.enabled）');
    }
  }
}
