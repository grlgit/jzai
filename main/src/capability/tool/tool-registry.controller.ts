import { Controller, Get, Delete, Patch, Put, Post, Param, Body, Req, NotFoundException, Optional } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { AppCapabilityService } from '../../platform/app-store/services/app-capability.service';
import { RequireAdmin } from '../../platform/authz/require-permission.decorator';
import { createUserPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import { AppMcpExposeService } from '../../platform/app-store/services/app-mcp-expose.service';

@Controller('api/tools')
export class ToolRegistryController {
  constructor(
    private readonly tools: ToolRegistryService,
    private readonly appCapabilities: AppCapabilityService,
    // P3：mcpExposed 审批状态标记（@Optional 保持旧式构造兼容）
    @Optional() private readonly mcpExpose?: AppMcpExposeService,
  ) {}

  /** APP 来源工具名集合（写操作仅对本地 tool 目录资源有效） */
  private async appToolNames(): Promise<Set<string>> {
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('tool');
    return new Set(sourceMap?.keys() ?? []);
  }

  @Get('deleted')
  listDeleted() { return this.tools.listDeleted(); }

  @RequireAdmin()
  @Post('deleted/:dirName/restore')
  restore(@Param('dirName') dirName: string) { return this.tools.restore(dirName); }

  @RequireAdmin()
  @Delete('deleted/:dirName')
  purge(@Param('dirName') dirName: string) { return this.tools.purge(dirName); }

  /** P1：列表按 principal 过滤（修 V6——无授权用户不再见到未授权工具）；admin 全量 */
  @Get()
  async list(@Req() req: any) {
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('tool');
    const p = createUserPrincipal(req.user, 'http:tools');
    const isAdmin = p.permissions.includes('sys:admin');
    const all = await this.tools.getAllForPrincipal(p);
    const workspaceTools = (isAdmin ? this.tools.getAll() : all).map(t => ({
      name: t.name, system: t.system, description: t.description,
      llmHint: t.llmHint || null,
      authSystem: t.authSystem || t.system || t.name,
      authFields: t.authFields || null,
      paramCount: t.parameters.length, enabled: t.enabled,
      permissions: t.permissions, status: t.status,
      sourceApp: sourceMap?.get(t.name) ?? null,
    }));
    // P3：已审批（首方恒过）的 mcpExposed 工具集合——列表中带 exposedViaMcp 标记，
    // 设置面板据此出"授权"入口（授权走既有 jz_resource_grants(resource_type='tool')）
    const exposedApproved = new Set<string>();
    if (this.mcpExpose) {
      for (const d of await this.mcpExpose.listDeclared()) {
        if (d.allowed) for (const id of d.toolIds) exposedApproved.add(id);
      }
    }
    // APP 包工具不在 workspace 注册表中，按能力映射补充进列表（仅展示，标识来源应用）
    const listed = new Set(workspaceTools.map(t => t.name));
    const appTools = [...(sourceMap?.entries() ?? [])]
      .filter(([name]) => !listed.has(name))
      .map(([name, sourceApp]) => ({
        name, system: sourceApp.appId, description: '',
        llmHint: null, authSystem: name, authFields: null,
        paramCount: 0, enabled: true, permissions: null, status: 'active',
        sourceApp,
        // P3：声明 mcpExposed 且审批通过（未审批三方包恒 false——不出授权入口、不进 MCP facade）
        exposedViaMcp: exposedApproved.has(name),
      }));
    return [...workspaceTools, ...appTools];
  }

  /** @deprecated Use GET /api/agents/tool-catalog instead */
  @Get('builtin')
  getBuiltinTools() {
    // Redirect to the canonical source — but kept for backward compatibility
    // Frontend should call /api/agents/tool-catalog
    return [];
  }

  @Get(':name')
  async getDetail(@Param('name') name: string) {
    const t = this.tools.get(name);
    if (t) return t;
    // APP 包工具无 workspace 详情，返回占位避免前端详情页报 Not found
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('tool');
    const sourceApp = sourceMap?.get(name);
    if (sourceApp) return { name, sourceApp, appTool: true };
    return { error: 'Not found' };
  }

  @RequireAdmin()
  @Patch(':name')
  async toggle(@Param('name') name: string, @Body() body: { enabled?: boolean }) {
    if ((await this.appToolNames()).has(name)) {
      throw new NotFoundException(`APP 工具 ${name} 不可在此管理（写操作仅对本地工具有效）`);
    }
    if (body.enabled === undefined) return { error: 'No update provided' };
    const ok = body.enabled ? this.tools.enable(name) : this.tools.disable(name);
    return ok ? { success: true, name, enabled: body.enabled } : { error: 'Not found' };
  }

  @RequireAdmin()
  @Delete(':name')
  async deleteTool(@Param('name') name: string) {
    if ((await this.appToolNames()).has(name)) {
      throw new NotFoundException(`APP 工具 ${name} 不可在此删除`);
    }
    return this.tools.delete(name) ? { success: true } : { error: 'Not found' };
  }

  @Get(':name/manifest')
  getManifest(@Param('name') name: string) {
    const manifest = this.tools.getManifest(name);
    return manifest !== null ? { manifest } : { error: 'Not found' };
  }

  @RequireAdmin()
  @Put(':name/manifest')
  saveManifest(@Param('name') name: string, @Body() body: { manifest: string }) {
    return this.tools.saveManifest(name, body.manifest) ? { success: true } : { error: 'Not found' };
  }

  @RequireAdmin()
  @Get(':name/handler')
  getHandler(@Param('name') name: string) {
    const handler = this.tools.getHandler(name);
    return handler !== null ? { handler } : { error: 'Not found' };
  }

  @RequireAdmin()
  @Put(':name/handler')
  saveHandler(@Param('name') name: string, @Body() body: { handler: string }) {
    return this.tools.saveHandler(name, body.handler) ? { success: true } : { error: 'Not found' };
  }

  @RequireAdmin()
  @Post('reload')
  reload() {
    this.tools.loadAll();
    return { tools: this.tools.getAll().length };
  }

  @RequireAdmin()
  @Put(':name/llm-hint')
  setLlmHint(@Param('name') name: string, @Body() body: { llmHint: string }) {
    return this.tools.setLlmHint(name, body.llmHint) ? { success: true } : { error: 'Not found' };
  }

  @RequireAdmin()
  @Put(':name/permissions')
  setPermissions(@Param('name') name: string, @Body() perms: { allowedRoles?: string[]; allowedUsers?: string[] }) {
    return this.tools.setPermissions(name, perms) ? { success: true } : { error: 'Not found' };
  }
}
