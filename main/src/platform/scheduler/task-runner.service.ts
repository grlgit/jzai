import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { SkillExecutorService } from '../../capability/skill/skill-executor.service';
import { ScheduledTaskService, ScheduledTask } from './scheduled-task.service';

type AgentRunFn = (task: ScheduledTask, runId: number) => Promise<{ output: string; sessionId?: string }>;

/**
 * P2 任务执行器（docs/rework-2026H2/design-p2-scheduler.md §4.3）。
 * - cron 回调仅写 running 行后立即返回，执行体全程异步（不阻塞主进程）
 * - 并发闸：全局同时执行上限（默认 3），超限 skipped 记因
 * - 防重：pg_try_advisory_lock(hashtext('jztask:'||taskId))，拿不到即 skipped
 * - 硬超时：Promise.race；技能路径直调 SkillExecutorService.execute
 * - 重试：失败后指数退避（30s 基数），重试记录附注在同一 run 行 error
 * - agent 路径经 registerAgentRunner 注入（T2.4 headless runner，防模块循环依赖）
 */
@Injectable()
export class TaskRunnerService implements OnModuleInit {
  private readonly logger = new Logger(TaskRunnerService.name);
  private agentRunner: AgentRunFn | null = null;
  private runningCount = 0;
  private maxConcurrent = 3;
  /** 指数退避基数（ms）；测试可经 setRetryBackoffBase 缩短 */
  private retryBackoffBaseMs = 30_000;

  constructor(
    private readonly db: DbService,
    private readonly tasks: ScheduledTaskService,
    @Optional() private readonly skillExecutor?: SkillExecutorService,
  ) {}

  onModuleInit() {
    this.tasks.registerExecutor(async (taskId, trigger) => { await this.runTask(taskId, trigger); });
  }

  registerAgentRunner(fn: AgentRunFn): void {
    this.agentRunner = fn;
  }

  setMaxConcurrent(n: number): void { this.maxConcurrent = n; }
  setRetryBackoffBase(ms: number): void { this.retryBackoffBaseMs = ms; }

  /** cron/manual 入口：锁 → 写 running 行 → 异步执行，立即返回 */
  async runTask(taskId: string, trigger: 'cron' | 'manual'): Promise<number | null> {
    const task = await this.tasks.get(taskId);
    if (!task) { this.logger.warn(`定时任务 ${taskId} 不存在，跳过`); return null; }

    const lockKey = `jztask:${taskId}`;
    const { rows } = await this.db.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [lockKey]);
    if (!rows[0]?.ok) {
      this.logger.warn(`定时任务 ${taskId} 上一轮未结束，本次跳过`);
      const runId = await this.insertRun(taskId, trigger, 'skipped', { error: '上一轮执行未结束（advisory lock）' });
      return runId;
    }

    try {
      const runId = await this.insertRun(taskId, trigger, 'running', {});
      // 不阻塞主进程：立即返回，执行体异步
      void this.execute(task, runId, trigger).catch(err => {
        this.logger.error(`定时任务 ${taskId} 执行异常: ${err.message}`);
      });
      return runId;
    } catch (err: any) {
      await this.db.query(`SELECT pg_advisory_unlock(hashtext($1))`, [lockKey]).catch(() => {});
      throw err;
    }
  }

  private async execute(task: ScheduledTask, runId: number, _trigger: string): Promise<void> {
    if (this.runningCount >= this.maxConcurrent) {
      await this.finalizeRun(runId, 'skipped', { error: `并发闸已满（上限 ${this.maxConcurrent}）` });
      await this.unlock(task.id);
      return;
    }
    this.runningCount++;
    const started = Date.now();
    const retryNotes: string[] = [];
    let status: 'success' | 'failed' | 'timeout' = 'failed';
    let output = '';
    let sessionId: string | undefined;
    let errorMsg = '';

    try {
      for (let attempt = 0; attempt <= task.maxRetries; attempt++) {
        if (attempt > 0) {
          const backoff = this.retryBackoffBaseMs * Math.pow(2, attempt - 1);
          retryNotes.push(`第 ${attempt} 次重试前退避 ${backoff}ms`);
          await new Promise(r => setTimeout(r, backoff));
        }
        try {
          const result = await this.runWithTimeout(task, runId);
          status = 'success';
          output = result.output;
          sessionId = result.sessionId;
          errorMsg = '';
          break;
        } catch (err: any) {
          errorMsg = err.message || String(err);
          status = err.__timeout ? 'timeout' : 'failed';
          if (attempt < task.maxRetries && !err.__timeout) {
            retryNotes.push(`第 ${attempt + 1} 次执行失败: ${errorMsg}`);
            continue;
          }
          break;
        }
      }
      await this.finalizeRun(runId, status, {
        output: output ? output.slice(0, 8192) : undefined,
        error: [errorMsg, ...retryNotes].filter(Boolean).join('\n') || undefined,
        durationMs: Date.now() - started,
        sessionId,
      });
      if (status === 'success') {
        await this.db.query(`UPDATE jz_scheduled_tasks SET last_run_at=NOW(), updated_at=NOW() WHERE id=$1`, [task.id]);
      }
      await this.writeAudit(task, status, Date.now() - started);
    } finally {
      this.runningCount--;
      await this.unlock(task.id);
    }
  }

  /** 技能路径直调 executor；agent 路径走 headless runner（T2.4 注入） */
  private async runWithTimeout(task: ScheduledTask, runId: number): Promise<{ output: string; sessionId?: string }> {
    const body = (async () => {
      if (task.targetType === 'skill') {
        if (!this.skillExecutor) throw new Error('SkillExecutorService 未注入');
        const result = await this.skillExecutor.execute(task.targetId, task.payload?.params ?? {}, task.runAsUserId);
        return { output: result?.message ?? JSON.stringify(result ?? {}) };
      }
      if (!this.agentRunner) throw new Error('agent runner 未注册（T2.4 注入）');
      return this.agentRunner(task, runId);
    })();

    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error(`执行超时（${task.timeoutSec}s）`);
        (err as any).__timeout = true;
        reject(err);
      }, task.timeoutSec * 1000);
    });
    try {
      return await Promise.race([body, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  private async unlock(taskId: string): Promise<void> {
    await this.db.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`jztask:${taskId}`]).catch(() => {});
  }

  private async insertRun(taskId: string, trigger: string, status: string, extra: {
    output?: string; error?: string; durationMs?: number; sessionId?: string;
  }): Promise<number> {
    const { rows } = await this.db.query(
      `INSERT INTO jz_scheduled_task_runs (task_id, status, trigger, output, error, duration_ms, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [taskId, status, trigger, extra.output ?? null, extra.error ?? null,
       extra.durationMs ?? null, extra.sessionId ?? null],
    );
    return rows[0].id;
  }

  private async finalizeRun(runId: number, status: string, extra: {
    output?: string; error?: string; durationMs?: number; sessionId?: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE jz_scheduled_task_runs SET status=$2, finished_at=NOW(),
         output=COALESCE($3, output), error=COALESCE($4, error),
         duration_ms=COALESCE($5, duration_ms), session_id=COALESCE($6, session_id)
       WHERE id=$1`,
      [runId, status, extra.output ?? null, extra.error ?? null,
       extra.durationMs ?? null, extra.sessionId ?? null],
    );
  }

  /** 审计双写：jz_audit_log（action=scheduler.run）+ jz_events（scheduled_task_run） */
  private async writeAudit(task: ScheduledTask, status: string, durationMs: number): Promise<void> {
    const detail = JSON.stringify({ taskId: task.id, name: task.name, status, durationMs });
    await this.db.query(
      `INSERT INTO jz_audit_log (user_id, user_name, action, resource, resource_id, detail, ip_address, user_agent)
       VALUES ($1, $2, 'scheduler.run', 'scheduled_task', $3, $4, NULL, NULL)`,
      [task.runAsUserId, 'scheduler', task.id, detail],
    ).catch(err => this.logger.warn(`audit write failed: ${err.message}`));
    await this.db.query(
      `INSERT INTO jz_events (id, type, user_id, conversation_id, payload) VALUES ($1, 'scheduled_task_run', $2, NULL, $3)`,
      [`sched_run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, task.runAsUserId, detail],
    ).catch(err => this.logger.warn(`event write failed: ${err.message}`));
  }
}
