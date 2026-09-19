/**
 * CompanionServiceManager — PLAT-016 伴随服务托管单元测试。
 *
 * process 形态用真实 spawn（node -e 内联 HTTP 服务）走通：
 * 端口分配 → 健康门 → inject 注入 → 崩溃监管重启恢复 → 停止回收。
 * container 形态仅验证无 docker 环境时的明确错误（docker 可用路径走黑盒验收）。
 */
import { CompanionServiceManager } from './companion-service.manager';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const HEALTH_SERVER = `
const http = require('http');
http.createServer((q, s) => {
  if (q.url === '/health') { s.writeHead(200); s.end('ok'); }
  else { s.writeHead(200); s.end('ok'); }
}).listen({port}, '127.0.0.1');
`;

function makeManager() {
  const db = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  const logs = { append: jest.fn() };
  const manager = new CompanionServiceManager(db as any, logs as any);
  return { manager, db, logs };
}

const baseReq = (services: any[], resolvedConfig: Record<string, unknown> = {}) => ({
  appId: 'com.test.svc',
  shortName: 'svc-app',
  version: '1.0.0',
  installDir: '/tmp',
  services,
  resolvedConfig,
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('CompanionServiceManager · process 形态', () => {
  jest.setTimeout(30000);

  it('拉起 → 健康门 → inject 注入 → 停止回收', async () => {
    const { manager, db } = makeManager();
    const injected = await manager.startForApp(baseReq([{
      id: 'svcA', runtime: 'process', cwd: '.',
      command: [process.execPath, '-e', HEALTH_SERVER],
      health: { path: '/health', intervalSec: 0.2, timeoutSec: 10 },
      inject: { 'config.solverEndpoint': 'http://{host}:{port}/v1' },
    }]));
    const endpoint = injected.solverEndpoint as string;
    expect(endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    // 健康门已过：endpoint 实际可访问
    const base = endpoint.replace(/\/v1$/, '');
    const resp = await fetch(`${base}/health`);
    expect(resp.status).toBe(200);
    expect(manager.isDegraded('com.test.svc').degraded).toBe(false);
    expect(manager.listServices('com.test.svc')).toEqual([
      expect.objectContaining({ serviceId: 'svcA', status: 'healthy', restarts: 0 }),
    ]);

    await manager.stopForApp('com.test.svc', 'uninstall');
    expect(manager.listServices('com.test.svc')).toEqual([]);
    // 端口已释放
    await expect(fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    const events = db.query.mock.calls.map(c => c[1]?.[2]).filter(Boolean);
    expect(events).toContain('started');
    expect(events).toContain('stopped');
  });

  it('崩溃监管：进程被杀 → degraded → 自动重启恢复（endpoint 稳定）', async () => {
    const { manager, db } = makeManager();
    await manager.startForApp(baseReq([{
      id: 'svcB', runtime: 'process', cwd: '.',
      command: [process.execPath, '-e', HEALTH_SERVER],
      health: { path: '/health', intervalSec: 0.2, timeoutSec: 10 },
    }]));
    const before = manager.listServices('com.test.svc')[0];
    const handle = (manager as any).handles.get('com.test.svc/svcB');
    handle.child.kill('SIGKILL');

    // 等待监管标记 degraded
    let degradedSeen = false;
    for (let i = 0; i < 50 && !degradedSeen; i++) {
      await sleep(200);
      degradedSeen = manager.isDegraded('com.test.svc').degraded;
    }
    expect(degradedSeen).toBe(true);
    expect(manager.isDegraded('com.test.svc').reason).toContain('svcB');

    // 等待自动重启恢复
    let healthy = false;
    for (let i = 0; i < 50 && !healthy; i++) {
      await sleep(200);
      healthy = manager.listServices('com.test.svc')[0]?.status === 'healthy';
    }
    expect(healthy).toBe(true);
    const after = manager.listServices('com.test.svc')[0];
    expect(after.endpoint).toBe(before.endpoint); // 同一 host:port 重拉
    const resp = await fetch(`${after.endpoint}/health`);
    expect(resp.status).toBe(200);

    const events = db.query.mock.calls.map(c => c[1]?.[2]).filter(Boolean);
    expect(events).toContain('exited');
    expect(events).toContain('restarting');
    await manager.stopForApp('com.test.svc', 'test-done');
  });

  it('健康门超时 → 激活失败并回滚（无残留句柄）', async () => {
    const { manager } = makeManager();
    await expect(manager.startForApp(baseReq([{
      id: 'svcC', runtime: 'process', cwd: '.',
      // 服务监听错误端口：健康检查永远不过
      command: [process.execPath, '-e', `require('net').createServer().listen(1, '127.0.0.1'); setInterval(()=>{}, 60000);`],
      health: { path: '/health', intervalSec: 0.2, timeoutSec: 1 },
    }]))).rejects.toThrow('SERVICE_HEALTH_TIMEOUT');
    expect(manager.listServices('com.test.svc')).toEqual([]);
  });

  it('env {secret:*} 无法解析时明确失败', async () => {
    const { manager } = makeManager();
    await expect(manager.startForApp(baseReq([{
      id: 'svcD', runtime: 'process', cwd: '.',
      command: [process.execPath, '-e', HEALTH_SERVER],
      env: { SOLVER_API_KEY: '{secret:solverApiKey}' },
      health: { path: '/health', intervalSec: 0.2, timeoutSec: 2 },
    }], {}))).rejects.toThrow('SERVICE_SECRET_UNRESOLVED');
  });

  it('env {secret:*} 由 resolvedConfig 注入子进程环境', async () => {
    const { manager } = makeManager();
    await manager.startForApp(baseReq([{
      id: 'svcE', runtime: 'process', cwd: '.',
      command: [process.execPath, '-e', `
        if (process.env.SOLVER_API_KEY !== 's3cr3t') process.exit(3);
        ${HEALTH_SERVER}
      `],
      env: { SOLVER_API_KEY: '{secret:solverApiKey}' },
      health: { path: '/health', intervalSec: 0.2, timeoutSec: 10 },
    }], { solverApiKey: 's3cr3t' }));
    expect(manager.isDegraded('com.test.svc').degraded).toBe(false);
    await manager.stopForApp('com.test.svc', 'test-done');
  });
});

describe('CompanionServiceManager · container 形态', () => {
  jest.setTimeout(15000);

  it('docker 不可用时给出明确错误（SERVICE_RUNTIME_UNAVAILABLE）', async () => {
    const { manager } = makeManager();
    // 用只含失败版 docker 的 PATH 模拟不可用（execvp 空 PATH 会回退系统默认路径，不可靠）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-docker-'));
    fs.writeFileSync(path.join(dir, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = dir;
    try {
      await expect(manager.startForApp(baseReq([{
        id: 'svcF', runtime: 'container', cwd: '.', image: 'img:1', containerPort: 8100,
        health: { path: '/health', intervalSec: 0.2, timeoutSec: 1 },
      }]))).rejects.toThrow('SERVICE_RUNTIME_UNAVAILABLE');
    } finally {
      process.env.PATH = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
