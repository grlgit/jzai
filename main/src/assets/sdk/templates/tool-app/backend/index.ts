/**
 * tool-app 后端入口 —— 展示平台工具复用的双通道。
 * 通道②（本文件）：manifest 声明 usesPlatformTools 后，经 ctx.tools.call 调用平台内置工具。
 * 通道①（agents/ta_assistant.yaml）：agent yaml 的 tools 列表直接引用平台工具名。
 */
import type {
  AppContext, AppModuleShape,
  ToolProvider, ToolCatalogEntry, ToolContext, ToolInstance,
} from '../types/backend';

// ── ToolProvider：注册给 agent 的自定义工具（示例：借平台 LLM 做摘要）──
class ReportToolProvider implements ToolProvider {
  readonly toolIds = ['ta_text_summary'];

  constructor(private readonly app: AppContext) {}

  getCatalog(): ToolCatalogEntry[] {
    return [{
      id: 'ta_text_summary',
      label: '文本摘要',
      group: '示例',
      description: '调用平台 LLM 对文本做三句话摘要',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: '待摘要文本' } },
        required: ['text'],
      },
    }];
  }

  async createTools(_ctx: ToolContext): Promise<ToolInstance[]> {
    return [{
      name: 'ta_text_summary',
      description: '调用平台 LLM 对文本做三句话摘要',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      execute: async (_id: string, args: { text: string }) => {
        const r = await this.app.llm.call({
          prompt: `请用三句话摘要以下文本：\n\n${args.text}`,
          level: 'summary',
        });
        return { summary: r.text };
      },
    }];
  }
}

// ── Controller：面板经 invoke 入口调用（通道②示例）──
class ReportController {
  constructor(private readonly app: AppContext) {}

  /** manifest 声明 handlers: ["ReportController.makePdf"] */
  async makePdf(body: { title?: string }) {
    this.app.logger.log(`makePdf: ${body?.title ?? '(untitled)'}`);
    // 调用平台内置 PDF 工具（必须在 manifest usesPlatformTools 中声明，否则运行期拒绝）
    const result = await this.app.tools.call('generate_pdf', {
      title: body?.title ?? '示例报告',
      content: '由 tool-app 模板经 ctx.tools.call 生成。',
    });
    return { ok: true, result };
  }
}

export class ToolAppModule {
  static forApp(ctx: AppContext): AppModuleShape {
    return {
      toolProviders: [new ReportToolProvider(ctx)],
      controllers: { ReportController: new ReportController(ctx) },
    };
  }
}

export default ToolAppModule;
