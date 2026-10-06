import { Injectable } from '@nestjs/common';
import { KnowledgeToolsService } from '../../knowledge/tools/knowledge-tools.service';
import { KbAccessService } from '../../knowledge/kb-access.service';
import { SkillRegistryService } from '../skill/skill-registry.service';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';

/**
 * KnowledgeToolProvider — 知识库工具接入 agent 工具体系（主台基本工具库）。
 * 提供：kb_mcp（原始知识库工具，供 wiki_compiler 类 agent）、knowledge（带领域提示的搜索）。
 * 自 bridge/knowledge/knowledge.tools.ts 迁入，底层由 kbs MCP 客户端改为内部直连。
 */
@Injectable()
export class KnowledgeToolProvider implements ToolProvider {
  readonly toolIds = ['kb_mcp', 'knowledge'];

  constructor(
    private readonly knowledgeTools: KnowledgeToolsService,
    private readonly kbAccess: KbAccessService,
    private readonly skillRegistry: SkillRegistryService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'kb_mcp', label: '企业心智MCP(原始)', group: '知识' },
      { id: 'knowledge', label: '知识库搜索', group: '知识' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const tools: ToolInstance[] = [];
    const Type = ctx.piAi?.Type;

    // kb_mcp: raw knowledge tools for wiki_compiler
    // T2/P3：APP agent 经 ctx.appId 注入 APP 身份（自有 APP 空间可写；企业/个人空间只读）
    try {
      const rawTools = await this.knowledgeTools.getRawMcpTools(
        ctx.appId ? { appId: ctx.appId, userId: ctx.userId, userEmail: ctx.userEmail } : undefined,
      );
      tools.push(...rawTools.map((rt: any) => ({
        name: rt.name, label: rt.description, description: rt.description, parameters: rt.parameters,
        execute: async (toolCallId: string, args: any) => {
          const result = await rt.execute(toolCallId, args);
          const texts = (result.content || []).map((c: any) => ({ type: 'text' as const, text: c.text || '' }));
          return { content: texts.length ? texts : [{ type: 'text' as const, text: JSON.stringify(result) }], details: null };
        },
      })));
    } catch {}

    // knowledge: search tools with skill domain hints
    try {
      const kbTools = await this.knowledgeTools.getKnowledgeTools();
      const domains = this.skillRegistry.getKnowledgeDomains();
      const domainHint = domains.length > 0 ? `\n\n相关知识领域（优先搜索）: ${domains.join(', ')}` : '';

      if (Type) {
        // P1-15: 主动知识沉淀 — Agent 只建议，不自动写入；前端渲染确认卡片，用户决定是否保存
        tools.push({
          name: 'suggest_kb_save',
          label: '建议保存到知识库',
          description: '建议用户将对话中的有价值内容保存到知识库。不会自动保存，仅生成建议卡片供用户确认。当用户确认了重要业务规则/决策、通过多次工具调用获得有价值的数据洞察、解决了值得记录的复杂问题，或分享了知识库中尚未记录的领域知识时使用。',
          parameters: Type.Object({
            title: Type.String({ description: '建议的文档标题' }),
            content: Type.String({ description: '建议保存的内容（Markdown 格式）' }),
            category: Type.Optional(Type.String({ description: '建议的分类' })),
            tags: Type.Optional(Type.Array(Type.String(), { description: '建议的标签' })),
          }),
          execute: async (_toolCallId: string, args: any) => ({
            content: [{ type: 'text' as const, text: `已生成知识保存建议：${args.title}（等待用户确认）` }],
            details: { __action: true, actionType: 'suggest_kb_save', actionData: { title: args.title, content: args.content, category: args.category || '', tags: args.tags || [] } },
          }),
        });

        // Resolve category scopes once per tool creation so every KB search
        // carries the same trusted ACL snapshot.
        const scopes = ctx.userId
          ? await this.kbAccess.getAccessibleScopesForUser(ctx.userId)
          : [];
        const toolCtx = { userEmail: ctx.userEmail, userId: ctx.userId, scopes };

        tools.push(...kbTools.map((kt: any) => ({
          name: kt.name, label: kt.description, description: kt.description + domainHint,
          parameters: Type.Object({
            query: Type.Optional(Type.String()), topic: Type.Optional(Type.String()),
            scope: Type.Optional(Type.String()), content: Type.Optional(Type.String()),
            type: Type.Optional(Type.String()), category: Type.Optional(Type.String()),
            layer: Type.Optional(Type.String()),
          }),
          execute: async (toolCallId: string, args: any) => {
            const result = await kt.execute(toolCallId, args, toolCtx);
            const texts = (result.content || []).map((c: any) => ({ type: 'text' as const, text: c.text || '' }));
            return { content: texts.length ? texts : [{ type: 'text' as const, text: JSON.stringify(result) }], details: null };
          },
        })));
      }
    } catch {}

    return tools;
  }
}
