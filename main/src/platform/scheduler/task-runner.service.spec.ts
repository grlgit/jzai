/**
 * T2.3 单测：TaskRunnerService 不阻塞/并发闸/ advisory lock /硬超时/重试/技能路径。
 * mock DbService（lock 可控、run 行内存表）+ mock ScheduledTaskService + mock SkillExecutor。
 */
import { TaskRunnerService } from './task-runner.service';
import type { ScheduledTaskService } from './scheduled-task.service';

function makeDb(lockQueue: boolean[]) {
  const runs: any[] = [];
  let runId = 0;
  const audit: any[] = [];
  const events: any[] = [];
  const db = {
    runs, audit, events,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: lockQueue.length ? lockQueue.shift()! : true }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [] };
      if (sql.includes('INSERT INTO jz_scheduled_task_runs')) {
        const row = { id: ++runId, task_id: params[0], status: params[1], trigger: params[2],
          output: params[3], error: params[4], duration_ms: params[5], session_id: params[6] };
        runs.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (sql.startsWith('UPDATE jz_scheduled_task_runs')) {
        const [id, status, output, error, duration, sessionId] = params;
        const row = runs.find(r => r.id === id)!;
        row.status = status;
        if (output !== null) row.output = output;
        if (error !== null) row.error = error;
        if (duration !== null) row.duration_ms = duration;
        if (sessionId !== null) row.session_id = sessionId;
        return { rows: [] };
      }
      if (sql.includes('UPDATE jz_scheduled_tasks SET last_run_at')) return { rows: [] };
      if (sql.includes('INSERT INTO jz_audit_log')) { audit.push(params); return { rows: [] }; }
      if (sql.includes('INSERT INTO jz_events')) { events.push(params); return { rows: [] }; }
      throw new Error('unexpected SQL: ' + sql);
    }),
  } as any;
  return db;
}

function makeTask(patch: Partial<any> = {}): any {
  return {
    id: 'task1', name: 't', enabled: true, cron: '0 9 * * *', timezone: 'Asia/Shanghai',
    targetType: 'skill', targetId: 'my_skill', payload: { params: { a: 1 } },
    runAsUserId: 'u1', onConfirm: 'reject', timeoutSec: 5, maxRetries: 0,
    ...patch,
  };
}

function makeTasksSvc(task: any) {
  return { get: jest.fn(async () => task), registerExecutor: jest.fn() } as unknown as ScheduledTaskService;
}

async function waitRun(db: any, id: number, timeoutMs = 3000): Promise<any> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const row = db.runs.find((r: any) => r.id === id);
    if (row && row.status !== 'running') return row;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error('run 未在限时内到达终态');
}

describe('T2.3 TaskRunnerService', () => {
  it('用例1：runTask 立即返回（不等执行体）；run 行先 running 后 success；技能路径 output 落库', async () => {
    let resolveExec!: (v: any) => void;
    const executor = { execute: jest.fn(() => new Promise(res => { resolveExec = res; })) } as any;
    const db = makeDb([true]);
    const svc = new TaskRunnerService(db, makeTasksSvc(makeTask()), executor);
    svc.setMaxConcurrent(3);

    const t0 = Date.now();
    const runId = await svc.runTask('task1', 'cron');
    expect(Date.now() - t0).toBeLessThan(50); // 不阻塞
    expect(db.runs[0].status).toBe('running');
    expect(executor.execute).toHaveBeenCalledWith('my_skill', { a: 1 }, 'u1');

    resolveExec({ message: '技能执行成功' });
    const row = await waitRun(db, runId!);
    expect(row.status).toBe('success');
    expect(row.output).toBe('技能执行成功');
    expect(db.audit).toHaveLength(1);   // 审计 + 事件各一条
    expect(db.events).toHaveLength(1);
    expect(String(db.events[0][0])).toMatch(/^sched_run_/);
    expect(db.events[0][1]).toBe('u1'); // run_as_user 锚点
  });

  it('用例2：advisory lock 拿不到 → skipped 且执行体未调用', async () => {
    const executor = { execute: jest.fn() } as any;
    const db = makeDb([false]);
    const svc = new TaskRunnerService(db, makeTasksSvc(makeTask()), executor);
    const runId = await svc.runTask('task1', 'cron');
    const row = await waitRun(db, runId!);
    expect(row.status).toBe('skipped');
    expect(String(row.error)).toContain('未结束');
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('用例3：并发闸——上限 1 时第二个任务 skipped 记因', async () => {
    let release!: () => void;
    const blocker = new Promise<void>(res => { release = res; });
    const executor = { execute: jest.fn(() => blocker.then(() => ({ message: 'ok' }))) } as any;
    const db = makeDb([true, true]);
    const svc = new TaskRunnerService(db, makeTasksSvc(makeTask()), executor);
    svc.setMaxConcurrent(1);

    const id1 = await svc.runTask('task1', 'cron');
    const id2 = await svc.runTask('task1', 'manual'); // 同 task 但锁是 mock 队列，可进入 execute → 撞闸
    const row2 = await waitRun(db, id2!);
    expect(row2.status).toBe('skipped');
    expect(String(row2.error)).toContain('并发闸');
    release();
    const row1 = await waitRun(db, id1!);
    expect(row1.status).toBe('success');
  });

  it('用例4：执行体超时 → status=timeout', async () => {
    const executor = { execute: jest.fn(() => new Promise(() => {})) } as any; // 永不返回
    const db = makeDb([true]);
    const svc = new TaskRunnerService(db, makeTasksSvc(makeTask({ timeoutSec: 1 })), executor);
    const t0 = Date.now();
    const runId = await svc.runTask('task1', 'cron');
    const row = await waitRun(db, runId!, 4000);
    expect(row.status).toBe('timeout');
    expect(String(row.error)).toContain('超时');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    expect(Date.now() - t0).toBeLessThan(3500);
  });

  it('用例5a：max_retries=2 失败两次后成功 → 共执行 3 次，最终 success', async () => {
    let calls = 0;
    const executor = { execute: jest.fn(async () => {
      calls++;
      if (calls < 3) throw new Error(`第 ${calls} 次失败`);
      return { message: 'ok' };
    }) } as any;
    const db = makeDb([true]);
    const svc = new TaskRunnerService(db, makeTasksSvc(makeTask({ maxRetries: 2 })), executor);
    svc.setRetryBackoffBase(1);
    const runId = await svc.runTask('task1', 'cron');
    const row = await waitRun(db, runId!);
    expect(calls).toBe(3);
    expect(row.status).toBe('success');
  });

  it('用例5b：max_retries=2 持续失败 → 共执行 3 次，最终 failed 且 error 含重试记录', async () => {
    const executor = { execute: jest.fn(async () => { throw new Error('始终失败'); }) } as any;
    const db = makeDb([true]);
    const svc = new TaskRunnerService(db, makeTasksSvc(makeTask({ maxRetries: 2 })), executor);
    svc.setRetryBackoffBase(1);
    const runId = await svc.runTask('task1', 'cron');
    const row = await waitRun(db, runId!);
    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(row.status).toBe('failed');
    expect(String(row.error)).toContain('始终失败');
    expect(String(row.error)).toContain('重试');
  });

  it('手动触发 run 行 trigger=manual', async () => {
    const executor = { execute: jest.fn(async () => ({ message: 'ok' })) } as any;
    const db = makeDb([true]);
    const svc = new TaskRunnerService(db, makeTasksSvc(makeTask()), executor);
    const runId = await svc.runTask('task1', 'manual');
    const row = await waitRun(db, runId!);
    expect(row.trigger).toBe('manual');
  });

  it('任务不存在 → 返回 null 不写 run 行', async () => {
    const db = makeDb([true]);
    const tasksSvc = { get: jest.fn(async () => undefined), registerExecutor: jest.fn() } as unknown as ScheduledTaskService;
    const svc = new TaskRunnerService(db, tasksSvc, { execute: jest.fn() } as any);
    await expect(svc.runTask('ghost', 'cron')).resolves.toBeNull();
    expect(db.runs).toHaveLength(0);
  });
});
