import { Controller, Get, Post, Put, Delete, Body, Param } from '@nestjs/common';
import { AgentRegistryService } from './agent-registry.service';
import { ToolBuilderService } from './tool-builder.service';
import { Public } from '../../platform/auth/public.decorator';
import type { AgentDef } from './agent-registry.service';
import { AppCapabilityService } from '../../platform/app-store/services/app-capability.service';

@Controller('api/agents')
export class AgentRegistryController {
  constructor(
    private readonly registry: AgentRegistryService,
    private readonly toolBuilder: ToolBuilderService,
    private readonly appCapabilities: AppCapabilityService,
  ) {}

  @Public()
  @Get('available-tools')
  availableTools() {
    return this.toolBuilder.getAvailableToolCatalog();
  }

  /** Builtin tools grouped by category (for Settings page) */
  @Public()
  @Get('tool-catalog')
  toolCatalog() {
    return this.toolBuilder.getBuiltinToolsByCategory();
  }

  @Public()
  @Get()
  async list() {
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('agent');
    return this.registry.getAll().map(a => ({
      id: a.id, name: a.name, icon: a.icon,
      description: a.description, modelLevel: a.modelLevel,
      builtin: a.builtin, tools: a.tools, defaultPanel: a.defaultPanel,
      messageDisplay: a.messageDisplay,
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
  create(@Body() body: AgentDef) {
    if (this.registry.get(body.id)) return { error: 'Agent already exists' };
    this.registry.save({ ...body, builtin: false });
    return { success: true };
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() body: Partial<AgentDef>) {
    const existing = this.registry.get(id);
    if (!existing) return { error: 'Agent not found' };
    this.registry.save({ ...existing, ...body, id: existing.id, builtin: existing.builtin });
    return { success: true };
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return { success: this.registry.delete(id) };
  }
}
