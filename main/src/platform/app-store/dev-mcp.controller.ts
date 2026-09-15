import {
  Controller, Post, Get, Delete, Body, Req, Headers,
  UnauthorizedException, NotFoundException, ForbiddenException,
  ServiceUnavailableException, Logger,
} from '@nestjs/common';
import { DevMcpService } from './services/dev-mcp.service';
import { Public } from '../auth/public.decorator';

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

  constructor(private readonly devMcp: DevMcpService) {}

  // ── token 管理（主台 JWT 鉴权，sys:admin）──

  @Post('token')
  async issueToken(@Req() req: any) {
    this.requireAdmin(req);
    const token = await this.devMcp.issueToken(req.user?.id ?? 'unknown');
    // token 仅在本次响应完整返回一次
    return { token, note: '请妥善保存，仅本次完整显示；丢失请吊销后重新签发' };
  }

  @Get('token')
  async tokenStatus(@Req() req: any) {
    this.requireAdmin(req);
    const enabled = this.devMcp.isEnabled();
    return { enabled, ...(await this.devMcp.getTokenStatus()) };
  }

  @Delete('token')
  async revokeToken(@Req() req: any) {
    this.requireAdmin(req);
    await this.devMcp.revokeToken(req.user?.id ?? 'unknown');
    return { ok: true };
  }

  // ── MCP JSON-RPC 端点（dev token 鉴权，@Public 跳过 JWT 守卫）──

  @Public()
  @Post('mcp')
  async mcp(@Body() body: any, @Headers('authorization') auth: string) {
    if (!this.devMcp.isEnabled()) throw new NotFoundException();
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!(await this.devMcp.verifyToken(token))) {
      throw new UnauthorizedException('Invalid or missing dev token');
    }

    const { id, method, params } = body ?? {};
    try {
      const result = await this.dispatch(method, params ?? {}, token!);
      return { jsonrpc: '2.0', id: id ?? null, result };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id: id ?? null,
        error: { code: -32000, message: err.message ?? 'internal error' },
      };
    }
  }

  private async dispatch(method: string, params: any, actorId: string): Promise<unknown> {
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
        return { tools: await this.devMcp.listTools() };
      case 'tools/call': {
        const result = await this.devMcp.callTool(params.name, params.arguments ?? {}, actorId);
        return {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
        };
      }
      case 'resources/list':
        return { resources: await this.devMcp.listResources() };
      case 'resources/read':
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
