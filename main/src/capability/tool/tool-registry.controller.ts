import { Controller, Get, Delete, Patch, Put, Post, Param, Body } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { AppCapabilityService } from '../../platform/app-store/services/app-capability.service';

@Controller('api/tools')
export class ToolRegistryController {
  constructor(
    private readonly tools: ToolRegistryService,
    private readonly appCapabilities: AppCapabilityService,
  ) {}

  @Get('deleted')
  listDeleted() { return this.tools.listDeleted(); }

  @Post('deleted/:dirName/restore')
  restore(@Param('dirName') dirName: string) { return this.tools.restore(dirName); }

  @Delete('deleted/:dirName')
  purge(@Param('dirName') dirName: string) { return this.tools.purge(dirName); }

  @Get()
  async list() {
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('tool');
    const workspaceTools = this.tools.getAll().map(t => ({
      name: t.name, system: t.system, description: t.description,
      llmHint: t.llmHint || null,
      authSystem: t.authSystem || t.system || t.name,
      authFields: t.authFields || null,
      paramCount: t.parameters.length, enabled: t.enabled,
      permissions: t.permissions, status: t.status,
      sourceApp: sourceMap?.get(t.name) ?? null,
    }));
    // APP 包工具不在 workspace 注册表中，按能力映射补充进列表（仅展示，标识来源应用）
    const listed = new Set(workspaceTools.map(t => t.name));
    const appTools = [...(sourceMap?.entries() ?? [])]
      .filter(([name]) => !listed.has(name))
      .map(([name, sourceApp]) => ({
        name, system: sourceApp.appId, description: '',
        llmHint: null, authSystem: name, authFields: null,
        paramCount: 0, enabled: true, permissions: null, status: 'active',
        sourceApp,
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

  @Patch(':name')
  toggle(@Param('name') name: string, @Body() body: { enabled?: boolean }) {
    if (body.enabled === undefined) return { error: 'No update provided' };
    const ok = body.enabled ? this.tools.enable(name) : this.tools.disable(name);
    return ok ? { success: true, name, enabled: body.enabled } : { error: 'Not found' };
  }

  @Delete(':name')
  deleteTool(@Param('name') name: string) {
    return this.tools.delete(name) ? { success: true } : { error: 'Not found' };
  }

  @Get(':name/manifest')
  getManifest(@Param('name') name: string) {
    const manifest = this.tools.getManifest(name);
    return manifest !== null ? { manifest } : { error: 'Not found' };
  }

  @Put(':name/manifest')
  saveManifest(@Param('name') name: string, @Body() body: { manifest: string }) {
    return this.tools.saveManifest(name, body.manifest) ? { success: true } : { error: 'Not found' };
  }

  @Get(':name/handler')
  getHandler(@Param('name') name: string) {
    const handler = this.tools.getHandler(name);
    return handler !== null ? { handler } : { error: 'Not found' };
  }

  @Put(':name/handler')
  saveHandler(@Param('name') name: string, @Body() body: { handler: string }) {
    return this.tools.saveHandler(name, body.handler) ? { success: true } : { error: 'Not found' };
  }

  @Post('reload')
  reload() {
    this.tools.loadAll();
    return { tools: this.tools.getAll().length };
  }

  @Put(':name/llm-hint')
  setLlmHint(@Param('name') name: string, @Body() body: { llmHint: string }) {
    return this.tools.setLlmHint(name, body.llmHint) ? { success: true } : { error: 'Not found' };
  }

  @Put(':name/permissions')
  setPermissions(@Param('name') name: string, @Body() perms: { allowedRoles?: string[]; allowedUsers?: string[] }) {
    return this.tools.setPermissions(name, perms) ? { success: true } : { error: 'Not found' };
  }
}
