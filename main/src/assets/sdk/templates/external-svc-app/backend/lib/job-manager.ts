/**
 * JobManager —— 排程任务服务层：轮询落库 + 指标摘要 + 冲击分析 + confirmToken 落库门。
 * 原则：LLM 只拿聚合摘要（metrics/impact），全量解只给面板；落库必须持有效 confirmToken。
 */
import type { AppContext } from '../../types/backend';
import type { SolverClient } from './solver-client';

/** 简单散列（仅用于 impact 一致性校验，非安全用途） */
function hashOf(obj: unknown): string {
  const s = JSON.stringify(obj);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(36)}`;
}

/** 全量解 → 聚合指标（LLM 摘要预算内） */
function toMetrics(solution: any) {
  const ops = solution?.ops ?? [];
  const late = ops.filter((o: any) => (o.lateDays ?? 0) > 0);
  return {
    opCount: ops.length,
    lateCount: late.length,
    lateOrders: late.slice(0, 10).map((o: any) => ({ orderId: o.orderId, lateDays: o.lateDays })),
    changeoverLossPct: solution?.changeoverLossPct ?? 0,
    maxLeadTimeDays: solution?.maxLeadTimeDays ?? 0,
    avgWip: solution?.avgWip ?? 0,
    avgCt: solution?.avgCt ?? 0,
  };
}

/** scenario 与 baseline 的指标对比 → 受冲击项清单 */
function diffMetrics(base: any, sc: any) {
  const lateDelta = (sc?.lateCount ?? 0) - (base?.lateCount ?? 0);
  const impacted = (sc?.lateOrders ?? []).filter(
    (o: any) => !(base?.lateOrders ?? []).some((b: any) => b.orderId === o.orderId),
  );
  return {
    lateDelta,
    changeoverLossPctDelta: (sc?.changeoverLossPct ?? 0) - (base?.changeoverLossPct ?? 0),
    newlyLateOrders: impacted,
  };
}

export class JobManager {
  constructor(private readonly app: AppContext, private readonly solver: SolverClient) {}

  /** 创建 job（baseline 或 scenario），异步驱动求解，立即返回 jobId */
  async create(type: 'baseline' | 'scenario', payload: any, parentId?: string, ops?: any[]): Promise<string> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.app.query(
      `INSERT INTO jobs (id, type, parent_id, ops, status) VALUES ($1,$2,$3,$4,'pending')`,
      [jobId, type, parentId ?? null, JSON.stringify(ops ?? [])],
    );
    void this.drive(jobId, payload); // 不 await——调用方立即拿到 jobId
    return jobId;
  }

  /** 后台驱动：提交求解 → 轮询 → 落库（全量 solution + 聚合 metrics） */
  private async drive(jobId: string, payload: any) {
    try {
      const solverJobId = await this.solver.submit(payload);
      await this.app.query(`UPDATE jobs SET status='running', progress=10 WHERE id=$1`, [jobId]);
      while (true) {
        await new Promise(r => setTimeout(r, 3000));
        const s = await this.solver.status(solverJobId);
        if (s.status === 'done') {
          await this.app.query(
            `UPDATE jobs SET status='done', progress=100, solution=$2, metrics=$3, finished_at=NOW() WHERE id=$1`,
            [jobId, JSON.stringify(s.solution), JSON.stringify(toMetrics(s.solution))],
          );
          return;
        }
        if (s.status === 'unknown') throw new Error('solver job lost');
        await this.app.query(`UPDATE jobs SET progress=LEAST(progress+15, 90) WHERE id=$1`, [jobId]);
      }
    } catch (e: any) {
      await this.app.query(
        `UPDATE jobs SET status='failed', metrics=$2, finished_at=NOW() WHERE id=$1`,
        [jobId, JSON.stringify({ error: e.message })],
      );
      this.app.logger.error(`job ${jobId} failed: ${e.message}`);
    }
  }

  /** 给 LLM 的聚合摘要（受 tokenLimits 预算约束） */
  async metrics(jobId: string) {
    const { rows: [job] } = await this.app.query(
      `SELECT id, type, status, progress, metrics FROM jobs WHERE id=$1`, [jobId],
    );
    return job ?? { error: 'job not found' };
  }

  /** 冲击分析 + 签发 confirmToken（绑定 scenario 与 impact 摘要，10 分钟有效） */
  async impact(scenarioId: string) {
    const { rows: [sc] } = await this.app.query(
      `SELECT parent_id, status, metrics FROM jobs WHERE id=$1 AND type='scenario'`, [scenarioId],
    );
    if (!sc) throw new Error('scenario not found');
    if (sc.status !== 'done') return { status: sc.status, progress: undefined, hint: '预演尚未完成，稍后再查' };
    const { rows: [base] } = await this.app.query(`SELECT metrics FROM jobs WHERE id=$1`, [sc.parent_id]);
    const impact = diffMetrics(base?.metrics, sc.metrics);
    const token = `ct_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await this.app.query(
      `INSERT INTO confirm_tokens (token, scenario_id, impact_hash, expires_at)
       VALUES ($1,$2,$3, NOW() + INTERVAL '10 minutes')`,
      [token, scenarioId, hashOf(impact)],
    );
    return { impact, confirmToken: token, expiresInSec: 600 };
  }

  /** 落库：必须持有效 confirmToken（LLM 只能提议，落库必经人确认） */
  async apply(scenarioId: string, token: string, userId?: string) {
    return this.app.transaction(async (tx) => {
      const { rows: tokens } = await tx.query(
        `DELETE FROM confirm_tokens WHERE token=$1 AND scenario_id=$2 AND expires_at > NOW()
         RETURNING impact_hash`, [token, scenarioId]);
      if (tokens.length === 0) throw new Error('confirmToken 无效或已过期——请重新预演并由用户确认');
      const { rows: [sc] } = await tx.query(
        `SELECT solution FROM jobs WHERE id=$1 AND status='done'`, [scenarioId]);
      if (!sc) throw new Error('scenario 解不存在');
      // 把 scenario 解写回 orders（锁定计划）：示例仅标记 payload.planned
      await tx.query(
        `UPDATE orders SET payload = payload || '{"planned": true}'::jsonb WHERE confirmed = TRUE`, []);
      this.app.logger.log(`scenario ${scenarioId} applied by ${userId ?? 'unknown'}`);
      return { ok: true, scenarioId };
    });
  }
}
