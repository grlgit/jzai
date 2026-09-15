import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { DbService } from '../../../db/db.service';
import { KbService } from '../kb.service';
import { DistillService } from './distill.service';

/**
 * DistillValidationService — 内容验证回路（实战评分门，W3）。
 *
 * 候选内容默认不生效。销售在 CoWorker 演练模式里模拟运用候选话术后多人多轮打分；
 * 聚合达标 → 自动 promotion 发布进金库（进入正式检索）；低分/安全红线 → 回流优化重写。
 *
 * 门限（可按业务校准）：
 *   T_high=4.0（生效）/ T_low=2.5（回流）/ N_min=3（最小样本）/ 安全红线一票否决。
 */
const T_HIGH = 4.0;
const T_LOW = 2.5;
const N_MIN = 3;
const DIMS = ['accuracy', 'usability', 'effectiveness', 'safety'] as const;

interface Scores { accuracy: number; usability: number; effectiveness: number; safety: number; }

@Injectable()
export class DistillValidationService {
  private readonly logger = new Logger(DistillValidationService.name);

  constructor(
    private readonly db: DbService,
    private readonly kb: KbService,
    private readonly distill: DistillService,
  ) {}

  private genId(): string {
    return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  }

  // ── 演练：列出候选供模拟运用与打分 ───────────────────────────────

  async listCandidates(runId: string, opts: { lifecycle?: string } = {}): Promise<any[]> {
    const ALL = ['candidate', 'validating', 'live', 'needs_fix', 'retired'];
    const lifecycles = opts.lifecycle === 'all' ? ALL
      : opts.lifecycle ? [opts.lifecycle]
      : ['candidate', 'validating'];
    const { rows } = await this.db.query(
      `SELECT id, round, question, title, content, result_layer, artifact_type, confidence,
              lifecycle, version, agg_score, rating_count, has_safety_flag, structured
       FROM jz_distillation_nodes
       WHERE run_id=$1 AND lifecycle = ANY($2) AND content IS NOT NULL
       ORDER BY result_layer, round, created_at`,
      [runId, lifecycles],
    );
    return rows.map((r: any) => ({
      nodeId: r.id, round: r.round, question: r.question, title: r.title,
      content: r.content, resultLayer: r.result_layer, artifactType: r.artifact_type,
      confidence: r.confidence, lifecycle: r.lifecycle, version: r.version,
      aggScore: r.agg_score, ratingCount: r.rating_count, hasSafetyFlag: r.has_safety_flag,
      structured: r.structured || null,
    }));
  }

  // ── 提交一次评分（多人多轮）→ 触发聚合与门限判定 ────────────────

  async submitFeedback(nodeId: string, raterUserId: string, input: {
    scores: Partial<Scores>; scenario?: string; round?: number; comment?: string;
    flaggedErrors?: { snippet: string; reason: string }[];
  }): Promise<any> {
    const node = await this.getNode(nodeId);
    if (!node) throw new Error('节点不存在');
    if (!node.content) throw new Error('该节点尚无候选内容');
    if (['live', 'retired'].includes(node.lifecycle)) {
      return { skipped: true, reason: `内容已 ${node.lifecycle}，无需再评分` };
    }

    const scores = this.normScores(input.scores);
    await this.db.query(
      `INSERT INTO jz_distill_feedback (id, node_id, node_version, rater_user_id, scenario, round, scores, comment, flagged_errors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [this.genId(), nodeId, node.version || 1, raterUserId, input.scenario || null, input.round || 1,
       JSON.stringify(scores), input.comment || null, JSON.stringify(input.flaggedErrors || [])],
    );

    const gate = await this.recomputeAndGate(nodeId);
    return { ok: true, ...gate };
  }

  // ── 聚合 + 门限判定 + 生效/回流 ──────────────────────────────────

  async recomputeAndGate(nodeId: string): Promise<any> {
    const node = await this.getNode(nodeId);
    if (!node) throw new Error('节点不存在');

    // 仅统计当前版本的评分（优化后是新版本，重新积累）
    const { rows: fbs } = await this.db.query(
      `SELECT rater_user_id, scores FROM jz_distill_feedback WHERE node_id=$1 AND node_version=$2`,
      [nodeId, node.version || 1],
    );
    const ratingCount = fbs.length;

    // 评分者权重（资深销售权重更高；缺省 1.0）——加权聚合
    const weights = await this.raterWeights(fbs.map((f: any) => f.rater_user_id));
    let weightedSum = 0, weightTotal = 0;
    let hasSafetyFlag = false;
    for (const fb of fbs) {
      const s: Scores = fb.scores || {};
      const overall = DIMS.map(d => Number(s[d]) || 0).reduce((a, b) => a + b, 0) / DIMS.length;
      const w = weights[fb.rater_user_id] ?? 1.0;
      weightedSum += overall * w;
      weightTotal += w;
      // 安全红线：准确性或安全性 ≤2 → 一票否决（不受权重影响）
      if ((Number(s.accuracy) || 5) <= 2 || (Number(s.safety) || 5) <= 2) hasSafetyFlag = true;
    }
    const aggScore = weightTotal ? +(weightedSum / weightTotal).toFixed(3) : null;

    // 判定生命周期
    let lifecycle: string;
    if (hasSafetyFlag) {
      lifecycle = 'needs_fix';                       // 安全红线，一票否决
    } else if (ratingCount >= N_MIN && aggScore !== null && aggScore >= T_HIGH) {
      lifecycle = 'live';                            // 达标生效
    } else if (ratingCount >= 2 && aggScore !== null && aggScore <= T_LOW) {
      lifecycle = 'needs_fix';                       // 明确低分，回流
    } else {
      lifecycle = 'validating';                      // 继续征集评分
    }

    await this.db.query(
      `UPDATE jz_distillation_nodes SET lifecycle=$2, agg_score=$3, rating_count=$4, has_safety_flag=$5, last_evaluated_at=NOW() WHERE id=$1`,
      [nodeId, lifecycle, aggScore, ratingCount, hasSafetyFlag],
    );

    let published: string | undefined;
    if (lifecycle === 'live') {
      published = await this.promote(nodeId).catch((e) => { this.logger.warn(`promote failed: ${e.message}`); return undefined; });
    }

    return {
      nodeId, lifecycle, aggScore, ratingCount, hasSafetyFlag,
      thresholds: { T_HIGH, T_LOW, N_MIN },
      published,
      hint: lifecycle === 'live' ? '已达标生效并发布进金库'
        : lifecycle === 'needs_fix' ? '需优化（安全红线或明确低分）——可 distill_refine 回流重写'
        : `验证中（样本 ${ratingCount}/${N_MIN}）`,
    };
  }

  // ── 生效发布：把候选内容写进金库（此刻才进入正式检索）───────────

  private async promote(nodeId: string): Promise<string | undefined> {
    const node = await this.getNode(nodeId);
    if (!node?.content || !node.doc_path) return undefined;
    const kb = await this.resolveKb();
    if (!kb) throw new Error('知识库不可用');

    // doc_path 形如 /wiki/专项/{主题}/{层}层/{title}.md → 拆 dir + filename
    const idx = node.doc_path.lastIndexOf('/');
    const dirPath = node.doc_path.slice(0, idx + 1);
    const filename = node.doc_path.slice(idx + 1);
    // 发布版把 lifecycle 标记为 live
    const liveContent = (node.content || '').replace(/lifecycle_status: candidate/, 'lifecycle_status: live');

    await this.kb.proxy(
      `/v1/knowledge-bases/${kb.id}/documents/note`, 'POST',
      { filename, path: dirPath, content: liveContent },
    );
    await this.db.query(`UPDATE jz_distillation_nodes SET published_path=$2 WHERE id=$1`, [nodeId, node.doc_path]);
    this.logger.log(`Promoted distilled node ${nodeId} → ${node.doc_path} (live)`);
    return node.doc_path;
  }

  // ── 批量入库：授权用户一键直发候选到企业心智（跳过逐条实战评分）────

  /**
   * 批量发布候选到企业心智（正式检索）。默认发布该专项【全部可发布候选】；传 nodeIds 则只发这些。
   * 可发布 = status='expanded' 且有内容 且 lifecycle 非 live/retired。逐条写 KB 成功后才置 live。
   */
  async batchPublish(runId: string, opts: { nodeIds?: string[] } = {}): Promise<{ published: number; failed: { nodeId: string; error: string }[]; total: number }> {
    const params: any[] = [runId];
    let sql = `SELECT id FROM jz_distillation_nodes
               WHERE run_id=$1 AND status='expanded' AND content IS NOT NULL AND doc_path IS NOT NULL
                 AND lifecycle NOT IN ('live','retired')`;
    if (opts.nodeIds?.length) { sql += ` AND id = ANY($2::text[])`; params.push(opts.nodeIds); }
    const { rows } = await this.db.query(sql, params);
    const failed: { nodeId: string; error: string }[] = [];
    let published = 0;
    for (const r of rows) {
      try {
        await this.promote(r.id);                       // 写 KB + 记 published_path
        await this.db.query(`UPDATE jz_distillation_nodes SET lifecycle='live' WHERE id=$1`, [r.id]);
        published++;
      } catch (e: any) {
        failed.push({ nodeId: r.id, error: e?.message || String(e) });
      }
    }
    this.logger.log(`Batch publish run ${runId}: 发布 ${published}/${rows.length}，失败 ${failed.length}`);
    return { published, failed, total: rows.length };
  }

  // ── 待优化队列 + 回流重写 ────────────────────────────────────────

  async fixQueue(runId: string): Promise<any[]> {
    const { rows } = await this.db.query(
      `SELECT id, round, question, title, result_layer, confidence, agg_score, rating_count, has_safety_flag
       FROM jz_distillation_nodes WHERE run_id=$1 AND lifecycle='needs_fix' ORDER BY agg_score NULLS FIRST, round`,
      [runId],
    );
    return rows.map((r: any) => ({
      nodeId: r.id, round: r.round, question: r.question, title: r.title,
      resultLayer: r.result_layer, confidence: r.confidence,
      aggScore: r.agg_score, ratingCount: r.rating_count, hasSafetyFlag: r.has_safety_flag,
    }));
  }

  /** 汇总当前版本的低分维度 + 评语 + 标注错误，作为重写指引 */
  private async buildFeedbackDigest(nodeId: string, version: number): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT scores, comment, flagged_errors FROM jz_distill_feedback WHERE node_id=$1 AND node_version=$2`,
      [nodeId, version],
    );
    if (rows.length === 0) return '（无评分明细；可能因初筛置信度过低进入待优化。请提升准确性与可操作性。）';

    const dimAvg: Record<string, number> = {};
    for (const d of DIMS) dimAvg[d] = 0;
    const comments: string[] = [];
    const errors: string[] = [];
    for (const r of rows) {
      const s = r.scores || {};
      for (const d of DIMS) dimAvg[d] += Number(s[d]) || 0;
      if (r.comment) comments.push(`- ${r.comment}`);
      for (const e of (r.flagged_errors || [])) errors.push(`- 错误片段「${e.snippet}」：${e.reason}`);
    }
    for (const d of DIMS) dimAvg[d] = +(dimAvg[d] / rows.length).toFixed(2);
    const dimLabel: Record<string, string> = { accuracy: '准确性', usability: '可用性', effectiveness: '有效性', safety: '安全性' };
    const lowDims = DIMS.filter(d => dimAvg[d] < 3.5).map(d => `${dimLabel[d]}(${dimAvg[d]})`);

    return [
      lowDims.length ? `低分维度：${lowDims.join('、')}` : `各维均分：${DIMS.map(d => `${dimLabel[d]}${dimAvg[d]}`).join('、')}`,
      comments.length ? `评语：\n${comments.join('\n')}` : '',
      errors.length ? `标注的错误：\n${errors.join('\n')}` : '',
    ].filter(Boolean).join('\n');
  }

  /** 回流：按反馈重写节点 → version+1 → 回 candidate 重新验证 */
  async refine(nodeId: string): Promise<any> {
    const node = await this.getNode(nodeId);
    if (!node) throw new Error('节点不存在');
    const digest = await this.buildFeedbackDigest(nodeId, node.version || 1);
    const r = await this.distill.regenerateNode(nodeId, digest);
    this.logger.log(`Refined distilled node ${nodeId} → v${r.version}`);
    return { ...r, basedOn: digest };
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  // ── 评分者权重 ───────────────────────────────────────────────────

  private async raterWeights(userIds: string[]): Promise<Record<string, number>> {
    const uniq = [...new Set(userIds.filter(Boolean))];
    if (!uniq.length) return {};
    const { rows } = await this.db.query(
      `SELECT user_id, weight FROM jz_distill_rater_weights WHERE user_id = ANY($1)`, [uniq],
    );
    const map: Record<string, number> = {};
    for (const r of rows) map[r.user_id] = Number(r.weight) || 1.0;
    return map;
  }

  async setRaterWeight(userId: string, weight: number, note?: string): Promise<any> {
    const w = Math.max(0.1, Math.min(Number(weight) || 1.0, 5.0));
    await this.db.query(
      `INSERT INTO jz_distill_rater_weights (user_id, weight, note, updated_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (user_id) DO UPDATE SET weight=$2, note=$3, updated_at=NOW()`,
      [userId, w, note || null],
    );
    return { userId, weight: w };
  }

  async listRaterWeights(): Promise<any[]> {
    const { rows } = await this.db.query(`SELECT user_id, weight, note, updated_at FROM jz_distill_rater_weights ORDER BY weight DESC`);
    return rows.map((r: any) => ({ userId: r.user_id, weight: r.weight, note: r.note, updatedAt: r.updated_at }));
  }

  private normScores(s: Partial<Scores>): Scores {
    const clamp = (v: any) => Math.max(1, Math.min(5, Math.round(Number(v) || 0))) || 3;
    return { accuracy: clamp(s.accuracy), usability: clamp(s.usability), effectiveness: clamp(s.effectiveness), safety: clamp(s.safety) };
  }

  private async getNode(id: string): Promise<any> {
    const { rows } = await this.db.query('SELECT * FROM jz_distillation_nodes WHERE id=$1', [id]);
    return rows[0] || null;
  }

  private async resolveKb(): Promise<{ id: string } | null> {
    const res = await this.kb.proxy('/v1/knowledge-bases', 'GET');
    const kbs = Array.isArray(res.data) ? res.data : [];
    return kbs[0] || null;
  }
}
