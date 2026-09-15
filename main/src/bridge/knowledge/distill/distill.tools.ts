import { Injectable } from '@nestjs/common';
import { DistillService } from './distill.service';
import { DistillValidationService } from './distill-validation.service';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../../agent/tool-bridge/tool-provider.interface';

/**
 * DistillToolProvider — 把知识蒸馏内核暴露为"尤达大师"的 agent 工具。
 * 单一 toolId 'distill'，createTools 产出 distill_scope/plan/expand/status。
 *
 * agent 负责"扩哪、收缩到哪、何时停"的智能决策；工具承担单节点重活并落盘。
 */
@Injectable()
export class DistillToolProvider implements ToolProvider {
  readonly toolIds = ['distill'];

  constructor(
    private readonly distill: DistillService,
    private readonly validation: DistillValidationService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [{ id: 'distill', label: '知识蒸馏（尤达大师）', group: '知识' }];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];
    const userId = ctx.userId || 'anonymous';
    const ok = (text: string, details: any = null): any => ({ content: [{ type: 'text' as const, text }], details });
    const err = (e: any): any => {
      const msg = typeof e === 'string' ? e : (e?.message || String(e));
      // 瞬时错误（限流/空响应/超时/5xx）标记为可重试 → 防循环守卫更宽容(放宽到5次)、且语义清晰
      const retryable = e?.retryable === true || /429|RATE_LIMIT|返回空|未返回有效内容|超时|timeout|调用失败:\s*5/i.test(msg);
      return {
        content: [{ type: 'text' as const, text: `蒸馏出错：${msg}` }],
        details: retryable ? { __error: { code: e?.code || 'RATE_LIMIT', message: msg, retryable: true } } : null,
      };
    };

    return [
      {
        name: 'distill_scope',
        label: '提议蒸馏范围与颗粒度',
        description: '在引导用户阶段调用：根据用户的模糊诉求与已知事实，提议凝练后的主题、关注范围、待澄清问题、建议的颗粒度（每轮问题数 N、递归轮数 d）与结果分层。用于和用户确认，不建任务。',
        parameters: Type.Object({
          draft: Type.String({ description: '用户的原始诉求，如"我要蒸一套 MOM 软件销售的知识库"' }),
          seedFacts: Type.Optional(Type.String({ description: '用户已知的事实/现状/痛点（可选）' })),
        }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.distill.proposeScope({ draft: args.draft, seedFacts: args.seedFacts });
            return ok(
              JSON.stringify(r, null, 2) +
              '\n\n⛔ 下一步：把上面方案用尤达口吻讲给用户，问清「颗粒度 N/d」和待澄清问题，然后【本轮到此为止，停下等用户真实回复】。' +
              '严禁在本轮自行替用户拍板、严禁现在调用 distill_plan 或任何其它工具——必须等用户回复后的下一轮再建任务。',
              { __distill: 'scope', proposal: r, __awaitUser: true },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_plan',
        label: '建立蒸馏任务并生成第一轮问题',
        description: '用户确认范围与颗粒度后调用：建立蒸馏任务(run)，生成第 1 轮的 N 个铺面问题。返回 runId 与首轮问题节点清单，供后续逐个 distill_expand。',
        parameters: Type.Object({
          topic: Type.String({ description: '凝练后的专项主题' }),
          scope: Type.Optional(Type.String({ description: '关注范围约束' })),
          seedFacts: Type.Optional(Type.String({ description: '用户提供的事实/现状' })),
          breadthN: Type.Optional(Type.Number({ description: '每轮每节点问题数 N（用户设定，默认8，上限50）' })),
          maxRounds: Type.Optional(Type.Number({ description: '递归轮数 d（用户设定，默认3，上限6）' })),
          resultTaxonomy: Type.Optional(Type.Array(Type.String(), { description: '结果分层，如 ["原理","领域","现状","实操"]' })),
          groundingMode: Type.Optional(Type.String({ description: 'hybrid | parametric | rag_only' })),
          force: Type.Optional(Type.Boolean({ description: '仅当确需新建一棵【全新主题】专项时传 true，跳过同主题去重。默认不传——同主题应深化既有专项，不另起炉灶。' })),
        }),
        execute: async (_id: string, args: any) => {
          try {
            // 去重硬闸：本用户已有未收尾的同主题专项 → 拒绝新建，引导深化既有树（除非显式 force）
            if (!args.force) {
              const dup = await this.distill.findSimilarActiveRun(userId, args.topic || '');
              if (dup) {
                return ok(
                  `⛔ 已存在同主题专项「${dup.topic}」（runId=${dup.runId}，待展开 ${dup.pending} 个），不要另起炉灶。\n` +
                  `请直接深化既有专项：\n` +
                  `· 继续深抽 → distill_run_background("${dup.runId}")（默认深度优先，把树抽到资产级）\n` +
                  `· 补根问题 → distill_extend("${dup.runId}", ...)\n` +
                  `· 看进度 → distill_status("${dup.runId}")\n` +
                  `只有切换到【全新主题】才另建（确需新建请带 force=true）。`,
                  { __distill: 'plan_dedup', existingRunId: dup.runId, pending: dup.pending },
                );
              }
            }
            const r = await this.distill.createRun({ ...args, createdBy: userId });
            return ok(
              `已建立蒸馏任务 ${r.runId}，落地于 ${r.categoryRoot}。\n第 1 轮 ${r.round1.length} 个问题：\n` +
              r.round1.map((q, i) => `${i + 1}. [${q.nodeId}] ${q.question}`).join('\n') +
              `\n\n接下来逐个调用 distill_expand(nodeId) 展开。`,
              { __distill: 'plan', runId: r.runId, categoryRoot: r.categoryRoot, round1: r.round1 },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_expand',
        label: '展开一个问题节点（接地+答题+落盘+出子问题）',
        description: '展开单个问题节点：接地后用模型答题、判定结果层与产物类型、写入专项库（候选态），并生成下一轮更聚焦的子问题。返回精简摘要（不回传全文）。由你决定接着展开哪个节点、何时剪枝/收敛。',
        parameters: Type.Object({
          nodeId: Type.String({ description: '要展开的问题节点 id（来自 distill_plan/expand 返回或 distill_status 的 frontier）' }),
        }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.distill.expandNode(args.nodeId);
            if (r.skipped) return ok(`跳过：${r.reason}`, { __distill: 'expand', ...r });
            if (r.budgetExhausted) return ok(`已达节点预算上限（${r.totalNodes}）。若还要深抽 → distill_set_budget(${args.runId}, 更大值) 扩容后 distill_run_background 续跑；若已够 → distill_finalize 收尾。`, { __distill: 'budget', ...r });
            return ok(
              `已展开「${r.question}」→ ${r.resultLayer}层/${r.artifactType}（置信 ${r.confidence}）\n落盘：${r.docPath}\n` +
              (r.childCount ? `新增 ${r.childCount} 个子问题：\n${r.children.map((c: any, i: number) => `${i + 1}. [${c.nodeId}] ${c.question}`).join('\n')}` : '（已到资产级/末轮，无子问题）') +
              (r.note ? `\n注意：${r.note}` : ''),
              { __distill: 'expand', ...r },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_expand_frontier',
        label: '小批手动展开（探查用，勿循环）',
        description: '同步展开当前 frontier 的一小批节点（默认6，上限12），仅用于"手动跑一小批看看效果"。⚠️ 同步阻塞，至多调一两次，【绝不要循环调用来铺量】——铺量请用 distill_run_background（后台异步、不阻塞）。',
        parameters: Type.Object({
          runId: Type.String({ description: '蒸馏任务 id' }),
          maxNodes: Type.Optional(Type.Number({ description: '本批最多展开节点数（默认6，上限12）' })),
          strategy: Type.Optional(Type.String({ description: "展开策略：'breadth' 铺当前层（默认）/ 'depth' 沿最深分支下钻" })),
        }),
        execute: async (_id: string, args: any) => {
          try {
            // 连发硬闸：至多手动跑两批，第 3 批起拒绝并逼用后台异步（杜绝同步循环铺量→撑爆/卡死/误超时）
            const streak = this.distill.noteFrontierCall(args.runId);
            if (streak > 2) {
              return ok(
                `⛔ 已连续手动跑 ${streak - 1}+ 批 frontier——它同步阻塞、每批进对话历史，循环下去会撑大会话、变慢、且跑不完。\n` +
                `剩余一律用 distill_run_background("${args.runId}")：后台异步、深度优先、不进对话、不阻塞。本轮不要再调用本工具。`,
                { __distill: 'frontier_blocked', streak },
              );
            }
            const r = await this.distill.expandFrontier(args.runId, args.maxNodes || 6, args.strategy === 'depth' ? 'depth' : 'breadth');
            const head = `本批展开 ${r.expandedCount} 个（停止原因：${r.stopped}）。`;
            // 逐项报告不用裸"失败"二字（避免上层防循环守卫的子串误判）；个别节点接地不成记为"跳过"
            const body = r.expanded.map((e: any, i: number) => e.error
              ? `${i + 1}. [${e.nodeId}] ⚠️ 跳过（接地未成）：${e.error}`
              : `${i + 1}. ${e.question} → ${e.resultLayer}层/${e.artifactType}（置信 ${e.confidence}，子问题 ${e.childCount}）`).join('\n');
            const prog = r.progress;
            const remaining = prog.frontier.length;
            // 队列未空：硬引导改用后台异步，并明确不要再循环本工具
            const tail = prog.done
              ? `\n\n进度：节点 ${prog.totalNodes}/${prog.budgetMaxNodes}，✅ 队列已空，可 distill_finalize 收尾`
              : `\n\n进度：节点 ${prog.totalNodes}/${prog.budgetMaxNodes}，待展开 ${remaining}+。\n⚠️ 队列未空：请改用 distill_run_background(${args.runId}) 一次性后台抽完（不阻塞对话），**勿重复调用本工具铺量**。`;
            return ok(`${head}\n${body}${tail}`, { __distill: 'expand_frontier', ...r });
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_run_background',
        label: '后台展开整棵问题树（不阻塞对话）',
        description: '把整棵待办队列放【后台】逐节点跑到队列空/预算上限/被停止，立即返回，不阻塞当前对话。默认【深度优先】把分支抽到资产级（最终知识），这正是"递归深入"的关键。适合长树、深扇出——启动后告诉用户"在后台跑了，可继续聊"，之后用 distill_status 轮询进度，或 distill_stop 中止。',
        parameters: Type.Object({
          runId: Type.String({ description: '蒸馏任务 id' }),
          concurrency: Type.Optional(Type.Number({ description: '后台并发展开数（默认2，上限4）' })),
          strategy: Type.Optional(Type.String({ description: "展开策略：'depth' 深度优先（默认，下钻到资产级）/ 'breadth' 广度优先（逐层铺平）" })),
        }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.distill.startBackground(args.runId, { concurrency: args.concurrency, strategy: args.strategy === 'breadth' ? 'breadth' : 'depth' });
            if (r.alreadyRunning) return ok(`后台展开已在进行（已处理 ${r.processed} 个）。可用 distill_status 看进度。`, { __distill: 'bg_start', ...r });
            if (!r.started) return ok(`未启动：${r.reason === 'frontier_empty' ? '待办队列已空，可直接 distill_finalize 收尾' : r.reason}`, { __distill: 'bg_start', ...r });
            return ok(
              `已在后台启动展开（待办 ${r.pending}，并发 ${r.concurrency}）。对话不被阻塞——可继续聊；用 distill_status(${args.runId}) 看进度，distill_stop 可中止。`,
              { __distill: 'bg_start', ...r },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_set_budget',
        label: '调高节点上限（预算耗尽后扩容续抽）',
        description: '调高某专项的节点上限 maxNodes（只升不降、封顶 100 万）。当 distill_status/expand 报"预算耗尽(budget_exhausted)"、而你还需继续深抽时调用它扩容，然后 distill_run_background 续跑——不要因此新建专项。',
        parameters: Type.Object({
          runId: Type.String({ description: '蒸馏任务 id' }),
          maxNodes: Type.Number({ description: '新的节点上限（应 ≥ 当前总数，建议按 N^d 量级给足；封顶 1,000,000）' }),
        }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.distill.setBudget(args.runId, args.maxNodes);
            return ok(
              r.maxNodes > r.previous
                ? `节点上限已调高：${r.previous} → ${r.maxNodes}。现在可 distill_run_background(${args.runId}) 续抽。`
                : `节点上限维持 ${r.maxNodes}（只升不降；传入值未超过当前上限）。`,
              { __distill: 'set_budget', ...r },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_curate',
        label: 'LLM 整理精炼（逐篇精炼+按层合并）',
        description: '对一个专项做【整理精炼】：① 逐篇精炼已蒸候选（清晰/准确/一致，版本+1回候选态重验）；② 按结果层去重合并成"主文档"。后台异步执行、不阻塞对话，进度经 distill_status 的 curate 字段查看。蒸完一轮想把库整理干净时调用；可多轮迭代。',
        parameters: Type.Object({
          runId: Type.String({ description: '蒸馏任务 id' }),
          polish: Type.Optional(Type.Boolean({ description: '是否逐篇精炼（默认 true）' })),
          merge: Type.Optional(Type.Boolean({ description: '是否按层合并成主文档（默认 true）' })),
        }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.distill.startCurate(args.runId, { polish: args.polish, merge: args.merge });
            if (r.alreadyRunning) return ok(`整理精炼已在进行（阶段 ${r.phase}，已精炼 ${r.polished}）。用 distill_status 看进度。`, { __distill: 'curate', ...r });
            if (!r.started) return ok(
              r.reason === 'nothing_to_curate' ? '没有可整理的候选（可能都已生效或下架）。'
              : r.reason === 'background_expanding' ? '后台展开还在进行，等抽完再整理精炼。'
              : `未启动：${r.reason}`,
              { __distill: 'curate', ...r });
            return ok(`已在后台启动整理精炼（待精炼 ${r.total}）：先逐篇精炼，再按层合并主文档。不阻塞对话——用 distill_status(${args.runId}) 看进度。`, { __distill: 'curate', ...r });
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_stop',
        label: '停止后台展开',
        description: '请求停止某任务的后台展开（当前批跑完即停）。已展开的内容保留，未展开的留在待办队列，之后可再 distill_run_background 续跑或 distill_finalize 收尾。',
        parameters: Type.Object({ runId: Type.String({ description: '蒸馏任务 id' }) }),
        execute: async (_id: string, args: any) => {
          try {
            const r = this.distill.stopBackground(args.runId);
            return ok(r.running ? `已请求停止（已处理 ${r.processed} 个，当前批跑完即停）。` : '该任务当前没有后台展开在跑。', { __distill: 'bg_stop', ...r });
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_status',
        label: '查看蒸馏进度与待展开队列',
        description: '查看一个蒸馏任务的进度：各状态节点数、待展开的 frontier 队列、预算余量。用于决定下一步展开哪些节点或是否收敛。',
        parameters: Type.Object({
          runId: Type.String({ description: '蒸馏任务 id' }),
        }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.distill.status(args.runId);
            const bg = r.background?.running
              ? `\n🔄 后台展开中：已处理 ${r.background.processed}${r.background.failed ? `，跳过 ${r.background.failed}` : ''}，已跑 ${r.background.elapsedSec}s${r.background.lastError ? `（最近错误：${r.background.lastError}）` : ''}`
              : '';
            return ok(
              `任务 ${r.runId}（${r.topic}）N=${r.breadthN} d=${r.maxRounds}\n节点 ${r.totalNodes}/${r.budgetMaxNodes}，状态：${JSON.stringify(r.byStatus)}${bg}\n` +
              (r.done ? '✅ 无待展开节点。' : (() => {
                const head = r.frontier.slice(0, 5).map((f: any, i: number) => `${i + 1}. [${f.nodeId}] R${f.round} ${f.question}`).join('\n');
                const more = r.frontier.length > 5 ? `\n…其余 ${r.frontier.length - 5}+ 个（用 distill_run_background 后台抽，或继续 distill_expand_frontier）` : '';
                return `待展开 ${r.frontier.length} 个（仅列前 5）：\n${head}${more}`;
              })()),
              { __distill: 'status', ...r },
            );
          } catch (e: any) {
            // 任务不存在不是真失败：先让模型 distill_list 发现既有专项，别急着新建（不要凭空猜 runId）
            if (/不存在/.test(e?.message || '')) return ok('该 runId 不存在。⛔ 不要凭记忆猜 runId。请先调用 distill_list 查看你已有的专项清单，从中选既有 runId 继续深化；确无相关专项时才用 distill_plan 新建。', { __distill: 'status', notFound: true });
            return err(e);
          }
        },
      },
      {
        name: 'distill_list',
        label: '列出我的蒸馏专项（发现既有 runId）',
        description: '列出当前用户的全部蒸馏专项（含 runId、主题、状态、待展开数）。续聊或不确定 runId 时【先调用它】发现既有专项，再 distill_status/distill_run_background 继续——不要凭记忆猜 runId、更不要直接新建同主题专项。',
        parameters: Type.Object({}),
        execute: async () => {
          try {
            const runs = await this.distill.listUserRuns(userId);
            if (!runs.length) return ok('你还没有任何蒸馏专项。可用 distill_scope 先与用户敲定范围与颗粒度，再 distill_plan 新建。', { __distill: 'list', runs: [] });
            const lines = runs.map(r => {
              const cont = (!r.finalized || r.pending > 0) ? '【可继续深化】' : '【已收尾】';
              return `· [${r.runId}] 「${r.topic}」 状态=${r.status}${r.finalized ? '/已收尾' : ''} · 待展开 ${r.pending}/${r.total} ${cont}`;
            }).join('\n');
            return ok(
              `你的蒸馏专项（共 ${runs.length}）：\n${lines}\n\n` +
              `⛔ 同主题请选上面的 runId 继续（distill_run_background 深抽 / distill_extend 补根问题），不要新建。`,
              { __distill: 'list', runs },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_extend',
        label: '增量蒸馏：向已有任务追加问题',
        description: '不重建任务，向已有蒸馏任务追加新的根问题（第1轮），用于补充遗漏维度或扩展范围。已收尾的任务会重新转为进行中。新问题受跨节点去重约束。追加后照常 distill_expand/expand_frontier 展开。',
        parameters: Type.Object({
          runId: Type.String({ description: '蒸馏任务 id' }),
          questions: Type.Array(Type.String(), { description: '要追加的根问题列表' }),
        }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.distill.extendRun(args.runId, args.questions || []);
            return ok(
              `已追加 ${r.added} 个新问题（去重跳过 ${r.duplicatesSkipped} 个）。\n` +
              r.nodes.map((n: any, i: number) => `${i + 1}. [${n.nodeId}] ${n.question}`).join('\n') +
              `\n\n继续 distill_expand_frontier(${args.runId}) 展开。`,
              { __distill: 'extend', ...r },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_fix_queue',
        label: '查看待优化队列',
        description: '列出某蒸馏任务里因实战评分低分/安全红线/初筛低置信而进入"待优化(needs_fix)"的内容，含低分维度与样本数。用于决定回流重写哪些节点。',
        parameters: Type.Object({ runId: Type.String({ description: '蒸馏任务 id' }) }),
        execute: async (_id: string, args: any) => {
          try {
            const q = await this.validation.fixQueue(args.runId);
            if (!q.length) return ok('待优化队列为空。');
            return ok(
              `待优化 ${q.length} 项：\n` + q.map((n: any, i: number) =>
                `${i + 1}. [${n.nodeId}] ${n.title || n.question}　${n.resultLayer}层　均分 ${n.aggScore ?? '—'}（样本${n.ratingCount}）${n.hasSafetyFlag ? ' ⚠️安全红线' : ''}`).join('\n') +
              `\n\n对其调用 distill_refine(nodeId) 按反馈重写。`,
              { __distill: 'fix_queue', queue: q },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_refine',
        label: '回流重写一个待优化节点',
        description: '对一个 needs_fix 节点，汇总其实战评分的低分维度+评语+标注错误，按反馈重写内容；版本+1，回到候选态重新接受验证。',
        parameters: Type.Object({ nodeId: Type.String({ description: '要重写的节点 id（来自 distill_fix_queue）' }) }),
        execute: async (_id: string, args: any) => {
          try {
            const r = await this.validation.refine(args.nodeId);
            return ok(
              `已按反馈重写「${r.title}」→ v${r.version}（置信 ${r.confidence}），回到候选态待重新验证。\n依据：\n${r.basedOn}`,
              { __distill: 'refine', ...r },
            );
          } catch (e: any) { return err(e); }
        },
      },
      {
        name: 'distill_finalize',
        label: '收尾：生成专项库总览与工具索引',
        description: '蒸馏告一段落后调用：按结果层汇总所有候选内容，生成专项库总览(overview)、工具索引、低置信清单与 CoWorker 绑定路径建议。注意：候选内容仍在蒸馏库，不会进入企业心智正式检索——需经实战评分验证（后续波次）通过后才发布生效。',
        parameters: Type.Object({
          runId: Type.String({ description: '蒸馏任务 id' }),
          force: Type.Optional(Type.Boolean({ description: '队列仍有大量待展开时仍强制收尾（默认 false，会先提示先抽干）' })),
        }),
        execute: async (_id: string, args: any) => {
          try {
            // 收尾守卫：还有大量 pending（深度未抽干）时，先提示去后台深抽，避免"铺完宽度就收尾"
            const st = await this.distill.status(args.runId).catch(() => null);
            const pending = st?.byStatus?.pending || 0;
            if (!args.force && pending > 10) {
              return ok(
                `⚠️ 暂不收尾：还有 ${pending} 个节点待展开（深度尚未抽干，过早收尾会丢失"递归深入"的最终知识）。\n` +
                `建议先 distill_run_background(${args.runId})（默认深度优先，把分支抽到资产级），跑完再 distill_finalize。\n` +
                `若确需现在收尾，调用 distill_finalize(runId, force=true)。`,
                { __distill: 'finalize_guard', pending },
              );
            }
            const r = await this.distill.finalize(args.runId);
            return ok(
              `${r.partial ? '蒸馏【部分收尾】' : '蒸馏收尾'}：「${r.topic}」共 ${r.candidateCount} 篇候选。\n` +
              `各结果层：${JSON.stringify(r.byLayer)}　工具 ${r.toolCount} 个　低置信 ${r.lowConfidenceCount} 篇\n` +
              (r.partial ? `🔸 仍有 ${r.pending} 个节点未展开——本专项保持"可继续深化"，可 distill_run_background(${args.runId}) 续抽后再正式收尾。\n` : '') +
              `意向落地路径（生效后）：${r.categoryRoot}\n` +
              `⚠️ ${r.note}`,
              { __distill: 'finalize', ...r },
            );
          } catch (e: any) { return err(e); }
        },
      },
    ];
  }
}
