/**
 * T2.2 单测：ScheduledTaskService CRUD + CronJob 动态同步 + syncAll 重启恢复 + validateCron。
 * 真实 SchedulerRegistry（@nestjs/schedule）+ 内存 mock DbService。
 */
import { SchedulerRegistry } from '@nestjs/schedule';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScheduledTaskService } from './scheduled-task.service';

function makeDb(seed: any[] = []) {
  const rows = new Map<string, any>();
  for (const r of seed) rows.set(r.id, { ...r });
  let auto = 0;
  const db = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('INSERT INTO jz_scheduled_tasks')) {
        const [id, name, enabled, cron, timezone, target_type, target_id, payload,
          run_as_user_id, on_confirm, timeout_sec, max_retries, created_by, next_run_at] = params;
        const row = {
          id, name, enabled, cron, timezone, target_type, target_id,
          payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
          run_as_user_id, on_confirm, timeout_sec, max_retries, created_by,
          last_run_at: null, next_run_at,
        };
        rows.set(id, row);
        return { rows: [row] };
      }
      if (sql.startsWith('UPDATE jz_scheduled_tasks SET name=')) {
        const [id] = params;
        const row = rows.get(id)!;
        const [ , name, enabled, cron, timezone, target_type, target_id, payload,
          run_as_user_id, on_confirm, timeout_sec, max_retries, next_run_at] = params;
        Object.assign(row, {
          name, enabled, cron, timezone, target_type, target_id,
          payload: typeof payload === 'string' ? JSON.parse(payload) : payload,
          run_as_user_id, on_confirm, timeout_sec, max_retries, next_run_at,
        });
        return { rows: [row] };
      }
      if (sql.includes('SET enabled=FALSE')) {
        const [id] = params;
        if (rows.has(id)) rows.get(id)!.enabled = false;
        return { rows: [] };
      }
      if (sql.includes('SET next_run_at=')) {
        const [id, next] = params;
        if (rows.has(id)) rows.get(id)!.next_run_at = next;
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM jz_scheduled_tasks')) {
        rows.delete(params[0]);
        return { rows: [] };
      }
      if (sql.includes('WHERE id=$1') && sql.startsWith('SELECT')) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.includes('WHERE enabled=TRUE')) {
        return { rows: [...rows.values()].filter(r => r.enabled) };
      }
      if (sql.startsWith('SELECT * FROM jz_scheduled_tasks')) {
        return { rows: [...rows.values()] };
      }
      throw new Error('unexpected SQL: ' + sql);
    }),
    rows,
  } as any;
  return db;
}

const VALID = {
  name: '晨报', cron: '0 9 * * *', targetType: 'agent' as const, targetId: 'main',
  runAsUserId: 'u1',
};

describe('T2.2 ScheduledTaskService', () => {
  it('用例1：创建 enabled 任务 → registry 出现 job；禁用 → job 移除', async () => {
    const db = makeDb();
    const reg = new SchedulerRegistry();
    const svc = new ScheduledTaskService(db, reg);
    const task = await svc.create(VALID);
    expect(reg.doesExist('cron', `jz_sched_${task.id}`)).toBe(true);
    expect(task.nextRunAt).toBeTruthy();

    await svc.setEnabled(task.id, false);
    expect(reg.doesExist('cron', `jz_sched_${task.id}`)).toBe(false);
    expect(db.rows.get(task.id).enabled).toBe(false);
  });

  it('用例2：更新 cron → job 重建、next_run_at 变化', async () => {
    const db = makeDb();
    const reg = new SchedulerRegistry();
    const svc = new ScheduledTaskService(db, reg);
    const task = await svc.create(VALID);
    const before = db.rows.get(task.id).next_run_at;

    const updated = await svc.update(task.id, { cron: '30 18 * * *' });
    expect(updated.cron).toBe('30 18 * * *');
    expect(reg.doesExist('cron', `jz_sched_${task.id}`)).toBe(true); // 重建而非残留
    expect(db.rows.get(task.id).next_run_at.getTime()).not.toBe(before.getTime());
  });

  it('用例3：库中预置非法 cron → syncAll 仅禁用该任务，其余正常注册', async () => {
    const db = makeDb([
      { id: 'bad1', name: '坏任务', enabled: true, cron: 'not a cron', timezone: 'Asia/Shanghai',
        target_type: 'agent', target_id: 'main', payload: {}, run_as_user_id: 'u1',
        on_confirm: 'reject', timeout_sec: 300, max_retries: 0 },
      { id: 'good1', name: '好任务', enabled: true, cron: '0 9 * * *', timezone: 'Asia/Shanghai',
        target_type: 'skill', target_id: 'x', payload: {}, run_as_user_id: 'u1',
        on_confirm: 'reject', timeout_sec: 300, max_retries: 0 },
    ]);
    const reg = new SchedulerRegistry();
    const svc = new ScheduledTaskService(db, reg);
    await svc.onModuleInit();
    expect(reg.doesExist('cron', 'jz_sched_good1')).toBe(true);
    expect(reg.doesExist('cron', 'jz_sched_bad1')).toBe(false);
    expect(db.rows.get('bad1').enabled).toBe(false);
    expect(db.rows.get('good1').enabled).toBe(true);
  });

  it('用例4：validateCron 返回未来 3 次；非法表达式 400', () => {
    const svc = new ScheduledTaskService(makeDb(), new SchedulerRegistry());
    const { nextRuns } = svc.validateCron('0 9 * * 1');
    expect(nextRuns).toHaveLength(3);
    // 每周一 09:00（Asia/Shanghai）
    for (const d of nextRuns) {
      expect(d.getDay()).toBe(1);
      expect(d.getHours()).toBe(9);
      expect(d.getMinutes()).toBe(0);
    }
    expect(nextRuns[1].getTime()).toBeGreaterThan(nextRuns[0].getTime());
    expect(() => svc.validateCron('99 99 * * *')).toThrow(BadRequestException);
  });

  it('用例5：重启（新实例 syncAll）→ enabled 任务全部恢复注册', async () => {
    const db = makeDb();
    const svc1 = new ScheduledTaskService(db, new SchedulerRegistry());
    const t1 = await svc1.create(VALID);
    const t2 = await svc1.create({ ...VALID, name: '晚报', cron: '0 20 * * *', enabled: false });
    await svc1.onModuleDestroy(); // 旧进程注销

    const reg2 = new SchedulerRegistry();
    const svc2 = new ScheduledTaskService(db, reg2);
    await svc2.onModuleInit(); // 模拟重启恢复
    expect(reg2.doesExist('cron', `jz_sched_${t1.id}`)).toBe(true);
    expect(reg2.doesExist('cron', `jz_sched_${t2.id}`)).toBe(false); // disabled 不恢复
  });

  it('删除任务 → job 同步移除；get 不存在 → 404', async () => {
    const db = makeDb();
    const reg = new SchedulerRegistry();
    const svc = new ScheduledTaskService(db, reg);
    const task = await svc.create(VALID);
    await svc.remove(task.id);
    expect(reg.doesExist('cron', `jz_sched_${task.id}`)).toBe(false);
    await expect(svc.get(task.id)).resolves.toBeUndefined();
    await expect(svc.update('nope', { cron: '0 0 * * *' })).rejects.toThrow(NotFoundException);
  });

  it('onModuleDestroy 注销全部 jz_sched_* job', async () => {
    const db = makeDb();
    const reg = new SchedulerRegistry();
    const svc = new ScheduledTaskService(db, reg);
    await svc.create(VALID);
    await svc.create({ ...VALID, name: 'b' });
    await svc.onModuleDestroy();
    expect(reg.getCronJobs().size).toBe(0);
  });
});
