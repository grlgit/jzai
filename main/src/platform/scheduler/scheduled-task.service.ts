import { Injectable, Logger, OnModuleDestroy, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob, CronTime } from 'cron';
import { DateTime } from 'luxon';
import { DbService } from '../../db/db.service';

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  cron: string;
  timezone: string;
  targetType: 'agent' | 'skill';
  targetId: string;
  payload: Record<string, any>;
  runAsUserId: string;
  onConfirm: 'reject' | 'skip_tool';
  timeoutSec: number;
  maxRetries: number;
  createdBy?: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface TaskInput {
  name: string;
  enabled?: boolean;
  cron: string;
  timezone?: string;
  targetType: 'agent' | 'skill';
  targetId: string;
  payload?: Record<string, any>;
  runAsUserId: string;
  onConfirm?: 'reject' | 'skip_tool';
  timeoutSec?: number;
  maxRetries?: number;
}

const JOB_PREFIX = 'jz_sched_';

/**
 * P2 定时任务注册表（docs/rework-2026H2/design-p2-scheduler.md §4.2）。
 * DB 为真源，SchedulerRegistry 为运行态镜像：每次写库后同步增删 CronJob。
 * 重启恢复 onModuleInit syncAll：每任务独立 try/catch，非法 cron 仅禁用该任务并记 warn，不拖垮启动。
 * 实际执行委托 TaskRunnerService（构造时注入，防循环依赖用 setter）。
 */
@Injectable()
export class ScheduledTaskService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledTaskService.name);
  /** 执行回调由 TaskRunnerService 注册（service 间解耦） */
  private executor: ((taskId: string, trigger: 'cron' | 'manual') => Promise<void>) | null = null;

  constructor(
    private readonly db: DbService,
    private readonly schedulerRegistry: SchedulerRegistry,
  ) {}

  registerExecutor(fn: (taskId: string, trigger: 'cron' | 'manual') => Promise<void>): void {
    this.executor = fn;
  }

  async onModuleInit() {
    await this.syncAll();
  }

  async onModuleDestroy() {
    for (const name of this.schedulerRegistry.getCronJobs().keys()) {
      if (name.startsWith(JOB_PREFIX)) this.schedulerRegistry.deleteCronJob(name);
    }
  }

  /** 校验 cron 并返回未来 3 次触发时间（前端预览用） */
  validateCron(expr: string, timezone = 'Asia/Shanghai'): { nextRuns: Date[] } {
    try {
      const ct = new CronTime(expr, timezone);
      const nextRuns: Date[] = [];
      let from: any = DateTime.local();
      for (let i = 0; i < 3; i++) {
        const t = ct.getNextDateFrom(from);
        nextRuns.push(t.toJSDate());
        from = t;
      }
      return { nextRuns };
    } catch (err: any) {
      throw new BadRequestException(`非法 cron 表达式: ${err.message}`);
    }
  }

  async list(): Promise<ScheduledTask[]> {
    const { rows } = await this.db.query(`SELECT * FROM jz_scheduled_tasks ORDER BY created_at`);
    return rows.map(r => this.rowToTask(r));
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    const { rows } = await this.db.query(`SELECT * FROM jz_scheduled_tasks WHERE id=$1`, [id]);
    return rows[0] ? this.rowToTask(rows[0]) : undefined;
  }

  async create(input: TaskInput, actorId?: string): Promise<ScheduledTask> {
    this.validateCron(input.cron, input.timezone);
    const id = `sched_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const enabled = input.enabled ?? true;
    const nextRunAt = enabled ? this.validateCron(input.cron, input.timezone).nextRuns[0] : null;
    const { rows } = await this.db.query(
      `INSERT INTO jz_scheduled_tasks
         (id, name, enabled, cron, timezone, target_type, target_id, payload,
          run_as_user_id, on_confirm, timeout_sec, max_retries, created_by, next_run_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [id, input.name, enabled, input.cron, input.timezone ?? 'Asia/Shanghai', input.targetType,
       input.targetId, JSON.stringify(input.payload ?? {}), input.runAsUserId,
       input.onConfirm ?? 'reject', input.timeoutSec ?? 300, input.maxRetries ?? 0,
       actorId ?? null, nextRunAt],
    );
    const task = this.rowToTask(rows[0]);
    if (enabled) this.safeAddJob(task);
    return task;
  }

  async update(id: string, patch: Partial<TaskInput>): Promise<ScheduledTask> {
    const existing = await this.get(id);
    if (!existing) throw new NotFoundException(`定时任务 ${id} 不存在`);
    const merged: TaskInput = {
      name: patch.name ?? existing.name,
      cron: patch.cron ?? existing.cron,
      timezone: patch.timezone ?? existing.timezone,
      targetType: patch.targetType ?? existing.targetType,
      targetId: patch.targetId ?? existing.targetId,
      payload: patch.payload ?? existing.payload,
      runAsUserId: patch.runAsUserId ?? existing.runAsUserId,
      onConfirm: patch.onConfirm ?? existing.onConfirm,
      timeoutSec: patch.timeoutSec ?? existing.timeoutSec,
      maxRetries: patch.maxRetries ?? existing.maxRetries,
      enabled: patch.enabled ?? existing.enabled,
    };
    if (patch.cron || patch.timezone) this.validateCron(merged.cron, merged.timezone);
    const nextRunAt = merged.enabled ? this.validateCron(merged.cron, merged.timezone).nextRuns[0] : null;
    const { rows } = await this.db.query(
      `UPDATE jz_scheduled_tasks SET name=$2, enabled=$3, cron=$4, timezone=$5, target_type=$6,
         target_id=$7, payload=$8, run_as_user_id=$9, on_confirm=$10, timeout_sec=$11,
         max_retries=$12, next_run_at=$13, updated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [id, merged.name, merged.enabled, merged.cron, merged.timezone, merged.targetType,
       merged.targetId, JSON.stringify(merged.payload ?? {}), merged.runAsUserId,
       merged.onConfirm, merged.timeoutSec, merged.maxRetries, nextRunAt],
    );
    const task = this.rowToTask(rows[0]);
    this.removeJob(id);
    if (task.enabled) this.safeAddJob(task);
    return task;
  }

  async remove(id: string): Promise<void> {
    await this.db.query(`DELETE FROM jz_scheduled_tasks WHERE id=$1`, [id]);
    this.removeJob(id);
  }

  async setEnabled(id: string, enabled: boolean): Promise<ScheduledTask> {
    return this.update(id, { enabled });
  }

  /** 重启恢复：全量加载 enabled 任务注册；坏任务独立降级 */
  async syncAll(): Promise<void> {
    const { rows } = await this.db.query(`SELECT * FROM jz_scheduled_tasks WHERE enabled=TRUE`);
    let ok = 0, bad = 0;
    for (const row of rows) {
      const task = this.rowToTask(row);
      try {
        this.validateCron(task.cron, task.timezone);
        this.addJob(task);
        ok++;
      } catch (err: any) {
        bad++;
        this.logger.error(`定时任务 ${task.id} cron 非法，已禁用: ${err.message}`);
        await this.db.query(
          `UPDATE jz_scheduled_tasks SET enabled=FALSE, updated_at=NOW() WHERE id=$1`, [task.id]);
      }
    }
    this.logger.log(`Scheduled tasks restored: ${ok} registered, ${bad} disabled (invalid cron)`);
  }

  private jobName(id: string) { return `${JOB_PREFIX}${id}`; }

  private addJob(task: ScheduledTask): void {
    const job = new CronJob(task.cron, () => {
      // 不阻塞：写 run 行后立即返回，执行体异步（设计 §4.3）
      if (this.executor) void this.executor(task.id, 'cron');
    }, null, true, task.timezone);
    this.schedulerRegistry.addCronJob(this.jobName(task.id), job);
    job.start();
    this.db.query(`UPDATE jz_scheduled_tasks SET next_run_at=$2 WHERE id=$1`,
      [task.id, job.nextDate().toJSDate()]).catch(() => {});
  }

  /** 注册失败只禁用该任务（如时间区非法），调用方（create/update）不因此 500 */
  private safeAddJob(task: ScheduledTask): void {
    try {
      this.addJob(task);
    } catch (err: any) {
      this.logger.error(`定时任务 ${task.id} 注册失败，已禁用: ${err.message}`);
      this.db.query(`UPDATE jz_scheduled_tasks SET enabled=FALSE, updated_at=NOW() WHERE id=$1`,
        [task.id]).catch(() => {});
    }
  }

  private removeJob(id: string): void {
    const name = this.jobName(id);
    if (this.schedulerRegistry.doesExist('cron', name)) {
      const job = this.schedulerRegistry.getCronJob(name);
      job.stop();
      this.schedulerRegistry.deleteCronJob(name);
    }
  }

  private rowToTask(r: any): ScheduledTask {
    return {
      id: r.id, name: r.name, enabled: r.enabled, cron: r.cron, timezone: r.timezone,
      targetType: r.target_type, targetId: r.target_id,
      payload: typeof r.payload === 'string' ? JSON.parse(r.payload) : (r.payload ?? {}),
      runAsUserId: r.run_as_user_id, onConfirm: r.on_confirm,
      timeoutSec: r.timeout_sec, maxRetries: r.max_retries,
      createdBy: r.created_by ?? undefined,
      lastRunAt: r.last_run_at ?? undefined, nextRunAt: r.next_run_at ?? undefined,
    };
  }
}
