import { Controller, Get, Post, Put, Delete, Body, Param, Req, NotFoundException } from '@nestjs/common';
import { AgentRegistryService } from './agent-registry.service';
import { ToolBuilderService } from './tool-builder.service';
import type { AgentDef } from './agent-registry.service';
import { AppCapabilityService } from '../../platform/app-store/services/app-capability.service';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';
import { createUserPrincipal, InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';

@Controller('api/agents')
export class AgentRegistryController {
  constructor(
    private readonly registry: AgentRegistryService,
    private readonly toolBuilder: ToolBuilderService,
    private readonly appCapabilities: AppCapabilityService,
    private readonly access: ResourceAccessService,
  ) {}

  private principalOf(req: any): InvocationPrincipal {
    return createUserPrincipal(req.user, 'http:agents');
  }

  // P1：目录按 principal 过滤（修 V1/V2 目录侧）
  @Get('available-tools')
  availableTools(@Req() req: any) {
    return this.toolBuilder.getAvailableToolCatalog(this.principalOf(req));
  }

  /** Builtin tools grouped by category (for Settings page) */
  @Get('tool-catalog')
  toolCatalog(@Req() req: any) {
    return this.toolBuilder.getBuiltinToolsByCategory(this.principalOf(req));
  }

  @Get()
  async list(@Req() req: any) {
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('agent');
    const agents = await this.registry.getAllForPrincipal(this.principalOf(req));
    return agents.map(a => ({
      id: a.id, name: a.name, icon: a.icon,
      description: a.description, modelLevel: a.modelLevel,
      builtin: a.builtin, tools: a.tools, defaultPanel: a.defaultPanel,
      messageDisplay: a.messageDisplay,
      scope: a.scope, ownerUserId: a.ownerUserId, canEdit: a.canEdit,
      sourceApp: sourceMap?.get(a.id) ?? null,
    }));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const agent = this.registry.get(id);
    if (!agent) return { error: 'Agent not found' };

    // Resolve actual runtime tools (expand mcp/tools/skills aggregates)
    let resolvedTools: string[] = [];
    try {
      const built = await this.toolBuilder.buildToolsForAgent(agent.tools);
      resolvedTools = built.map((t: any) => t.name || t.label || '');
    } catch {}

    return { ...agent, resolvedTools };
  }

  @Post('resolve-tools')
  async resolveTools(@Body() body: { tools: string[] }) {
    const built = await this.toolBuilder.buildToolsForAgent(body.tools || []);
    return { resolvedTools: built.map((t: any) => t.name || t.label || '') };
  }

  @Post()
  async create(@Body() body: AgentDef, @Req() req: any) {
    const p = this.principalOf(req);
    // P1：普通用户强制 u_{uid}_ 前缀；id 冲突 409，不覆盖既有 YAML（修 V2）
    const id = this.registry.allocateAgentId(body.id, p);
    await this.registry.save({ ...body, id, builtin: false }, p);
    return { success: true, id };
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Partial<AgentDef>, @Req() req: any) {
    const existing = this.registry.get(id);
    if (!existing) throw new NotFoundException('Agent not found');
    // P1：user 类仅 owner、global 类仅 admin 可编辑（admin 不可编辑他人 user 类）
    await this.access.assertCanEdit('agent', id, this.principalOf(req));
    await this.registry.save({ ...existing, ...body, id: existing.id, builtin: existing.builtin });
    return { success: true };
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: any) {
    await this.access.assertCanEdit('agent', id, this.principalOf(req));
    return { success: await this.registry.delete(id) };
  }
}
