/**
 * JobManager —— 异步任务核心：create() 立即返回 jobId，drive() 后台推进。
 * 本模板用 setTimeout 模拟（每 2 秒一步、5 步完成）；真实场景替换为
 * 外部服务提交 + 轮询（见 external-svc-app 模板）或分段批量处理。
 */
import type { AppContext } from '../../types/backend';

const TOTAL_STEPS = 5;
const STEP_MS = 2000;

export class JobManager {
  constructor(private readonly app: AppContext) {}

  /** 创建任务：落库后立即返回 jobId，后台异步驱动（不 await） */
  async create(type: string): Promise<string> {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await this.app.query(
      `INSERT INTO aj_jobs (id, type, status) VALUES ($1, $2, 'pending')`,
      [jobId, type],
    );
    void this.drive(jobId); // 不 await——调用方立即拿到 jobId
    return jobId;
  }

  /** 后台驱动：分步推进进度，全部完成后写入 result */
  private async drive(jobId: string) {
    try {
      await this.app.query(`UPDATE aj_jobs SET status='running' WHERE id=$1`, [jobId]);
      for (let step = 1; step <= TOTAL_STEPS; step++) {
        await new Promise(r => setTimeout(r, STEP_MS)); // 模拟一段耗时工作
        await this.app.query(
          `UPDATE aj_jobs SET progress=$2 WHERE id=$1`,
          [jobId, Math.round((step / TOTAL_STEPS) * 100)],
        );
        this.app.logger.log(`job ${jobId} step ${step}/${TOTAL_STEPS}`);
      }
      await this.app.query(
        `UPDATE aj_jobs SET status='done', result=$2, finished_at=NOW() WHERE id=$1`,
        [jobId, JSON.stringify({ files: 12, rows: 8640, summary: '本批 12 份报表已生成' })],
      );
    } catch (e: any) {
      // 失败也要落库，供面板/agent 查询
      await this.app.query(
        `UPDATE aj_jobs SET status='failed', result=$2, finished_at=NOW() WHERE id=$1`,
        [jobId, JSON.stringify({ error: e.message })],
      );
      this.app.logger.error(`job ${jobId} failed: ${e.message}`);
    }
  }
}
