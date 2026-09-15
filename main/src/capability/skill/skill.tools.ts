import { Injectable } from '@nestjs/common';
import { SkillRegistryService } from './skill-registry.service';
import { SkillExecutorService } from './skill-executor.service';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { McpRegistryService } from '../mcp/mcp-registry.service';
import { AgentPoolService } from '../../agent/core/agent-pool.service';
import { SessionService } from '../../agent/session/session.service';
import { ConfirmationBridgeService } from '../../agent/support/confirmation-bridge.service';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { structuredFromSkillResult, formatToolError } from '../../agent/tool-bridge/tool-error';

/**
 * SkillToolProvider — Agent Skills (HAR-based), skill testing, reloading, workshop, taskflow.
 */
@Injectable()
export class SkillToolProvider implements ToolProvider {
  readonly toolIds = ['skills', 'test_skill', 'reload_skills', 'skill_workshop', 'taskflow'];

  constructor(
    private readonly skillRegistry: SkillRegistryService,
    private readonly skillExecutor: SkillExecutorService,
    private readonly toolRegistry: ToolRegistryService,
    private readonly mcpRegistry: McpRegistryService,
    private readonly agentPool: AgentPoolService,
    private readonly sessionService: SessionService,
    private readonly confirmBridge: ConfirmationBridgeService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'skills', label: 'Agent Skills', group: '技能' },
      { id: 'test_skill', label: '测试技能', group: '技能' },
      { id: 'reload_skills', label: '重新加载连接', group: '连接' },
      { id: 'skill_workshop', label: '技能录制', group: '技能' },
      { id: 'taskflow', label: '任务流编排', group: '自动化' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const tools: ToolInstance[] = [];

    // skills — all registered skills with confirm forms
    const skipConfirm = ctx.agentKey === '__skill__';
    tools.push(...this.skillRegistry.getAll().map(skill => {
      const paramProps: Record<string, any> = {};
      if (skill.confirmForm?.length) {
        for (const f of skill.confirmForm) {
          const baseType = f.type === 'number' ? Type.Number() : f.type === 'boolean' ? Type.Boolean() : f.type === 'table' ? Type.Any() : Type.String();
          paramProps[f.key] = f.required ? baseType : Type.Optional(baseType);
        }
      } else {
        paramProps.input = Type.String({ description: '传入技能的数据（JSON或文本）' });
      }

      return {
        name: `skill_${skill.name}`, label: skill.description,
        description: skill.description
          + (skill.confirmForm?.length ? '\n此技能有参数确认表单，调用时会弹出表单供用户核对。请直接传入已知参数，缺失的留空。'
            + skill.confirmForm.filter(f => f.type === 'table' && f.columns?.length).map(f =>
              `\n参数 ${f.key} 是数组，格式: [${f.columns!.map(c => `{${c.key}:"..."}`).join(', ')}]`
            ).join('') : '')
          + (skill.allowedTools?.length ? `\n可调用工具: ${skill.allowedTools.join(', ')}` : ''),
        parameters: Type.Object(paramProps) as any,
        execute: async (_id: string, args: Record<string, any>) => {
          if (skill.confirmForm?.length) {
            for (const f of skill.confirmForm) {
              if (f.type === 'table' && typeof args[f.key] === 'string') {
                try { args[f.key] = JSON.parse(args[f.key]); } catch {}
              }
            }
          }
          // Skip confirmation if metadata.skipConfirmation is set
          const shouldSkipConfirm = skipConfirm || skill.metadata?.skipConfirmation === 'true';
          if (skill.confirmForm?.length && !shouldSkipConfirm) {
            try {
              const editedArgs = await this.confirmBridge.requestConfirmation({
                confirmId: `skill_${skill.name}_${Date.now()}`,
                toolName: `skill_${skill.name}`,
                args,
                parameters: skill.confirmForm.map(f => ({ name: f.key, type: f.type || 'string', required: f.required, description: f.label })),
                confirmForm: skill.confirmForm,
                description: skill.description,
              });
              args = editedArgs;
            } catch (err: any) {
              const cancelled = err.message === 'user_cancelled';
              return { content: [{ type: 'text' as const, text: cancelled ? '用户取消了此操作' : '参数确认超时，操作已取消' }], details: { __confirmCancelled: true, __userCancelled: cancelled } };
            }
          }
          const result = await this.skillExecutor.execute(skill.name, args, ctx.userId);
          // Reuse shouldSkipConfirm from line 76
          if (!result.success && skill.confirmForm?.length && !shouldSkipConfirm) {
            // 体面降级（2026-09-09 修复）：此前带确认表单的技能失败一律 __abort 硬中止，
            // 会话直接死亡、用户只看到原始异常文本（如 java.text.ParseException）。
            // 改为结构化错误交回 LLM：由 LLM 向用户解释失败、可自愈参数（如日期格式）
            // 或引导重新确认；防死循环由 evalToolRepeatGuard（同参连续失败才中止）兜底。
            const structured = structuredFromSkillResult(result, `skill_${skill.name}`);
            const specialFields: any = {};
            if (result) {
              for (const key of Object.keys(result)) {
                if (key.startsWith('_') && key !== '__') {
                  specialFields[key] = (result as any)[key];
                }
              }
            }
            return {
              content: [{
                type: 'text' as const,
                text: `${formatToolError(structured)}\n\n`
                  + `(用户已在确认表单中核对过本次参数。请向用户如实说明失败原因；`
                  + `若能从错误判断参数问题（如日期/数字格式），可说明修正方案后重试一次，`
                  + `或询问用户如何处理，不要静默重复相同参数。)`,
              }],
              details: { __error: structured, skillName: skill.name, result, confirmedArgs: true },
              ...specialFields
            };
          }
          // P0-5: non-exception failure ({ success:false }) — attach structured error so the
          // Agent loop / 效能看板 see the same __error shape as thrown errors.
          if (!result.success) {
            const structured = structuredFromSkillResult(result, `skill_${skill.name}`);
            // 提取特殊字段
            const specialFields: any = {};
            if (result) {
              for (const key of Object.keys(result)) {
                if (key.startsWith('_') && key !== '__') {
                  specialFields[key] = (result as any)[key];
                }
              }
            }
            return {
              content: [{ type: 'text' as const, text: formatToolError(structured) }],
              details: { __error: structured, skillName: skill.name, result },
              ...specialFields
            };
          }
          const instructions = this.skillRegistry.getInstructions(skill.name) || '';
          const instructionHint = instructions ? `\n\n---\n**技能指令**:\n${instructions.substring(0, 3000)}\n---` : '';

          // 提取特殊字段（_continuation, _panel_output 等）并展开到顶层
          const specialFields: any = {};
          if (result) {
            for (const key of Object.keys(result)) {
              if (key.startsWith('_') && key !== '__') {
                specialFields[key] = (result as any)[key];
              }
            }
          }


          return {
            content: [{ type: 'text' as const, text: result.message + (result.data ? '\n' + JSON.stringify(result.data) : '') + instructionHint }],
            details: { skillName: skill.name, result, ...(result.details || {}) },
            ...specialFields  // 展开 _continuation, _panel_output 等字段到顶层
          };
        },
      };
    }));

    // test_skill
    tools.push({
      name: 'test_skill', label: '测试技能',
      description: '测试一个已保存的Skill。',
      parameters: Type.Object({ skillName: Type.String(), testParams: Type.Optional(Type.Record(Type.String(), Type.Any())) }),
      execute: async (_id: string, args: any) => {
        try {
          const result = await this.skillExecutor.execute(args.skillName, args.testParams || {});
          // 提取特殊字段
          const specialFields: any = {};
          if (result) {
            for (const key of Object.keys(result)) {
              if (key.startsWith('_') && key !== '__') {
                specialFields[key] = (result as any)[key];
              }
            }
          }
          return {
            content: [{ type: 'text' as const, text: `测试结果: ${result.success ? '成功' : '失败'}\n${result.message}` }],
            details: result,
            ...specialFields
          };
        } catch (err: any) { return { content: [{ type: 'text' as const, text: `测试异常: ${err.message}` }], details: null }; }
      },
    });

    // reload_skills
    tools.push({
      name: 'reload_skills', label: '重新加载连接',
      description: '重新从磁盘加载所有连接定义（包括 MCP Server、Tool、Skill）。注册或修改 MCP/Tool/Skill 后需调用此工具使其生效。',
      parameters: Type.Object({}),
      execute: async () => {
        const oldNames = new Set([...this.skillRegistry.getAll().map(s => s.name), ...this.toolRegistry.getAll().map(t => t.name), ...this.mcpRegistry.getAll().map(m => m.name)]);
        this.skillRegistry.loadAll(); this.toolRegistry.loadAll(); this.mcpRegistry.loadAll();
        const allNew = [...this.skillRegistry.getAll().filter(s => !oldNames.has(s.name)).map(s => s.name), ...this.toolRegistry.getAll().filter(t => !oldNames.has(t.name)).map(t => t.name), ...this.mcpRegistry.getAll().filter(m => !oldNames.has(m.name)).map(m => m.name)];
        if (allNew.length > 0) {
          for (const key of this.agentPool.keys()) {
            if (key.startsWith('connector_master_') || key.startsWith('skill_master_')) {
              const sid = this.agentPool.getSessionId(key);
              if (sid) for (const name of allNew) await this.sessionService.bindSkill(sid, name).catch(() => {});
              break;
            }
          }
        }
        this.agentPool.clear();
        const total = this.skillRegistry.getAll().length + this.toolRegistry.getAll().length + this.mcpRegistry.getAll().length;
        return { content: [{ type: 'text' as const, text: `已重新加载 ${total} 个连接${allNew.length ? '，新增: ' + allNew.join(', ') : ''}。所有智能体工具已刷新。` }], details: null };
      },
    });

    // skill_workshop
    tools.push({
      name: 'skill_workshop', label: '技能录制',
      description: '录制当前操作流程并保存为可复用的技能。',
      parameters: Type.Object({
        action: Type.String({ description: 'start(开始录制)|stop(结束并保存)|status(查看录制状态)' }),
        skillName: Type.Optional(Type.String({ description: '技能名称（stop时必填）' })),
      }),
      execute: async (_id: string, args: { action: string; skillName?: string }) => {
        if (args.action === 'start') return { content: [{ type: 'text' as const, text: '技能录制已开始。请执行你想要录制的操作步骤，完成后使用 stop 结束录制。' }], details: { recording: true } };
        if (args.action === 'stop') return { content: [{ type: 'text' as const, text: `技能录制已结束，已保存为: ${args.skillName || 'unnamed_skill'}` }], details: { recording: false, skillName: args.skillName } };
        return { content: [{ type: 'text' as const, text: '录制状态查询' }], details: null };
      },
    });

    // taskflow
    tools.push({
      name: 'taskflow', label: '任务流编排',
      description: `创建和执行多步骤任务流。每个步骤可以是：工具调用、条件判断、等待审批。`,
      parameters: Type.Object({
        action: Type.String({ description: 'create(创建任务流)|status(查看状态)|execute(执行下一步)' }),
        name: Type.Optional(Type.String({ description: '任务流名称' })),
        steps: Type.Optional(Type.String({ description: '步骤描述（JSON数组）' })),
      }),
      execute: async (_id: string, args: { action: string; name?: string; steps?: string }) => {
        if (args.action === 'create') {
          return { content: [{ type: 'text' as const, text: `## 任务流已创建: ${args.name || '未命名'}\n\n步骤: ${args.steps || '[]'}\n\n请按顺序执行各步骤，每步完成后报告进度。` }], details: { name: args.name, steps: args.steps } };
        }
        return { content: [{ type: 'text' as const, text: `任务流操作: ${args.action}` }], details: null };
      },
    });

    return tools;
  }
}
