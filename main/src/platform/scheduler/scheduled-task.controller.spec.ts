/**
 * T2.5 单测：ScheduledTaskController 权限边界 + 创建校验 + 手动触发 + runs 分页。
 */
import { Reflector } from '@nestjs/core';
import { BadRequestException } from '@nestjs/common';
import { ScheduledTaskController } from './scheduled-task.controller';
import { PERMISSIONS_KEY } from '../authz/require-permission.decorator';

const adminReq = { user: { id: 'admin1' } };

function makeCtx(opts: {
  canView?: boolean; userExists?: boolean; agentExists?: boolean;
  runs?: any[]; runsTotal?: number;
} = {}) {
  const tasks = {
    validateCron: jest.fn((expr: string) => {
      if (expr === 'bad') throw new BadRequestException('非法 cron 表达式');
      return { nextRuns: [new Date()] };
    }),
    get: jest.fn(async (id: string) => (id === 't1' ? { id: 't1', name: 'x' } : undefined)),
    create: jest.fn(async (input: any) => ({ id: 'new1', ...input })),
    update: jest.fn(async (id: string, patch: any) => ({ id, ...patch })),
    remove: jest.fn(async () => {}),
    setEnabled: jest.fn(async (id: string, enabled: boolean) => ({ id, enabled })),
    list: jest.fn(async () => []),
  } as any;
  const runner = { runTask: jest.fn(async () => 42) } as any;
  const access = { canView: jest.fn(async () => opts.canView ?? true) } as any;
  const agentRegistry = { get: jest.fn((id: string) => (opts.agentExists === false ? undefined : { id })) } as any;
  const skillRegistry = { get: jest.fn((id: string) => ({ id })) } as any;
  const db = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM jz_users u LEFT JOIN jz_roles')) {
        return (opts.userExists === false) ? { rows: [] } : { rows: [{ id: params[0], role_id: 'user', permissions: [] }] };
      }
      if (sql.includes('jz_department_members')) return { rows: [] };
      if (sql.includes('ORDER BY started_at DESC')) return { rows: opts.runs ?? [] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: opts.runsTotal ?? 0 }] };
      throw new Error('unexpected SQL: ' + sql);
    }),
  } as any;
  const ctrl = new ScheduledTaskController(tasks, runner, access, agentRegistry, skillRegistry, db);
  return { ctrl, tasks, runner, access, agentRegistry, skillRegistry, db };
}

const VALID_BODY = {
  name: 't', cron: '0 9 * * *', targetType: 'agent' as const,
  targetId: 'main', runAsUserId: 'u1',
};

describe('T2.5 ScheduledTaskController', () => {
  it('用例1：类级 + 7 端点全部 @RequireAdmin', () => {
    const r = new Reflector();
    expect(r.get(PERMISSIONS_KEY, ScheduledTaskController)).toEqual(['sys:admin']);
    const proto = ScheduledTaskController.prototype as any;
    for (const m of ['list', 'create', 'update', 'remove', 'run', 'toggle', 'runs']) {
      expect(r.get(PERMISSIONS_KEY, proto[m])).toBeUndefined(); // 类级继承，handler 级无覆盖
    }
  });

  it('用例2a：非法 cron → 400（validateCron 上抛），不落地', async () => {
    const { ctrl, tasks } = makeCtx();
    await expect(ctrl.create({ ...VALID_BODY, cron: 'bad' } as any, adminReq)).rejects.toThrow(BadRequestException);
    expect(tasks.create).not.toHaveBeenCalled();
  });

  it('用例2b：agent target 不存在 → 400；skill target 不存在 → 400', async () => {
    const { ctrl } = makeCtx({ agentExists: false });
    await expect(ctrl.create(VALID_BODY as any, adminReq)).rejects.toThrow('智能体 main 不存在');
    const c2 = makeCtx();
    c2.skillRegistry.get = jest.fn(() => undefined);
    await expect(c2.ctrl.create({ ...VALID_BODY, targetType: 'skill', targetId: 'ghost' } as any, adminReq))
      .rejects.toThrow('技能 ghost 不存在');
  });

  it('用例2c：run_as_user 不存在 → 400；无 canView → 400（不落地）', async () => {
    const c1 = makeCtx({ userExists: false });
    await expect(c1.ctrl.create(VALID_BODY as any, adminReq)).rejects.toThrow('run_as_user u1 不存在');
    const c2 = makeCtx({ canView: false });
    await expect(c2.ctrl.create(VALID_BODY as any, adminReq)).rejects.toThrow('无访问权限');
    expect(c2.tasks.create).not.toHaveBeenCalled();
    expect(c2.access.canView).toHaveBeenCalledWith('agent', 'main', expect.objectContaining({ userId: 'u1' }));
  });

  it('用例2d：校验全过 → create 落库（actor 传递）', async () => {
    const { ctrl, tasks } = makeCtx();
    const res = await ctrl.create(VALID_BODY as any, adminReq);
    expect(res.id).toBe('new1');
    expect(tasks.create).toHaveBeenCalledWith(VALID_BODY, 'admin1');
  });

  it('用例3：手动触发 → runner.runTask(id, manual)', async () => {
    const { ctrl, runner } = makeCtx();
    const res = await ctrl.run('t1');
    expect(res).toEqual({ success: true, runId: 42 });
    expect(runner.runTask).toHaveBeenCalledWith('t1', 'manual');
  });

  it('用例5：runs 分页（limit 上界 100 + total）', async () => {
    const { ctrl } = makeCtx({ runs: [{ id: 1 }, { id: 2 }], runsTotal: 57 });
    const res = await ctrl.runs('t1', '500', '0');
    expect(res.runs).toHaveLength(2);
    expect(res.total).toBe(57);
  });

  it('toggle：非布尔 enabled → 400；布尔 → setEnabled', async () => {
    const { ctrl, tasks } = makeCtx();
    await expect(ctrl.toggle('t1', {} as any)).rejects.toThrow(BadRequestException);
    await ctrl.toggle('t1', { enabled: false });
    expect(tasks.setEnabled).toHaveBeenCalledWith('t1', false);
  });

  it('update：任务不存在 → 400', async () => {
    const { ctrl } = makeCtx();
    await expect(ctrl.update('nope', { cron: '0 0 * * *' })).rejects.toThrow('不存在');
  });
});
