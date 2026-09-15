import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DbService } from '../../db/db.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { CoWorkerService } from './coworker.service';

/**
 * CoWorkerPostMeetingService — 会后分析。
 *
 * 把【知识蒸馏】已生效(live)的"工具类"产物的结构化规格(structured)，当作评估量规，
 * 程序化套用到 CoWorker 的一段真实会话上：
 *   - scorecard → 逐维度打分（含证据片段）
 *   - checklist → 逐项查是否覆盖
 *   - script    → 逐步查话术步骤是否命中/顺序
 *   - form      → 从对话里抽取应收集的字段
 * 产出复盘报告并沉淀，供管理者教练与一线自检。
 *
 * 规格只取 lifecycle='live'（经实战评分门验证发布）的，且按 CoWorker 绑定的知识域(kbBindings)收敛——
 * 即"这个销售助手该用哪套话术/清单，就用哪套来评他"。
 */

type SpecKind = 'scorecard' | 'checklist' | 'script' | 'form';

interface LiveSpec {
  nodeId: string;
  title: string;
  topic: string;
  categoryRoot: string;
  kind: SpecKind;
  structured: any;
}

@Injectable()
export class CoWorkerPostMeetingService {
  private readonly logger = new Logger(CoWorkerPostMeetingService.name);

  constructor(
    private readonly db: DbService,
    private readonly modelRouter: ModelRouterService,
    private readonly cwService: CoWorkerService,
  ) {}

  // ── 取可套用的 live 工具规格（按 CoWorker 绑定的知识域收敛）─────────

  async getApplicableSpecs(kbBindings: string[]): Promise<LiveSpec[]> {
    const { rows } = await this.db.query(
      `SELECT n.id, n.title, n.question, n.structured, r.topic, r.category_root
         FROM jz_distillation_nodes n
         JOIN jz_distillation_runs r ON r.id = n.run_id
        WHERE n.lifecycle = 'live' AND n.artifact_type = 'tool' AND n.structured IS NOT NULL
        ORDER BY r.category_root, n.result_layer`,
    );
    const bindings = (kbBindings || []).map(b => String(b)).filter(Boolean);
    const specs: LiveSpec[] = [];
    for (const r of rows) {
      const structured = typeof r.structured === 'string' ? this.safeJson(r.structured) : r.structured;
      const kind = structured?.kind as SpecKind;
      if (!structured || !['scorecard', 'checklist', 'script', 'form'].includes(kind)) continue;
      const root = r.category_root || '';
      // 绑定收敛：CoWorker 有 kbBindings 时，仅取与其绑定知识域相交的规格；无绑定则全取。
      if (bindings.length && !bindings.some(b => this.pathOverlap(b, root))) continue;
      specs.push({
        nodeId: r.id, title: r.title || r.question || '未命名工具',
        topic: r.topic || '', categoryRoot: root, kind, structured,
      });
    }
    return specs;
  }

  // ── 会后分析主流程 ───────────────────────────────────────────────

  async analyze(input: {
    assignmentId: string;
    limit?: number;
    sinceMinutes?: number;
    createdBy?: string;
  }): Promise<any> {
    const assignment = await this.cwService.getAssignment(input.assignmentId);
    if (!assignment) throw new Error('CoWorker 分配记录不存在');
    const coworker = await this.cwService.getById(assignment.coworkerId);
    if (!coworker) throw new Error('CoWorker 不存在');

    const specs = await this.getApplicableSpecs(coworker.kbBindings);
    if (!specs.length) {
      return {
        skipped: true,
        reason: '无可套用的 live 工具规格——该 CoWorker 绑定的知识域下尚无经验证生效的话术/清单/评分卡。先在「知识蒸馏」里产出工具类产物并通过实战评分门。',
        coworkerId: coworker.id, coworkerName: coworker.name,
      };
    }

    const { transcript, messageCount, windowFrom, windowTo } = await this.loadTranscript(
      input.assignmentId, input.limit ?? 80, input.sinceMinutes,
    );
    if (!messageCount) throw new Error('该会话窗口内没有消息可分析');

    const raw = await this.callLlm(this.buildPrompt(coworker.name, transcript, specs));
    const parsed = this.parseJson(raw);
    if (!parsed) throw new Error('会后分析失败：模型未返回有效结果');

    const report = this.normalizeReport(parsed, specs);
    const overallScore = this.computeOverall(report);

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO jz_coworker_meeting_analysis
         (id, assignment_id, coworker_id, window_from, window_to, message_count, specs_applied, result, overall_score, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        id, input.assignmentId, coworker.id, windowFrom, windowTo, messageCount,
        JSON.stringify(specs.map(s => ({ nodeId: s.nodeId, title: s.title, kind: s.kind }))),
        JSON.stringify(report), overallScore, input.createdBy || null,
      ],
    );
    this.logger.log(`会后分析 ${id}：CoWorker ${coworker.name} / ${specs.length} 规格 / ${messageCount} 消息 / 综合 ${overallScore ?? '—'}`);

    return {
      id, coworkerId: coworker.id, coworkerName: coworker.name,
      assignmentId: input.assignmentId, userName: assignment.userName,
      messageCount, windowFrom, windowTo,
      specsApplied: specs.map(s => ({ nodeId: s.nodeId, title: s.title, kind: s.kind })),
      overallScore, report, createdAt: new Date().toISOString(),
    };
  }

  async listAnalyses(assignmentId: string, limit = 20): Promise<any[]> {
    const { rows } = await this.db.query(
      `SELECT id, coworker_id, window_from, window_to, message_count, specs_applied, overall_score, created_by, created_at
         FROM jz_coworker_meeting_analysis WHERE assignment_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [assignmentId, Math.min(limit, 100)],
    );
    return rows.map(r => ({
      id: r.id, coworkerId: r.coworker_id, windowFrom: r.window_from, windowTo: r.window_to,
      messageCount: r.message_count, specsApplied: this.safeJson(r.specs_applied) || [],
      overallScore: r.overall_score, createdBy: r.created_by, createdAt: r.created_at,
    }));
  }

  async getAnalysis(id: string): Promise<any | null> {
    const { rows } = await this.db.query(`SELECT * FROM jz_coworker_meeting_analysis WHERE id = $1`, [id]);
    const r = rows[0];
    if (!r) return null;
    return {
      id: r.id, assignmentId: r.assignment_id, coworkerId: r.coworker_id,
      windowFrom: r.window_from, windowTo: r.window_to, messageCount: r.message_count,
      specsApplied: this.safeJson(r.specs_applied) || [], report: this.safeJson(r.result) || {},
      overallScore: r.overall_score, createdBy: r.created_by, createdAt: r.created_at,
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  private async loadTranscript(assignmentId: string, limit: number, sinceMinutes?: number): Promise<{
    transcript: string; messageCount: number; windowFrom: Date | null; windowTo: Date | null;
  }> {
    const params: any[] = [assignmentId];
    let where = 'assignment_id = $1';
    if (sinceMinutes && sinceMinutes > 0) {
      where += ` AND created_at > NOW() - INTERVAL '${Math.floor(sinceMinutes)} minutes'`;
    }
    params.push(Math.max(1, Math.min(limit, 300)));
    const { rows } = await this.db.query(
      `SELECT direction, content, created_at FROM jz_coworker_messages
        WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    const ordered = rows.reverse(); // 时间正序
    const lines = ordered
      .filter((m: any) => (m.content || '').trim())
      .map((m: any) => `${m.direction === 'in' ? '客户' : '助手'}：${(m.content || '').trim()}`);
    return {
      transcript: lines.join('\n'),
      messageCount: lines.length,
      windowFrom: ordered[0]?.created_at || null,
      windowTo: ordered[ordered.length - 1]?.created_at || null,
    };
  }

  private buildPrompt(coworkerName: string, transcript: string, specs: LiveSpec[]): string {
    const specBlocks = specs.map(s => {
      const detail = this.describeSpec(s);
      return `【规格 ${s.nodeId}】「${s.title}」（来自专项「${s.topic}」，类型 ${s.kind}）\n${detail}`;
    }).join('\n\n');

    return `你是销售会谈复盘专家。下面是销售助手「${coworkerName}」与客户的一段真实会话记录，以及若干【经验证生效的评估量规】（来自企业知识蒸馏的工具规格）。
请严格用这些量规对会话做"会后分析"，逐条给出基于会话证据的判断——不要凭空发挥，证据必须引用会话中的原话片段。

== 会话记录 ==
${transcript}

== 评估量规 ==
${specBlocks}

请输出 JSON（不要任何额外文字），结构如下：
{
  "specs": [
    {
      "nodeId": "对应量规的 nodeId",
      "kind": "scorecard|checklist|script|form",
      // kind=scorecard：对每个维度打分（0..max 整数）
      "dimensions": [{ "name": "维度名", "score": 4, "max": 5, "rationale": "为何这么打", "evidence": "会话原话片段，无则空串" }],
      // kind=checklist：对每个清单项判断是否在会话中被覆盖
      "items": [{ "item": "清单项", "covered": true, "evidence": "原话片段" }],
      // kind=script：对每个话术步骤判断是否命中、顺序是否正确
      "steps": [{ "step": "步骤", "hit": true, "evidence": "原话片段" }],
      // kind=form：从会话中抽取该字段的值
      "fields": [{ "label": "字段名", "value": "抽取到的值，无则空串", "found": true }]
    }
  ],
  "summary": "整体复盘（2-4句，中肯专业）",
  "strengths": ["做得好的点"],
  "gaps": ["明显欠缺/遗漏"],
  "suggestions": ["下次可执行的改进建议"]
}
只填与各量规 kind 匹配的字段，其余字段省略。`;
  }

  private describeSpec(s: LiveSpec): string {
    const st = s.structured || {};
    switch (s.kind) {
      case 'scorecard':
        return '维度：' + (st.dimensions || []).map((d: any) => `${d.name}(满分${d.max ?? 5})`).join('、');
      case 'checklist':
        return '清单项：\n' + (st.items || []).map((i: any) => `  - ${typeof i === 'string' ? i : (i.label || i.text || JSON.stringify(i))}`).join('\n');
      case 'script':
        return '话术步骤：\n' + (st.steps || []).map((i: any, n: number) => `  ${n + 1}. ${typeof i === 'string' ? i : (i.label || i.text || JSON.stringify(i))}`).join('\n');
      case 'form':
        return '应收集字段：' + (st.fields || []).map((f: any) => (typeof f === 'string' ? f : (f.label || f.name))).join('、');
      default:
        return JSON.stringify(st).slice(0, 500);
    }
  }

  /** 把模型结果按规格对齐、补齐 nodeId/kind，确保下游可用 */
  private normalizeReport(parsed: any, specs: LiveSpec[]): any {
    const inSpecs: any[] = Array.isArray(parsed.specs) ? parsed.specs : [];
    const aligned: any[] = [];
    for (const spec of specs) {
      const found = inSpecs.find(x => x.nodeId === spec.nodeId) || {};
      aligned.push({
        nodeId: spec.nodeId, title: spec.title, kind: spec.kind, topic: spec.topic,
        dimensions: spec.kind === 'scorecard' ? this.cleanDimensions(found.dimensions, spec) : undefined,
        items: spec.kind === 'checklist' ? (Array.isArray(found.items) ? found.items : []) : undefined,
        steps: spec.kind === 'script' ? (Array.isArray(found.steps) ? found.steps : []) : undefined,
        fields: spec.kind === 'form' ? (Array.isArray(found.fields) ? found.fields : []) : undefined,
      });
    }
    return {
      specs: aligned,
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    };
  }

  private cleanDimensions(dims: any, spec: LiveSpec): any[] {
    const declared: any[] = spec.structured?.dimensions || [];
    const arr: any[] = Array.isArray(dims) ? dims : [];
    return declared.map((d: any) => {
      const max = Number(d.max) || 5;
      const hit = arr.find(x => x.name === d.name) || {};
      const score = Math.max(0, Math.min(Number(hit.score) || 0, max));
      return { name: d.name, score, max, rationale: hit.rationale || '', evidence: hit.evidence || '' };
    });
  }

  /** 综合得分(0-100)：评分卡占主，无评分卡时用清单覆盖率/话术命中率折算 */
  private computeOverall(report: any): number | null {
    let scoreSum = 0, maxSum = 0;
    for (const s of report.specs || []) {
      if (s.kind === 'scorecard') {
        for (const d of s.dimensions || []) { scoreSum += Number(d.score) || 0; maxSum += Number(d.max) || 0; }
      }
    }
    if (maxSum > 0) return +((scoreSum / maxSum) * 100).toFixed(1);

    // 退路：清单覆盖率 + 话术命中率平均
    const rates: number[] = [];
    for (const s of report.specs || []) {
      if (s.kind === 'checklist' && (s.items || []).length) {
        rates.push((s.items.filter((i: any) => i.covered).length / s.items.length) * 100);
      }
      if (s.kind === 'script' && (s.steps || []).length) {
        rates.push((s.steps.filter((i: any) => i.hit).length / s.steps.length) * 100);
      }
    }
    if (rates.length) return +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(1);
    return null;
  }

  /** 路径相交：任一为另一前缀即视为同一知识域（容忍首尾斜杠差异） */
  private pathOverlap(a: string, b: string): boolean {
    const norm = (s: string) => '/' + String(s || '').replace(/^\/+|\/+$/g, '') + '/';
    const x = norm(a), y = norm(b);
    return x.startsWith(y) || y.startsWith(x);
  }

  private async callLlm(prompt: string): Promise<string> {
    const model = this.modelRouter.resolveModel();
    const apiKey = this.modelRouter.getLlmAuthToken(model.provider);
    if (!apiKey && model.provider !== 'ollama') throw new Error(`未配置 ${model.provider} 的模型密钥，无法做会后分析`);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const resp = await fetch(`${model.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.id,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!resp.ok) throw new Error(`模型调用失败: ${resp.status}`);
    const data = await resp.json() as any;
    return data.choices?.[0]?.message?.content?.trim() || '';
  }

  private safeJson(v: any): any {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return null; }
  }

  private parseJson(text: string): any {
    if (!text) return null;
    let t = text.trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) t = fence[1].trim();
    try { return JSON.parse(t); } catch {}
    const s = t.search(/[{[]/);
    const e = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
    if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch {} }
    return null;
  }
}
