import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import { DbService } from '../../../db/db.service';
import { ModelRouterService } from '../../../model-router/model-router.service';
import { KbService } from '../kb.service';

/**
 * DistillService — 知识蒸馏（尤达大师）内核。
 *
 * 把潜藏在大模型里的知识，通过【问题树轮次扇出】递归抽出：
 *   R0 根 → R1 出 N 个问题 → R2 每个问题再各出 N 个更细子问题 → … 到第 d 轮
 * 每个问题节点接地后答题，落为专项库一篇文档（按结果层组织，candidate 态）。
 *
 * 设计要点（见 docs/design-knowledge-distillation.md）：
 * - agent 决定"扩哪、收缩到哪、何时停"；本服务承担单节点的"接地+生成+落盘"重活。
 * - 问题树状态持久化在 jz_distillation_nodes，agent 每轮只取 frontier → 上下文不爆仓。
 * - 内容默认 candidate，不直接生效（生效由 W3 实战评分门决定）。
 */
@Injectable()
export class DistillService {
  private readonly logger = new Logger(DistillService.name);
  private readonly DEFAULT_LAYERS = ['原理', '领域', '现状', '实操'];

  /** 实时进度事件总线（DistillGateway 监听并转发到 WebSocket）。 */
  readonly events = new EventEmitter();

  /**
   * 后台异步展开器注册表（内存态，单实例）。
   * 长问题树扇出会调很多次 LLM、耗时长——放后台跑，尤达对话不被阻塞，用户照常聊天，
   * 用 distill_status 轮询进度。进程重启会丢失内存态，但 pending 节点仍在 DB，可再次 distill_run_background 续跑。
   */
  private readonly bgRunners = new Map<string, {
    stop: boolean; startedAt: number; processed: number; failed: number; lastError?: string; stopped?: string;
  }>();

  /** LLM 整理精炼运行态（内存态，单实例）：两段式——逐篇精炼 + 按层合并去重成主文档。 */
  private readonly curateRunners = new Map<string, {
    stop: boolean; startedAt: number; phase: string; polished: number; merged: number; total: number; lastError?: string; done?: boolean;
  }>();

  constructor(
    private readonly db: DbService,
    private readonly modelRouter: ModelRouterService,
    private readonly kb: KbService,
  ) {}

  private genId(): string {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  }

  private dedupKey(q: string): string {
    return q.toLowerCase().replace(/[\s，。？?、,.]/g, '').slice(0, 80);
  }

  // ── 范围/颗粒度提议（供尤达引导用户确认）──────────────────────────

  async proposeScope(input: { draft: string; seedFacts?: string }): Promise<any> {
    const prompt = `你在帮一位"从业者"（懂行业事实但不具备体系化能力）规划一次"知识蒸馏"。
用户想蒸馏的主题/诉求：「${input.draft}」
${input.seedFacts ? `用户已知的事实/现状：「${input.seedFacts}」` : ''}

请提议一个蒸馏方案，输出 JSON（不要任何额外文字）：
{
  "topic": "凝练后的专项主题",
  "scope": "建议的关注范围（一句话，帮用户把模糊诉求收敛）",
  "clarifyingQuestions": ["还需向用户澄清的问题，2-4个"],
  "suggestedBreadth": 8,        // 每轮每节点问题数 N（建议值）
  "suggestedRounds": 3,         // 递归轮数 d（建议值）
  "resultTaxonomy": ["原理","领域","现状","实操"],  // 结果分层（可据主题调整）
  "groundingMode": "hybrid"     // hybrid | parametric | rag_only
}`;
    return this.parseJson(await this.callLLM(prompt, 1200, 0.4));
  }

  // ── 建 run + R1 问题表 ────────────────────────────────────────────

  async createRun(input: {
    topic: string; scope?: string; seedFacts?: string;
    breadthN?: number; maxRounds?: number; resultTaxonomy?: string[];
    groundingMode?: string; budget?: any; createdBy: string;
  }): Promise<{ runId: string; categoryRoot: string; round1: { nodeId: string; question: string }[] }> {
    const runId = this.genId();
    const breadthN = Math.max(1, Math.min(input.breadthN || 8, 50));
    const maxRounds = Math.max(1, Math.min(input.maxRounds || 3, 6));
    const taxonomy = input.resultTaxonomy?.length ? input.resultTaxonomy : this.DEFAULT_LAYERS;
    const categoryRoot = `/wiki/专项/${this.sanitize(input.topic)}/`;
    // 预算自适应：上限应匹配"宽 N、深 d 的树"的真实规模——节点数 = 几何级数 N¹+N²+…+N^d ≈ N^d。
    // 旧公式 N×d×10 严重低估（N=20,d=4 实际≈16.8万，旧公式只给 800 → 承诺 N/d 的树早早撞上限）。
    // 夹在 [300, 1,000,000]：下限保底，上限防 N^d 爆炸（靠深度优先+剪枝在其内控规模）。
    const treeMax = breadthN <= 1 ? maxRounds : Math.round(breadthN * (Math.pow(breadthN, maxRounds) - 1) / (breadthN - 1));
    const adaptiveMaxNodes = Math.max(300, Math.min(1_000_000, treeMax));
    const budget = { maxNodes: adaptiveMaxNodes, maxTokens: 2_000_000, ...(input.budget || {}) };

    await this.db.query(
      `INSERT INTO jz_distillation_runs
         (id, topic, scope_constraint, seed_facts, breadth_n, max_rounds, result_taxonomy, grounding_mode, budget, category_root, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [runId, input.topic, input.scope || null, input.seedFacts || null, breadthN, maxRounds,
       JSON.stringify(taxonomy), input.groundingMode || 'hybrid', JSON.stringify(budget), categoryRoot, input.createdBy],
    );

    // R1：生成 N 个铺面问题
    const questions = await this.generateQuestions({
      topic: input.topic, scope: input.scope, seedFacts: input.seedFacts,
      n: breadthN, round: 1, parentQuestion: null,
    });

    const round1: { nodeId: string; question: string }[] = [];
    for (const q of questions) {
      const nodeId = await this.insertNode(runId, null, 1, q);
      if (nodeId) round1.push({ nodeId, question: q });
    }
    this.logger.log(`Distill run ${runId} (${input.topic}): ${round1.length} R1 questions`);
    return { runId, categoryRoot, round1 };
  }

  // ── 展开单节点：接地 + 答题 + 生成子问题 + 落盘 ──────────────────

  async expandNode(nodeId: string): Promise<any> {
    const node = await this.getNode(nodeId);
    if (!node) throw new Error('节点不存在');
    if (node.status !== 'pending') return { skipped: true, reason: `节点状态为 ${node.status}` };

    const run = await this.getRun(node.run_id);
    if (!run) throw new Error('蒸馏任务不存在');

    // 预算护栏：防 N^d 爆炸
    const total = await this.countNodes(run.id);
    if (total > (run.budget?.maxNodes || 200)) {
      return { budgetExhausted: true, totalNodes: total };
    }

    // 接地（W1：RAG over 企业资料；web 接地由 agent 侧 web_fetch 工具补充）
    let grounding = '';
    if (run.grounding_mode !== 'parametric') {
      grounding = await this.ragGround(node.question).catch(() => '');
    }

    const taxonomy: string[] = run.result_taxonomy || this.DEFAULT_LAYERS;
    const isLastRound = node.round >= run.max_rounds;

    const prompt = `你是"尤达大师"知识蒸馏内核。当前在蒸馏专项主题「${run.topic}」${run.scope_constraint ? `（范围：${run.scope_constraint}）` : ''}。
正在回答问题树第 ${node.round} 轮的一个问题：
「${node.question}」
${grounding ? `\n可参考的企业已有资料（接地）：\n${grounding}\n` : ''}
${run.seed_facts ? `\n用户提供的事实/现状：${run.seed_facts}\n` : ''}

请完成两件事，输出 JSON（不要额外文字）：
{
  "answer": "对该问题的知识内容，用【清晰、专业、可直接用】的标准书面语（禁倒装腔，这是产物不是对话）。Markdown，可含表格/清单/模板。",
  "resultLayer": "该内容归到哪个结果层，从 ${JSON.stringify(taxonomy)} 选一个",
  "artifactType": "knowledge | skill | tool（话术/清单/表单/模板属 tool，方法打法属 skill，原理事实属 knowledge）",
  "confidence": 0.0,            // 0-1，对该内容准确性的自评（接地命中越多越高）
  "sources": ["若引用了资料/网址，列出；纯参数化生成则留空"],
  "structured": null,           // 仅当 artifactType="tool" 时填：把工具结构化为可程序化套用的对象，如 {"kind":"checklist","items":["..."]} / {"kind":"form","fields":[{"label":"产能","type":"text"}]} / {"kind":"scorecard","dimensions":[{"name":"预算匹配","max":5}]} / {"kind":"script","steps":["开场","价值钩子","约访"]}；非工具填 null
  ${isLastRound ? '"childQuestions": []' : `"childQuestions": ["对该问题【更细一层、更聚焦】的子问题，最多 ${run.breadth_n} 个；已是可直接操作的资产级则留空"]`}
}`;

    const result = this.parseJson(await this.callLLM(prompt, 4096, 0.3));
    if (!result?.answer) throw new Error('生成失败：LLM 未返回有效内容');

    const layer = taxonomy.includes(result.resultLayer) ? result.resultLayer : taxonomy[0];
    const artifactType = ['knowledge', 'skill', 'tool'].includes(result.artifactType) ? result.artifactType : 'knowledge';
    const confidence = typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.5;
    const sources: string[] = Array.isArray(result.sources) ? result.sources : [];

    // 落盘到【蒸馏库】（DB），不写入可检索金库——候选内容不得进入企业心智正式检索（W2 隔离）。
    // 真正发布到 /wiki/专项/ 由 W3 实战评分门通过后的"promotion"完成。
    const doc = this.buildDoc(run, node, { layer, artifactType, confidence, sources, body: result.answer });
    // 工具类产物：保存结构化规格供 CoWorker 程序化套用
    const structured = (artifactType === 'tool' && result.structured && typeof result.structured === 'object') ? result.structured : null;
    // 初筛：置信度过低直接 needs_fix（不进演练池）；其余进 candidate，由 W3 实战评分门决定是否生效
    const lifecycle = confidence < 0.5 ? 'needs_fix' : 'candidate';
    await this.db.query(
      `UPDATE jz_distillation_nodes
         SET status='expanded', lifecycle=$9, result_layer=$2, artifact_type=$3, confidence=$4, sources=$5, doc_path=$6, title=$7, content=$8, structured=$10
       WHERE id=$1`,
      [nodeId, layer, artifactType, confidence, JSON.stringify(sources), doc.docPath, doc.title, doc.content, lifecycle, structured ? JSON.stringify(structured) : null],
    );
    const docPath = doc.docPath;

    // 子问题落库（跨节点去重）
    const children: { nodeId: string; question: string }[] = [];
    const childQs: string[] = Array.isArray(result.childQuestions) ? result.childQuestions.slice(0, run.breadth_n) : [];
    for (const cq of childQs) {
      const childId = await this.insertNode(run.id, nodeId, node.round + 1, cq);
      if (childId) children.push({ nodeId: childId, question: cq });
    }

    // 实时推送：蒸出一条即广播（DistillGateway 转发到 run 房间，前端"蒸一条弹一条"）
    this.events.emit('progress', {
      runId: run.id, type: 'node',
      node: {
        nodeId, round: node.round, question: node.question, title: doc.title,
        resultLayer: layer, artifactType, confidence, lifecycle, version: 1,
        ratingCount: 0, hasSafetyFlag: false, structured: structured || null,
      },
      childCount: children.length,
    });

    return {
      nodeId, question: node.question, resultLayer: layer, artifactType, confidence,
      docPath, childCount: children.length, children,
      note: confidence < 0.5 ? '低置信，建议加强接地或人工复核' : undefined,
    };
  }

  // ── 状态：frontier + 进度 ─────────────────────────────────────────

  async status(runId: string): Promise<any> {
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    const { rows } = await this.db.query(
      `SELECT status, COUNT(*)::int AS n FROM jz_distillation_nodes WHERE run_id=$1 GROUP BY status`,
      [runId],
    );
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.n;

    // 各深度(轮次)节点数：D1/D2/… 层级统计
    const { rows: roundRows } = await this.db.query(
      `SELECT round, COUNT(*)::int AS n FROM jz_distillation_nodes WHERE run_id=$1 GROUP BY round ORDER BY round`,
      [runId],
    );
    const byRound = roundRows.map((r: any) => ({ round: r.round, n: r.n }));

    const { rows: frontier } = await this.db.query(
      `SELECT id, round, question FROM jz_distillation_nodes WHERE run_id=$1 AND status='pending' ORDER BY round, created_at LIMIT 20`,
      [runId],
    );
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    return {
      runId, topic: run.topic, categoryRoot: run.category_root,
      breadthN: run.breadth_n, maxRounds: run.max_rounds,
      totalNodes: total, byStatus, byRound,
      budgetMaxNodes: run.budget?.maxNodes || 200,
      frontier: frontier.map((f: any) => ({ nodeId: f.id, round: f.round, question: f.question })),
      done: (byStatus['pending'] || 0) === 0,
      background: this.backgroundState(runId),
      curate: this.curateState(runId),
    };
  }

  /**
   * 增量蒸馏：向已有任务追加新的根问题（round=1），无需重建。
   * 已 finalize 的任务会被重新置为 running。新问题受现有跨节点去重约束。
   */
  async extendRun(runId: string, questions: string[]): Promise<any> {
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    const added: { nodeId: string; question: string }[] = [];
    let dupes = 0;
    for (const q of (questions || []).filter(x => typeof x === 'string' && x.trim())) {
      const nodeId = await this.insertNode(runId, null, 1, q.trim());
      if (nodeId) added.push({ nodeId, question: q.trim() }); else dupes++;
    }
    if (added.length && run.status !== 'running') {
      await this.db.query(`UPDATE jz_distillation_runs SET status='running', updated_at=NOW() WHERE id=$1`, [runId]);
    }
    return { runId, added: added.length, duplicatesSkipped: dupes, nodes: added };
  }

  /** 返回整棵问题树（含 pending/pruned 等所有节点，带 parent_id 供前端建树）。 */
  async getTree(runId: string): Promise<any[]> {
    const { rows } = await this.db.query(
      `SELECT id, parent_id, round, question, title, result_layer, artifact_type, confidence, lifecycle, status
       FROM jz_distillation_nodes WHERE run_id=$1 ORDER BY round, created_at`,
      [runId],
    );
    return rows.map((r: any) => ({
      nodeId: r.id, parentId: r.parent_id, round: r.round, question: r.question, title: r.title,
      resultLayer: r.result_layer, artifactType: r.artifact_type, confidence: r.confidence,
      lifecycle: r.lifecycle, status: r.status,
    }));
  }

  /** 删除单个【未生效】节点（候选/验证中/待优化/已下架）。已生效(live)不可删，避免误删已进金库的内容。 */
  async deleteNode(nodeId: string): Promise<{ deleted: boolean; reason?: string }> {
    const { rows } = await this.db.query('SELECT lifecycle FROM jz_distillation_nodes WHERE id=$1', [nodeId]);
    if (!rows[0]) return { deleted: false, reason: '节点不存在' };
    if (rows[0].lifecycle === 'live') return { deleted: false, reason: '已生效内容不可删除（如需移除请先下架/retire）' };
    await this.db.query('DELETE FROM jz_distillation_nodes WHERE id=$1', [nodeId]); // 级联删除其评分
    return { deleted: true };
  }

  /** 删除整个【未生效】蒸馏任务（无任何 live 节点时才允许；级联删除其所有节点与评分）。 */
  async deleteRun(runId: string): Promise<{ deleted: boolean; reason?: string; liveCount?: number }> {
    const run = await this.getRun(runId);
    if (!run) return { deleted: false, reason: '任务不存在' };
    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS n FROM jz_distillation_nodes WHERE run_id=$1 AND lifecycle='live'`, [runId],
    );
    const liveCount = rows[0]?.n || 0;
    if (liveCount > 0) return { deleted: false, reason: `该任务已有 ${liveCount} 条生效内容，不能整体删除；请逐条处理或先下架。`, liveCount };
    this.stopBackground(runId); // 若正在后台展开，先停
    await this.db.query('DELETE FROM jz_distillation_runs WHERE id=$1', [runId]); // 级联删除节点+评分
    this.logger.log(`Distill run ${runId} 已删除（未生效）`);
    return { deleted: true, liveCount: 0 };
  }

  async listRuns(): Promise<any[]> {
    const { rows } = await this.db.query(
      `SELECT id, topic, status, breadth_n, max_rounds, category_root, created_at, finalized_at
       FROM jz_distillation_runs ORDER BY created_at DESC LIMIT 100`,
    );
    return rows.map((r: any) => ({
      runId: r.id, topic: r.topic, status: r.status, breadthN: r.breadth_n, maxRounds: r.max_rounds,
      categoryRoot: r.category_root, createdAt: r.created_at, finalizedAt: r.finalized_at,
    }));
  }

  /**
   * 本用户"可继续深化"的专项 + 各自待展开数。用于"续聊时把活跃 run 注入上下文"与去重硬闸。
   * 可继续 = 未收尾(finalized_at IS NULL) 或 仍有 pending 节点（finalize 可能在还有大量 pending 时发生，
   * 那种 run 深度没抽干、依然可 distill_run_background 续跑——必须能被发现，否则会被误判为"丢失"而重建）。
   */
  async listActiveRuns(createdBy: string): Promise<{ runId: string; topic: string; pending: number; total: number; finalized: boolean; createdAt: any }[]> {
    if (!createdBy || createdBy === 'anonymous') return [];
    const { rows } = await this.db.query(
      `SELECT r.id, r.topic, r.created_at, (r.finalized_at IS NOT NULL) AS finalized,
              COUNT(n.id)::int AS total,
              COUNT(n.id) FILTER (WHERE n.status='pending')::int AS pending
         FROM jz_distillation_runs r
         LEFT JOIN jz_distillation_nodes n ON n.run_id = r.id
        WHERE r.created_by = $1
        GROUP BY r.id, r.topic, r.created_at, r.finalized_at
        HAVING r.finalized_at IS NULL OR COUNT(n.id) FILTER (WHERE n.status='pending') > 0
        ORDER BY r.created_at DESC LIMIT 20`,
      [createdBy],
    );
    return rows.map((r: any) => ({ runId: r.id, topic: r.topic, pending: r.pending, total: r.total, finalized: r.finalized, createdAt: r.created_at }));
  }

  /** 本用户全部专项（含已收尾、含 0 pending）+ 计数，供 distill_list 让模型显式发现，而非靠猜 runId。 */
  async listUserRuns(createdBy: string): Promise<{ runId: string; topic: string; status: string; finalized: boolean; pending: number; total: number; createdAt: any }[]> {
    if (!createdBy || createdBy === 'anonymous') return [];
    const { rows } = await this.db.query(
      `SELECT r.id, r.topic, r.status, r.created_at, (r.finalized_at IS NOT NULL) AS finalized,
              COUNT(n.id)::int AS total,
              COUNT(n.id) FILTER (WHERE n.status='pending')::int AS pending
         FROM jz_distillation_runs r
         LEFT JOIN jz_distillation_nodes n ON n.run_id = r.id
        WHERE r.created_by = $1
        GROUP BY r.id, r.topic, r.status, r.created_at, r.finalized_at
        ORDER BY r.created_at DESC LIMIT 30`,
      [createdBy],
    );
    return rows.map((r: any) => ({ runId: r.id, topic: r.topic, status: r.status, finalized: r.finalized, pending: r.pending, total: r.total, createdAt: r.created_at }));
  }

  /**
   * 去重硬闸：本用户是否已有"未收尾且主题高度相似"的专项。
   * 防止"会话继续后又新建专项"——同主题应深化(distill_run_background/extend)，不另起炉灶。
   * 用字符二元组 Jaccard 相似度（中文无分词，按字 bigram），阈值 0.45。
   */
  async findSimilarActiveRun(createdBy: string, topic: string): Promise<{ runId: string; topic: string; pending: number; similarity: number } | null> {
    const actives = await this.listActiveRuns(createdBy);
    if (!actives.length) return null;
    let best: { runId: string; topic: string; pending: number; similarity: number } | null = null;
    for (const a of actives) {
      const sim = this.topicSimilarity(topic, a.topic);
      if (sim >= 0.45 && (!best || sim > best.similarity)) {
        best = { runId: a.runId, topic: a.topic, pending: a.pending, similarity: sim };
      }
    }
    return best;
  }

  private topicSimilarity(a: string, b: string): number {
    const norm = (s: string) => (s || '').toLowerCase().replace(/[\s\/\\:*?"<>|，。、（）()【】\-—_+:：]/g, '');
    const grams = (s: string) => { const g = new Set<string>(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
    const A = grams(norm(a)), B = grams(norm(b));
    if (A.size === 0 || B.size === 0) return 0;
    let inter = 0; for (const g of A) if (B.has(g)) inter++;
    return inter / (A.size + B.size - inter);
  }

  // ── 优化回流（refine）：按评分反馈重生成节点内容 ─────────────────

  async regenerateNode(nodeId: string, feedbackDigest: string): Promise<any> {
    const node = await this.getNode(nodeId);
    if (!node) throw new Error('节点不存在');
    const run = await this.getRun(node.run_id);
    if (!run) throw new Error('蒸馏任务不存在');

    // 去掉旧内容的 frontmatter，仅保留正文供模型参考
    const prevBody = (node.content || '').replace(/^---[\s\S]*?---\n/, '').replace(/^>.*\n/, '').trim();
    const layer = node.result_layer || (run.result_taxonomy || this.DEFAULT_LAYERS)[0];

    const prompt = `你是"尤达大师"知识蒸馏内核。下面这篇专项知识在一线【实战评分】中得分偏低，需要你优化/纠错重写。
主题「${run.topic}」，问题「${node.question}」，结果层：${layer}。

一线评分反馈（按此改进）：
${feedbackDigest}

原内容：
${prevBody.slice(0, 3000)}

请重写出更准确、更可用、更贴合一线场景的版本，修正被标注的错误。输出 JSON（不要额外文字）：
{
  "answer": "重写后的内容，清晰专业、可直接用（禁倒装腔）。Markdown。",
  "confidence": 0.0,   // 对重写版准确性的自评
  "sources": []        // 如有引用
}`;
    const result = this.parseJson(await this.callLLM(prompt, 4096, 0.3));
    if (!result?.answer) throw new Error('重写失败：LLM 未返回有效内容');

    const confidence = typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.5;
    const sources: string[] = Array.isArray(result.sources) ? result.sources : [];
    const newVersion = (node.version || 1) + 1;
    const doc = this.buildDoc(run, { ...node, round: node.round }, { layer, artifactType: node.artifact_type || 'knowledge', confidence, sources, body: result.answer });

    // 新版本回到 candidate，清空旧评分（按 version 分桶，旧低分不拖累）
    await this.db.query(
      `UPDATE jz_distillation_nodes
         SET content=$2, confidence=$3, sources=$4, version=$5, lifecycle='candidate',
             agg_score=NULL, rating_count=0, has_safety_flag=FALSE, last_evaluated_at=NULL
       WHERE id=$1`,
      [nodeId, doc.content, confidence, JSON.stringify(sources), newVersion],
    );
    return { nodeId, version: newVersion, confidence, lifecycle: 'candidate', title: doc.title };
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private async generateQuestions(input: {
    topic: string; scope?: string; seedFacts?: string; n: number; round: number; parentQuestion: string | null;
  }): Promise<string[]> {
    const prompt = `你在为专项主题「${input.topic}」${input.scope ? `（范围：${input.scope}）` : ''}规划知识蒸馏的问题树第 ${input.round} 轮。
${input.parentQuestion ? `这是对上层问题「${input.parentQuestion}」的细化下钻。` : '这是第一轮，要把整个主题【铺开】成互不重复的关键维度。'}
${input.seedFacts ? `用户已知事实：${input.seedFacts}` : ''}

请提出 ${input.n} 个高质量、互不重复的问题。回答这些问题，就能蒸出这个主题该有的知识/技能/工具。
输出 JSON 数组（不要额外文字）：["问题1","问题2",...]`;
    const parsed = this.parseJson(await this.callLLM(prompt, 2000, 0.5));
    if (Array.isArray(parsed)) return parsed.filter((q: any) => typeof q === 'string' && q.trim()).slice(0, input.n);
    if (Array.isArray(parsed?.questions)) return parsed.questions.slice(0, input.n);
    return [];
  }

  /** 插入问题节点（跨节点去重；重复则跳过返回 null） */
  private async insertNode(runId: string, parentId: string | null, round: number, question: string): Promise<string | null> {
    const key = this.dedupKey(question);
    const { rows } = await this.db.query(
      `SELECT 1 FROM jz_distillation_nodes WHERE run_id=$1 AND dedup_key=$2 LIMIT 1`, [runId, key],
    );
    if (rows[0]) return null; // 语义重复，合并跳过
    const id = this.genId();
    await this.db.query(
      `INSERT INTO jz_distillation_nodes (id, run_id, parent_id, round, question, dedup_key, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
      [id, runId, parentId, round, question, key],
    );
    return id;
  }

  /** frontier 取节点的排序：depth=沿最深最新分支下钻到资产级；breadth=按轮次铺平。仅返回固定字符串，无注入风险。 */
  private frontierOrder(strategy?: string): string {
    return strategy === 'depth' ? 'round DESC, created_at DESC' : 'round, created_at';
  }

  /** RAG 接地：检索企业已有资料作为参考（best-effort） */
  private async ragGround(question: string): Promise<string> {
    const kb = await this.resolveKb();
    if (!kb) return '';
    const res = await this.kb.proxy(
      `/v1/knowledge-bases/${kb.id}/search?q=${encodeURIComponent(question)}&limit=3`, 'GET',
    );
    const hits = Array.isArray(res.data) ? res.data : (res.data?.results || []);
    if (!Array.isArray(hits) || hits.length === 0) return '';
    return hits.slice(0, 3)
      .map((h: any) => `- ${(h.content || h.text || h.snippet || '').toString().slice(0, 400)}`)
      .join('\n');
  }

  /**
   * 构建候选文档（带标注 frontmatter）。返回 {title, docPath(意向发布路径), content}。
   * 注意：W2 只把它存进蒸馏库(DB)，不写入金库；发布到 docPath 由 W3 验证通过后完成。
   */
  private buildDoc(run: any, node: any, d: {
    layer: string; artifactType: string; confidence: number; sources: string[]; body: string;
  }): { title: string; docPath: string; content: string } {
    const today = new Date().toISOString().slice(0, 10);
    const title = (this.sanitize(node.question).slice(0, 60)) || `节点${node.round}`;
    const docPath = `${run.category_root}${d.layer}层/${title}.md`; // 意向发布路径（生效后落此处）
    const content = [
      '---',
      `title: ${title}`,
      `generated_by: distiller`,
      `distill_run: ${run.id}`,
      `round: ${node.round}`,
      `result_layer: ${d.layer}`,
      `artifact_type: ${d.artifactType}`,
      `confidence: ${d.confidence.toFixed(2)}`,
      `lifecycle_status: candidate`,
      `version: 1`,
      `ai_generated: true`,
      `date: ${today}`,
      d.sources.length ? `sources:\n${d.sources.map(s => `  - ${s}`).join('\n')}` : 'sources: []',
      'tags:',
      `  - 专项/${this.sanitize(run.topic)}`,
      `  - ${d.layer}`,
      `  - ai-distilled`,
      '---',
      '',
      `> ⚠️ 本页由「尤达大师」蒸馏生成（置信度 ${d.confidence.toFixed(2)}），处于**候选**状态，尚未进入企业心智正式检索，待实战评分验证后生效。`,
      '',
      d.body,
    ].join('\n');
    return { title, docPath, content };
  }

  // ── frontier 批量遍历（"跑一段"，agent 仍可单点精修）─────────────

  async expandFrontier(runId: string, maxNodes = 6, strategy: 'breadth' | 'depth' = 'breadth'): Promise<any> {
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    const cap = Math.max(1, Math.min(maxNodes, 12)); // 单次硬上限，避免工具调用过久
    const expanded: any[] = [];
    let stopped = 'reached_batch_cap';

    for (let i = 0; i < cap; i++) {
      const total = await this.countNodes(runId);
      if (total > (run.budget?.maxNodes || 200)) { stopped = 'budget_exhausted'; break; }
      const { rows } = await this.db.query(
        `SELECT id FROM jz_distillation_nodes WHERE run_id=$1 AND status='pending' ORDER BY ${this.frontierOrder(strategy)} LIMIT 1`,
        [runId],
      );
      if (!rows[0]) { stopped = 'frontier_empty'; break; }
      try {
        const r = await this.expandNode(rows[0].id);
        if (r.budgetExhausted) { stopped = 'budget_exhausted'; break; }
        if (!r.skipped) expanded.push({ nodeId: r.nodeId, question: r.question, resultLayer: r.resultLayer, artifactType: r.artifactType, confidence: r.confidence, childCount: r.childCount });
      } catch (e: any) {
        // 单节点失败不中断整批；标记为 pruned 以免卡住 frontier
        await this.db.query(`UPDATE jz_distillation_nodes SET status='pruned' WHERE id=$1`, [rows[0].id]).catch(() => {});
        expanded.push({ nodeId: rows[0].id, error: e.message });
      }
    }
    const st = await this.status(runId);
    return { runId, expandedCount: expanded.length, expanded, stopped, progress: st };
  }

  // ── 后台异步扇出（长树不阻塞对话）─────────────────────────────────

  /** 启动后台展开：把整棵待办队列在后台逐节点跑到空/预算上限/被停止，立即返回，不阻塞。 */
  // ── 手动 frontier 连发防护：同步阻塞工具循环跑会撑大会话/慢/跑不完，连发到上限就逼用后台 ──
  private frontierStreak = new Map<string, { count: number; lastAt: number }>();
  /** 记一次 distill_expand_frontier 调用，返回当前连发计数（>10 分钟间隔视为新意图，重置）。 */
  noteFrontierCall(runId: string): number {
    const now = Date.now();
    const prev = this.frontierStreak.get(runId);
    const count = prev && now - prev.lastAt < 10 * 60 * 1000 ? prev.count + 1 : 1;
    this.frontierStreak.set(runId, { count, lastAt: now });
    return count;
  }
  resetFrontierStreak(runId: string): void { this.frontierStreak.delete(runId); }

  async startBackground(runId: string, opts: { concurrency?: number; strategy?: 'breadth' | 'depth' } = {}): Promise<any> {
    this.resetFrontierStreak(runId); // 改用后台 = 退出手动循环，清零连发计数
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    if (this.bgRunners.has(runId)) {
      const s = this.bgRunners.get(runId)!;
      return { alreadyRunning: true, runId, processed: s.processed, startedAt: s.startedAt };
    }
    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS n FROM jz_distillation_nodes WHERE run_id=$1 AND status='pending'`, [runId],
    );
    const pending = rows[0]?.n || 0;
    if (!pending) return { started: false, reason: 'frontier_empty', runId };

    const concurrency = Math.max(1, Math.min(opts.concurrency || 2, 4));
    const strategy: 'breadth' | 'depth' = opts.strategy === 'breadth' ? 'breadth' : 'depth'; // 后台默认深度优先：把分支抽到资产级
    this.bgRunners.set(runId, { stop: false, startedAt: Date.now(), processed: 0, failed: 0 });
    if (run.status !== 'running') {
      await this.db.query(`UPDATE jz_distillation_runs SET status='running', updated_at=NOW() WHERE id=$1`, [runId]).catch(() => {});
    }
    // 触发但不 await：后台跑。
    void this.runBackgroundLoop(runId, concurrency, strategy);
    this.logger.log(`Distill run ${runId}: 后台展开已启动（并发 ${concurrency}，策略 ${strategy}，待办 ${pending}）`);
    return { started: true, runId, pending, concurrency, strategy };
  }

  /** 请求停止后台展开（当前批跑完即停）。 */
  stopBackground(runId: string): any {
    const s = this.bgRunners.get(runId);
    if (!s) return { running: false, runId };
    s.stop = true;
    return { running: true, stopRequested: true, runId, processed: s.processed };
  }

  /** 后台展开运行态（供 status 透出）。 */
  backgroundState(runId: string): any {
    const s = this.bgRunners.get(runId);
    if (!s) return { running: false };
    return {
      running: true, processed: s.processed, failed: s.failed,
      startedAt: new Date(s.startedAt).toISOString(),
      elapsedSec: Math.round((Date.now() - s.startedAt) / 1000),
      lastError: s.lastError,
    };
  }

  private async runBackgroundLoop(runId: string, concurrency: number, strategy: 'breadth' | 'depth' = 'depth'): Promise<void> {
    const state = this.bgRunners.get(runId);
    if (!state) return;
    try {
      while (!state.stop) {
        const run = await this.getRun(runId);
        if (!run) { state.stopped = 'run_missing'; break; }
        if ((await this.countNodes(runId)) > (run.budget?.maxNodes || 200)) { state.stopped = 'budget_exhausted'; break; }

        const { rows } = await this.db.query(
          `SELECT id FROM jz_distillation_nodes WHERE run_id=$1 AND status='pending' ORDER BY ${this.frontierOrder(strategy)} LIMIT $2`,
          [runId, concurrency],
        );
        if (!rows.length) { state.stopped = 'frontier_empty'; break; }

        await Promise.all(rows.map(async (r: any) => {
          try {
            const res = await this.expandNode(r.id);
            if (!res.skipped) state.processed++;
          } catch (e: any) {
            state.failed++;
            state.lastError = e.message;
            await this.db.query(`UPDATE jz_distillation_nodes SET status='pruned' WHERE id=$1`, [r.id]).catch(() => {});
          }
        }));
        // 节流：批次间小憩，降低对模型代理的瞬时压力（429 主因）
        if (!state.stop) await new Promise(r => setTimeout(r, 400));
      }
    } catch (e: any) {
      state.lastError = e.message;
      this.logger.warn(`Distill bg loop ${runId} 异常：${e.message}`);
    } finally {
      this.bgRunners.delete(runId);
      this.logger.log(`Distill run ${runId}: 后台展开结束（${state.stopped || 'stopped'}，处理 ${state.processed}，失败 ${state.failed}）`);
    }
  }

  // ── LLM 整理精炼（两段式）：① 逐篇精炼 ② 按层去重合并成主文档 ─────

  /** 启动后台整理精炼。立即返回，进度经 events('progress', type:'curate') 推送。 */
  async startCurate(runId: string, opts: { polish?: boolean; merge?: boolean } = {}): Promise<any> {
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    if (this.curateRunners.has(runId)) {
      const s = this.curateRunners.get(runId)!;
      return { alreadyRunning: true, runId, phase: s.phase, polished: s.polished };
    }
    if (this.bgRunners.has(runId)) return { started: false, reason: 'background_expanding', runId };
    // 可整理 = 已展开、有内容、非主文档、非下架（含 live：已发布内容也能再精炼并回写 KB）
    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS n FROM jz_distillation_nodes
       WHERE run_id=$1 AND status='expanded' AND content IS NOT NULL AND artifact_type<>'digest' AND lifecycle<>'retired'`,
      [runId],
    );
    const total = rows[0]?.n || 0;
    if (!total) { this.logger.log(`Distill run ${runId}: 整理精炼无可整理候选（nothing_to_curate）`); return { started: false, reason: 'nothing_to_curate', runId }; }
    this.curateRunners.set(runId, { stop: false, startedAt: Date.now(), phase: 'polish', polished: 0, merged: 0, total });
    void this.runCurateLoop(runId, opts.polish !== false, opts.merge !== false);
    this.logger.log(`Distill run ${runId}: 整理精炼已启动（待精炼 ${total}，polish=${opts.polish !== false} merge=${opts.merge !== false}）`);
    return { started: true, runId, total };
  }

  stopCurate(runId: string): any {
    const s = this.curateRunners.get(runId);
    if (!s) return { running: false, runId };
    s.stop = true;
    return { running: true, stopRequested: true, runId };
  }

  /** 整理精炼运行态（供 status 透出 + 面板进度）。 */
  curateState(runId: string): any {
    const s = this.curateRunners.get(runId);
    if (!s) return { running: false };
    return {
      running: true, phase: s.phase, polished: s.polished, merged: s.merged, total: s.total,
      startedAt: new Date(s.startedAt).toISOString(),
      elapsedSec: Math.round((Date.now() - s.startedAt) / 1000), lastError: s.lastError,
    };
  }

  private async runCurateLoop(runId: string, doPolish: boolean, doMerge: boolean): Promise<void> {
    const state = this.curateRunners.get(runId);
    if (!state) return;
    try {
      const run = await this.getRun(runId);
      // 阶段一：逐篇精炼（提升清晰/准确/一致，版本+1 回候选态重验）
      if (doPolish) {
        state.phase = 'polish';
        const { rows } = await this.db.query(
          `SELECT id FROM jz_distillation_nodes
           WHERE run_id=$1 AND status='expanded' AND content IS NOT NULL AND artifact_type<>'digest' AND lifecycle<>'retired'
           ORDER BY result_layer, round, created_at`,
          [runId],
        );
        for (const r of rows) {
          if (state.stop) break;
          try { await this.polishNode(r.id); state.polished++; }
          catch (e: any) { state.lastError = e.message; this.logger.warn(`curate polish ${r.id} 失败：${e.message}`); }
          this.events.emit('progress', { runId, type: 'curate', phase: 'polish', polished: state.polished, total: state.total });
          if (!state.stop) await new Promise(res => setTimeout(res, 400));
        }
      }
      // 阶段二：按结果层去重合并成"主文档"
      if (doMerge && !state.stop) {
        state.phase = 'merge';
        const taxonomy: string[] = run.result_taxonomy || this.DEFAULT_LAYERS;
        for (const layer of taxonomy) {
          if (state.stop) break;
          try {
            const m = await this.mergeLayer(runId, layer);
            if (m) { state.merged++; this.events.emit('progress', { runId, type: 'curate', phase: 'merge', merged: state.merged, layer }); }
          } catch (e: any) { state.lastError = e.message; this.logger.warn(`curate merge ${layer} 失败：${e.message}`); }
          if (!state.stop) await new Promise(res => setTimeout(res, 400));
        }
      }
      state.phase = 'done'; state.done = true;
      this.events.emit('progress', { runId, type: 'curate', phase: 'done', polished: state.polished, merged: state.merged });
      this.logger.log(`Distill run ${runId}: 整理精炼完成（精炼 ${state.polished}，合并主文档 ${state.merged}）`);
    } catch (e: any) {
      state.lastError = e.message;
      this.logger.warn(`Distill curate loop ${runId} 异常：${e.message}`);
      this.events.emit('progress', { runId, type: 'curate', phase: 'error', error: e.message });
    } finally {
      this.curateRunners.delete(runId);
    }
  }

  /** 逐篇精炼：打磨语言/准确/一致，version+1，回候选态重验（内容已变，旧评分作废）。 */
  async polishNode(nodeId: string): Promise<any> {
    const node = await this.getNode(nodeId);
    if (!node) throw new Error('节点不存在');
    const run = await this.getRun(node.run_id);
    if (!run) throw new Error('蒸馏任务不存在');
    const prevBody = (node.content || '').replace(/^---[\s\S]*?---\n/, '').replace(/^>.*\n/, '').trim();
    const layer = node.result_layer || (run.result_taxonomy || this.DEFAULT_LAYERS)[0];
    const prompt = `你是"尤达大师"知识蒸馏内核，现在做【整理精炼】：把下面这篇专项知识打磨到可直接交付的水准——
- 表达清晰专业、消除冗余与重复、术语统一、结构合理（标题/列表/步骤/表格按需）；
- 修正明显的事实/逻辑问题，补全缺失的关键步骤或要点；
- 必须是标准书面语，禁倒装腔、禁玄语，面向一线可直接使用。
主题「${run.topic}」，问题「${node.question}」，结果层：${layer}。

原内容：
${prevBody.slice(0, 3500)}

只输出 JSON（不要额外文字）：{"answer":"精炼后的 Markdown 正文","confidence":0.0,"sources":[]}`;
    const result = this.parseJson(await this.callLLM(prompt, 4096, 0.3));
    if (!result?.answer) throw new Error('精炼失败：LLM 未返回有效内容');
    const confidence = typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : (node.confidence ?? 0.6);
    const sources: string[] = Array.isArray(result.sources) && result.sources.length ? result.sources : (node.sources || []);
    const newVersion = (node.version || 1) + 1;
    const doc = this.buildDoc(run, node, { layer, artifactType: node.artifact_type || 'knowledge', confidence, sources, body: result.answer });
    if (node.lifecycle === 'live') {
      // 已发布内容：精炼后直接回写企业心智、保持 live（管理员信任模式，不降级重验）
      await this.publishNodeToKb(node.doc_path, doc.content);
      await this.db.query(
        `UPDATE jz_distillation_nodes SET content=$2, confidence=$3, sources=$4, version=$5, published_path=COALESCE(published_path,$6) WHERE id=$1`,
        [nodeId, doc.content, confidence, JSON.stringify(sources), newVersion, node.doc_path],
      );
      return { nodeId, version: newVersion, confidence, lifecycle: 'live', republished: true };
    }
    // 候选内容：精炼后回候选态重验（内容已变，旧评分作废）
    await this.db.query(
      `UPDATE jz_distillation_nodes
         SET content=$2, confidence=$3, sources=$4, version=$5, lifecycle='candidate',
             agg_score=NULL, rating_count=0, has_safety_flag=FALSE, last_evaluated_at=NULL
       WHERE id=$1`,
      [nodeId, doc.content, confidence, JSON.stringify(sources), newVersion],
    );
    return { nodeId, version: newVersion, confidence, lifecycle: 'candidate' };
  }

  /** 把内容写入企业心智（note 文档）；用于 live 内容精炼后回写、或主文档发布。 */
  private async publishNodeToKb(docPath: string, content: string): Promise<boolean> {
    if (!docPath || !content) return false;
    const kb = await this.resolveKb();
    if (!kb) return false;
    const idx = docPath.lastIndexOf('/');
    const dirPath = docPath.slice(0, idx + 1);
    const filename = docPath.slice(idx + 1);
    const liveContent = content.replace(/lifecycle_status: candidate/, 'lifecycle_status: live');
    await this.kb.proxy(`/v1/knowledge-bases/${kb.id}/documents/note`, 'POST', { filename, path: dirPath, content: liveContent });
    return true;
  }

  /** 按结果层把多篇候选合并去重成一篇"主文档"节点（artifact_type='digest'，幂等更新）。 */
  async mergeLayer(runId: string, layer: string): Promise<any | null> {
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    const { rows } = await this.db.query(
      `SELECT id, title, question, content, confidence, lifecycle FROM jz_distillation_nodes
       WHERE run_id=$1 AND result_layer=$2 AND status='expanded' AND content IS NOT NULL AND artifact_type<>'digest' AND lifecycle<>'retired'
       ORDER BY confidence DESC NULLS LAST LIMIT 15`,
      [runId, layer],
    );
    if (rows.length < 2) return null; // 不足两篇不必合并
    const anyLive = rows.some((r: any) => r.lifecycle === 'live'); // 源已发布 → 主文档也直发 KB
    const parts = rows.map((r: any, i: number) =>
      `### 片段${i + 1}：${r.title || r.question}\n${(r.content || '').replace(/^---[\s\S]*?---\n/, '').replace(/^>.*\n/, '').trim().slice(0, 1000)}`,
    ).join('\n\n');
    const prompt = `你是"尤达大师"知识蒸馏内核，做【按层合并去重】：把以下同属「${layer}层」的多篇候选知识，整合成一篇结构清晰、无重复、可直接交付的"主文档"。
主题「${run.topic}」。要求：合并同类、去除重复、统一术语、补全逻辑、按子主题分节（标题/列表/步骤/表格按需）；标准书面语，禁倒装腔。

待合并片段（共 ${rows.length} 篇）：
${parts}

只输出 JSON（不要额外文字）：{"title":"主文档标题","answer":"合并后的 Markdown 正文","confidence":0.0}`;
    const result = this.parseJson(await this.callLLM(prompt, 6000, 0.3));
    if (!result?.answer) return null;
    const title = (typeof result.title === 'string' && result.title.trim()) ? this.sanitize(result.title).slice(0, 60) : `${layer}层·精炼主文档`;
    const confidence = typeof result.confidence === 'number' ? Math.max(0, Math.min(1, result.confidence)) : 0.7;
    const doc = this.buildDoc(run, { question: title, round: 0 }, { layer, artifactType: 'digest', confidence, sources: [], body: result.answer });
    // 源已发布 → 主文档也直发企业心智并标 live；否则留候选待入库
    const digestLifecycle = anyLive ? 'live' : 'candidate';
    if (anyLive) await this.publishNodeToKb(doc.docPath, doc.content).catch(() => {});
    // 幂等：该层已有主文档则更新，否则新建（避免每轮 curate 堆叠重复主文档）
    const { rows: ex } = await this.db.query(
      `SELECT id FROM jz_distillation_nodes WHERE run_id=$1 AND result_layer=$2 AND artifact_type='digest' LIMIT 1`,
      [runId, layer],
    );
    if (ex[0]) {
      await this.db.query(
        `UPDATE jz_distillation_nodes SET title=$2, question=$2, content=$3, confidence=$4, doc_path=$5,
            version=COALESCE(version,1)+1, lifecycle=$6, published_path=CASE WHEN $6='live' THEN $5 ELSE published_path END,
            agg_score=NULL, rating_count=0, has_safety_flag=FALSE
         WHERE id=$1`,
        [ex[0].id, title, doc.content, confidence, doc.docPath, digestLifecycle],
      );
      return { layer, title, merged: rows.length, nodeId: ex[0].id, updated: true, lifecycle: digestLifecycle };
    }
    const id = this.genId();
    await this.db.query(
      `INSERT INTO jz_distillation_nodes
         (id, run_id, parent_id, round, question, dedup_key, status, lifecycle, result_layer, artifact_type, confidence, sources, doc_path, title, content, version, published_path)
       VALUES ($1,$2,NULL,0,$3,$4,'expanded',$9,$5,'digest',$6,'[]'::jsonb,$7,$3,$8,1,CASE WHEN $9='live' THEN $7 ELSE NULL END)`,
      [id, runId, title, this.dedupKey(`digest:${layer}:${title}`), layer, confidence, doc.docPath, doc.content, digestLifecycle],
    );
    return { layer, title, merged: rows.length, nodeId: id, updated: false, lifecycle: digestLifecycle };
  }

  // ── 收尾：按结果层生成总览 + 工具索引 + CoWorker 绑定建议 ────────

  async finalize(runId: string): Promise<any> {
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    const { rows: nodes } = await this.db.query(
      `SELECT round, question, title, result_layer, artifact_type, confidence FROM jz_distillation_nodes
       WHERE run_id=$1 AND status='expanded' ORDER BY result_layer, round, created_at`,
      [runId],
    );
    if (nodes.length === 0) throw new Error('暂无已生成的候选内容，先 distill_expand 再收尾');

    const taxonomy: string[] = run.result_taxonomy || this.DEFAULT_LAYERS;
    const byLayer = new Map<string, any[]>();
    for (const n of nodes) {
      const l = n.result_layer || taxonomy[0];
      if (!byLayer.has(l)) byLayer.set(l, []);
      byLayer.get(l)!.push(n);
    }
    const lowConf = nodes.filter((n: any) => (n.confidence ?? 1) < 0.5);
    const tools = nodes.filter((n: any) => n.artifact_type === 'tool');

    const today = new Date().toISOString().slice(0, 10);
    const lines: string[] = [
      `---`, `title: ${this.sanitize(run.topic)} · 专项库总览`, `generated_by: distiller`,
      `distill_run: ${runId}`, `lifecycle_status: candidate`, `ai_generated: true`, `date: ${today}`, `---`, '',
      `# ${run.topic} 专项知识库（候选）`,
      run.scope_constraint ? `\n> 范围：${run.scope_constraint}` : '',
      `\n> 共 ${nodes.length} 篇候选；颗粒度 N=${run.breadth_n}、d=${run.max_rounds}。**候选态，待实战评分验证后生效**。`,
      '',
    ];
    for (const layer of taxonomy) {
      const items = byLayer.get(layer);
      if (!items?.length) continue;
      lines.push(`## ${layer}层（${items.length}）`);
      for (const it of items) lines.push(`- ${it.title || it.question}　\`${it.artifact_type || 'knowledge'}\`　置信 ${(it.confidence ?? 0).toFixed(2)}`);
      lines.push('');
    }
    if (tools.length) {
      lines.push(`## 🧰 工具索引（${tools.length}）`, '> 可被销售助手 CoWorker 直接套用的话术/清单/模板：');
      for (const t of tools) lines.push(`- ${t.title || t.question}`);
      lines.push('');
    }
    const overview = lines.filter(l => l !== undefined).join('\n');

    // 部分收尾语义：仍有 pending（深度没抽干，多见于 force 强收）时，
    // 只生成 overview 快照、status='partial'、**不写 finalized_at**（保持可继续发现/续抽）；
    // 只有 pending==0 才是真正"收尾"：status='done' + finalized_at。
    // 杜绝"名义 done、实则没抽干"导致续聊判为任务丢失。
    const { rows: pRows } = await this.db.query(
      `SELECT COUNT(*)::int AS pending FROM jz_distillation_nodes WHERE run_id=$1 AND status='pending'`, [runId],
    );
    const pending = pRows[0]?.pending || 0;
    const partial = pending > 0;
    if (partial) {
      await this.db.query(
        `UPDATE jz_distillation_runs SET overview=$2, status='partial', updated_at=NOW() WHERE id=$1`,
        [runId, overview],
      );
    } else {
      await this.db.query(
        `UPDATE jz_distillation_runs SET overview=$2, status='done', finalized_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [runId, overview],
      );
    }

    return {
      runId, topic: run.topic, categoryRoot: run.category_root,
      candidateCount: nodes.length,
      byLayer: Object.fromEntries([...byLayer].map(([k, v]) => [k, v.length])),
      toolCount: tools.length,
      lowConfidenceCount: lowConf.length,
      partial, pending,
      coworkerBinding: run.category_root, // 生效后绑给销售助手 CoWorker 的 knowledgeDomains 路径
      overview,
      note: partial
        ? `本次为【部分收尾】：还有 ${pending} 个节点未展开，专项保持"可继续深化"，随时可 distill_run_background(${runId}) 续抽后再正式收尾。已蒸候选仍在蒸馏库，待 W3 实战评分验证通过后才发布生效。`
        : '候选内容仍在蒸馏库，未进入企业心智正式检索；经 W3 实战评分验证通过后才发布到上述路径并可被检索。',
    };
  }

  private async resolveKb(): Promise<{ id: string } | null> {
    const res = await this.kb.proxy('/v1/knowledge-bases', 'GET');
    const kbs = Array.isArray(res.data) ? res.data : [];
    return kbs[0] || null;
  }

  private async getRun(id: string): Promise<any> {
    const { rows } = await this.db.query('SELECT * FROM jz_distillation_runs WHERE id=$1', [id]);
    return rows[0] || null;
  }

  private async getNode(id: string): Promise<any> {
    const { rows } = await this.db.query('SELECT * FROM jz_distillation_nodes WHERE id=$1', [id]);
    return rows[0] || null;
  }

  // 预算计数：排除 pruned——剪枝即释放额度，让"剪枝换深度"真正生效（仅用于预算护栏）。
  private async countNodes(runId: string): Promise<number> {
    const { rows } = await this.db.query("SELECT COUNT(*)::int AS n FROM jz_distillation_nodes WHERE run_id=$1 AND status<>'pruned'", [runId]);
    return rows[0]?.n || 0;
  }

  /** 调高节点上限（只升不降、封顶 1,000,000）。让 soul 的"提高预算"成为真实可用的杠杆。 */
  async setBudget(runId: string, maxNodes: number): Promise<{ runId: string; maxNodes: number; previous: number }> {
    const run = await this.getRun(runId);
    if (!run) throw new Error('蒸馏任务不存在');
    const prev = run.budget?.maxNodes || 200;
    const next = Math.max(prev, Math.min(1_000_000, Math.floor(maxNodes || 0)));
    const budget = { ...(run.budget || {}), maxNodes: next };
    await this.db.query(`UPDATE jz_distillation_runs SET budget=$2, updated_at=NOW() WHERE id=$1`, [runId, JSON.stringify(budget)]);
    return { runId, maxNodes: next, previous: prev };
  }

  private sanitize(s: string): string {
    return (s || '').replace(/[\/\\:*?"<>|\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private parseJson(text: string): any {
    if (!text) return null;
    let t = text.trim();
    // 去掉可能的 ```json 包裹
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch {}
    // 退路：截取第一个 { 或 [ 到最后一个 } 或 ]
    const s = t.search(/[{[]/);
    const e = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
    return null;
  }

  /** 经 ModelRouter 统一路由：社区版走官网代理、专业版用自有 key——不再直接读 models.json */
  private async callLLM(prompt: string, maxTokens = 4096, temperature = 0.3): Promise<string> {
    const model = this.modelRouter.resolveModel();
    const apiKey = this.modelRouter.getLlmAuthToken(model.provider);
    if (!apiKey && model.provider !== 'ollama') throw new Error('未配置可用的模型（请在系统设置里配置云模型或本地模型），无法蒸馏');

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const body = JSON.stringify({ model: model.id, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, temperature });

    // 退避重试：429/5xx/网络/空响应 视为瞬时，指数退避（尊重 Retry-After）后重试，避免限流直接变硬失败。
    const MAX_ATTEMPTS = 3;
    let lastMsg = '模型调用失败';
    let lastRetryable = true;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const resp = await fetch(`${model.baseUrl}/chat/completions`, { method: 'POST', headers, body, signal: AbortSignal.timeout(90000) });
        if (resp.status === 429 || resp.status >= 500) {
          lastMsg = `模型调用失败: ${resp.status}`; lastRetryable = true;
          if (attempt < MAX_ATTEMPTS) { await this.backoff(attempt, Number(resp.headers.get('retry-after')) || 0); continue; }
          throw this.transientErr(lastMsg, true);
        }
        if (!resp.ok) throw this.transientErr(`模型调用失败: ${resp.status}`, false); // 4xx(非429) 不重试
        const data = await resp.json();
        const content = data.choices?.[0]?.message?.content?.trim() || '';
        if (!content) {
          lastMsg = '生成失败：模型返回空'; lastRetryable = true;
          if (attempt < MAX_ATTEMPTS) { await this.backoff(attempt); continue; }
          throw this.transientErr('生成失败：模型多次返回空', true);
        }
        return content;
      } catch (e: any) {
        if (e?.__transient !== undefined) throw e; // 已分类的终态错误，直接上抛
        // 网络/超时等异常：重试
        lastMsg = `模型调用失败：${e?.message || e}`; lastRetryable = true;
        if (attempt < MAX_ATTEMPTS) { await this.backoff(attempt); continue; }
        throw this.transientErr(lastMsg, true);
      }
    }
    throw this.transientErr(lastMsg, lastRetryable);
  }

  /** 构造带可重试标记的错误（供工具层附加结构化 __error，使防循环守卫对瞬时错误更宽容）。 */
  private transientErr(msg: string, retryable: boolean): Error {
    const e: any = new Error(msg);
    e.__transient = true;
    e.retryable = retryable;
    e.code = retryable ? 'RATE_LIMIT' : 'LLM_ERROR';
    return e;
  }

  private async backoff(attempt: number, retryAfterSec = 0): Promise<void> {
    const base = retryAfterSec > 0 ? retryAfterSec * 1000 : Math.min(8000, 500 * 2 ** attempt);
    await new Promise(r => setTimeout(r, base + Math.floor(Math.random() * 300)));
  }
}
