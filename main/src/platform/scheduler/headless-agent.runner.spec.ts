/**
 * T2.4 单测：HeadlessAgentRunner（无人值守全链路 + confirm 自动应答）+ 会话前缀过滤。
 */
import * as fs from 'fs';
import * as path from 'path';
import { HeadlessAgentRunner } from './headless-agent.runner';
import { ConfirmationBridgeService } from '../../agent/support/confirmation-bridge.service';
import type { TaskRunnerService } from './task-runner.service';

function makeRunner(chunks: any[], opts: { onGen?: (gen: AsyncGenerator<any>) => void; finallyFlag?: { released: boolean } } = {}) {
  const calls: any[] = [];
  const dynamicAgent = {
    processMessage: jest.fn((...args: any[]) => {
      calls.push(args);
      async function* gen(): AsyncGenerator<any> {
        try {
          for (const c of chunks) yield c;
        } finally {
          if (opts.finallyFlag) opts.finallyFlag.released = true;
        }
      }
      const g = gen();
      opts.onGen?.(g);
      return g;
    }),
  } as any;
  const taskRunner = { registerAgentRunner: jest.fn() } as unknown as TaskRunnerService;
  const bridge = new ConfirmationBridgeService();
  const runner = new HeadlessAgentRunner(dynamicAgent, taskRunner, bridge);
  runner.onModuleInit();
  expect(taskRunner.registerAgentRunner).toHaveBeenCalled();
  const agentFn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0][0] as any;
  return { runner, calls, bridge, agentFn };
}

const baseTask: any = {
  id: 'task1', name: 't', enabled: true, cron: '0 9 * * *', timezone: 'Asia/Shanghai',
  targetType: 'agent', targetId: 'main', payload: { prompt: '生成晨报' },
  runAsUserId: 'u1', onConfirm: 'reject', timeoutSec: 300, maxRetries: 0,
};

describe('T2.4 HeadlessAgentRunner', () => {
  it('用例1：简单 prompt → success；output 为累积 text_delta；session_id 为 sched_*', async () => {
    const { agentFn } = makeRunner([
      { type: 'text_delta', text: '早上好，' },
      { type: 'tool_call', toolName: 'x' },
      { type: 'text_delta', text: '今日晨报如下。' },
      { type: 'done' },
    ]);
    const result = await agentFn(baseTask, 7);
    expect(result.sessionId).toBe('sched_task1_7');
    expect(result.output).toBe('早上好，今日晨报如下。');
  });

  it('processMessage 收到的 principal 为 system + origin=scheduler（P1 跳过过滤对拍）', async () => {
    const { calls, agentFn } = makeRunner([{ type: 'done' }]);
    await agentFn(baseTask, 1);
    const principal = calls[0][7];
    expect(principal.type).toBe('system');
    expect(principal.origin).toBe('scheduler');
    expect(principal.scopes).not.toContain('confirm:skip_tool'); // reject 模式
  });

  it('用例2：reject 模式——流内发起确认请求 → 自动拒绝（handleReply false），run 正常收尾不挂起', async () => {
    const bridge = new ConfirmationBridgeService();
    const handleSpy = jest.spyOn(bridge, 'handleReply');
    const taskRunner = { registerAgentRunner: jest.fn() } as unknown as TaskRunnerService;
    const dynamicAgent = {
      processMessage: jest.fn(() => (async function* () {
        yield { type: 'text_delta', text: '准备调用工具…' };
        try {
          await bridge.requestConfirmation({
            confirmId: 'c1', toolName: '危险工具', args: {}, parameters: [],
          });
          yield { type: 'text_delta', text: '[不应到达]' };
        } catch {
          yield { type: 'text_delta', text: '工具被拒绝，改用手动整理。' };
        }
        yield { type: 'done' };
      })()),
    } as any;
    const runner = new HeadlessAgentRunner(dynamicAgent, taskRunner, bridge);
    const agentFn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0]?.[0]
      ?? (() => runner.run(baseTask, 3));
    // onModuleInit 已注册则直接用注册的回调
    runner.onModuleInit();
    const fn = (taskRunner.registerAgentRunner as jest.Mock).mock.calls[0][0];
    const result = await fn(baseTask, 3);
    expect(handleSpy).toHaveBeenCalledWith('c1', false);
    expect(result.output).toContain('工具被拒绝');
    expect(result.output).not.toContain('[不应到达]');
  });

  it('用例3：skip_tool 模式——principal.scopes 含 confirm:skip_tool；reject 应答器未注册', async () => {
    const { calls, bridge, agentFn } = makeRunner([{ type: 'done' }]);
    const listenerBefore = bridge.events.listenerCount('confirm_request');
    await agentFn({ ...baseTask, onConfirm: 'skip_tool' }, 1);
    const principal = calls[0][7];
    expect(principal.scopes).toContain('confirm:skip_tool');
    expect(bridge.events.listenerCount('confirm_request')).toBe(listenerBefore); // 无残留监听
  });

  it('error chunk → run 拒绝且 generator 被显式释放（finally 执行）', async () => {
    const flag = { released: false };
    const { agentFn } = makeRunner(
      [{ type: 'text_delta', text: 'x' }, { type: 'error', error: '模型调用失败' }],
      { finallyFlag: flag },
    );
    await expect(agentFn(baseTask, 1)).rejects.toThrow('模型调用失败');
    expect(flag.released).toBe(true);
  });

  it('用例5：会话列表/计数/复用查询均排除 sched_ 前缀（静态断言）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../agent/session/session.service.ts'), 'utf-8');
    expect(src.match(/id NOT LIKE .*sched_%/g)!.length).toBeGreaterThanOrEqual(3);
    // 三处：getRecentSession（模板字符串）/ listSessions / countSessions（单行字符串转义引号）
    const recent = src.match(/getRecentSession[\s\S]*?LIMIT 1`/)![0];
    expect(recent).toContain("id NOT LIKE 'sched_%'");
    const list = src.match(/listSessions[\s\S]*?OFFSET \$4'/)![0];
    expect(list).toContain("id NOT LIKE \\'sched_%\\'");
    const count = src.match(/countSessions[\s\S]*?count, 10/)![0];
    expect(count).toContain("id NOT LIKE \\'sched_%\\'");
  });
});
