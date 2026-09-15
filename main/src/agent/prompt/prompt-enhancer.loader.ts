import { Injectable, Logger, Optional } from '@nestjs/common';
import { PromptEnhancerService } from './prompt-enhancer.service';
import { DistillService } from '../../bridge/knowledge/distill/distill.service';

export interface PromptEnhancerSpec {
  /** Builtin method name on PromptEnhancerService, or a future module path for L3 */
  builtin?: string;
  /** Future: external module path (L3 only) */
  module?: string;
  method?: string;
}

export interface EnhancerContext {
  userId: string;
  filePath?: string;
  /** Extra data injected per-agent (e.g. active distill runs) */
  extra?: any;
}

/**
 * Loads and invokes prompt enhancers declared in agent YAML.
 * L2: routes to builtin PromptEnhancerService methods by name.
 * L3: will support dynamic module loading from extension packages.
 */
@Injectable()
export class PromptEnhancerLoaderService {
  private readonly logger = new Logger(PromptEnhancerLoaderService.name);

  constructor(
    private readonly enhancer: PromptEnhancerService,
    @Optional() private readonly distill?: DistillService,
  ) {}

  async enhance(
    basePrompt: string,
    spec: PromptEnhancerSpec,
    ctx: EnhancerContext,
  ): Promise<string> {
    try {
      if (spec.builtin === 'enhanceForDrawing') {
        return await this.enhancer.enhancePromptForDrawingAgent(basePrompt, ctx.userId);
      }

      if (spec.builtin === 'injectActiveDistillRuns') {
        if (!this.distill) return basePrompt;
        const actives = await this.distill.listActiveRuns(ctx.userId);
        if (actives.length === 0) return basePrompt;
        return (
          basePrompt +
          `\n\n## 你可继续深化的专项\n` +
          actives
            .map(
              (a: any) =>
                `  - runId=${a.runId} · 「${a.topic}」· 待展开 ${a.pending}/${a.total}${a.finalized ? ' · (已收尾但仍有 pending，可续抽)' : ''}`,
            )
            .join('\n') +
          `\n> ⛔ 用户说"继续蒸/补深/接着挖/继续 pending"时，**深化上面已有的专项**（distill_run_background(runId) 深抽 / distill_extend 补根问题），**绝不要 distill_plan 新建同主题专项、更不要凭记忆猜 runId**。不确定就先 distill_list。只有全新主题才新建。`
        );
      }

      this.logger.warn(`Unknown promptEnhancer builtin: ${spec.builtin}`);
      return basePrompt;
    } catch (err: any) {
      this.logger.warn(`PromptEnhancer [${spec.builtin}] failed, using base prompt: ${err.message}`);
      return basePrompt;
    }
  }
}
