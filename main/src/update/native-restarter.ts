// @ts-nocheck
/**
 * 原生部署 OTA 自重启器（独立进程，由 UpdateService 在升级完成后 spawn）。
 *
 * 背景：update.service 应用差量后 process.exit(0) 只会退出 main；
 * Docker 形态靠容器入口 wait -n 整组重启，但原生形态（start.sh 拉起的
 * 独立进程）没有监督——main 死了没人拉，web 旧进程内存里仍引用已被
 * 差量删除的旧 chunk（404 白屏）。
 *
 * 本进程职责：杀 web/gateway → 等旧 main 退出释放端口 → 按 start.sh
 * 语义重新拉起 main/web/gateway（detached + pid/log 文件）→ 自行退出。
 *
 * 仅使用 node 内置模块，独立编译为 dist/update/native-restarter.js。
 * 用法: node native-restarter.js <appDir> <oldMainPid>
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const appDir = process.argv[2];
const oldMainPid = Number(process.argv[3] || 0);
const runDir = path.join(appDir, 'run');

const log = (m) => console.log(`[native-restarter] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** 与 start.sh 一致：.env 覆盖进程环境（set -a; . ./.env 语义） */
function loadEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(path.join(appDir, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2];
    }
  } catch { /* 无 .env */ }
  return env;
}

function killByPidFile(name) {
  try {
    const pid = Number(fs.readFileSync(path.join(runDir, `${name}.pid`), 'utf8').trim());
    if (pid && alive(pid)) {
      process.kill(pid, 'SIGTERM');
      log(`${name} (pid ${pid}) 已终止`);
    }
  } catch { /* pid 文件缺失或进程已退出 */ }
  fs.rmSync(path.join(runDir, `${name}.pid`), { force: true });
}

/** 端口当前监听者 pid（lsof 不可用时返回 0 表示"无法判定"，按已释放处理） */
function listenerPid(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
    return out ? Number(out.split('\n')[0]) || 0 : 0;
  } catch { return 0; }
}

/**
 * 确保端口释放：pid 文件记的是 launcher，而 Next standalone 真正监听的是其
 * fork 出的 next-server 子进程（Linux/macOS 同行为）——SIGTERM launcher 后 worker
 * 可能成孤儿继续占口。先等自行释放，超时后按监听者 SIGKILL 兜底，防新进程 EADDRINUSE。
 */
async function ensurePortFree(port, name) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!listenerPid(port)) return;
    await sleep(300);
  }
  const pid = listenerPid(port);
  if (pid) {
    log(`${name} 端口 ${port} 仍被 pid ${pid} 占用（launcher 已死的遗留监听者），SIGKILL`);
    try { process.kill(pid, 'SIGKILL'); } catch { /* 竞态退出 */ }
    const grace = Date.now() + 5000;
    while (Date.now() < grace && listenerPid(port)) await sleep(300);
  }
}

function startOne(name, cwd, args, extraEnv) {
  const out = fs.openSync(path.join(runDir, `${name}.log`), 'a');
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...loadEnv(), ...extraEnv },
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  });
  child.unref();
  fs.writeFileSync(path.join(runDir, `${name}.pid`), String(child.pid));
  log(`${name} 已启动 (pid ${child.pid}) → run/${name}.log`);
}

(async () => {
  fs.mkdirSync(runDir, { recursive: true });

  // 1. 终止旧 web/gateway（引用失效 chunk 的进程；gateway 顺带刷新）
  killByPidFile('gateway');
  killByPidFile('web');

  // 2. 等旧 main 退出（update.service spawn 本进程后 2s 内 process.exit）
  const deadline = Date.now() + 60000;
  while (oldMainPid && alive(oldMainPid) && Date.now() < deadline) {
    await sleep(500);
  }

  // 3. 确保三个端口全部释放（含孤儿监听者兜底）再拉起
  const env = loadEnv();
  const mainPort = Number(env.PORT || 1111);
  const webPort = Number(env.WEB_PORT || 8899);
  await ensurePortFree(mainPort, 'main');
  await ensurePortFree(3000, 'web');
  await ensurePortFree(webPort, 'gateway');

  // 4. 按 start.sh 语义拉起全部进程
  startOne('main', path.join(appDir, 'main'), ['dist/main'], {});
  startOne('web', path.join(appDir, 'web'), ['server.js'], { PORT: '3000', HOSTNAME: '127.0.0.1' });
  startOne('gateway', appDir, ['gateway.js'], {
    NEXT_PORT: '3000',
    WEB_PORT: String(webPort),
  });

  log('全部进程已重启，restarter 退出');
})().catch((err) => {
  console.error(`[native-restarter] 失败: ${err?.message || err}`);
  process.exitCode = 1;
});
