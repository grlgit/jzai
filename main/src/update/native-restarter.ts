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
const targetVersion = (process.argv[4] || '').trim(); // 本次 OTA 目标版本（可为空=未知）
const runDir = path.join(appDir, 'run');

const ts = () => new Date().toISOString();
const log = (m) => console.log(`[native-restarter] [${ts()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取版本串（诊断用，失败返回 null） */
function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'main', 'version.json'), 'utf8')).version || null;
  } catch { return null; }
}

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
  log(`═══ 原生 OTA 重启开始: appDir=${appDir} 旧main pid=${oldMainPid || '未知'} 升级前版本=${readVersion() || '未知'} 目标版本=${targetVersion || '未知'} ═══`);

  // 1. 终止旧 web/gateway（引用失效 chunk 的进程；gateway 顺带刷新）
  const t1 = Date.now();
  killByPidFile('gateway');
  killByPidFile('web');
  log(`步骤1 旧 web/gateway 终止完成 (${Date.now() - t1}ms)`);

  // 2. 等旧 main 退出（update.service spawn 本进程后 2s 内 process.exit）
  const t2 = Date.now();
  const deadline = Date.now() + 60000;
  while (oldMainPid && alive(oldMainPid) && Date.now() < deadline) {
    await sleep(500);
  }
  if (oldMainPid && alive(oldMainPid)) {
    log(`⚠ 旧 main (pid ${oldMainPid}) 60s 未退出，继续强制流程（可能端口冲突，见后续日志）`);
  } else {
    log(`步骤2 旧 main 已退出 (${Date.now() - t2}ms)`);
  }

  // 3. 确保三个端口全部释放（含孤儿监听者兜底）再拉起
  const t3 = Date.now();
  const env = loadEnv();
  const mainPort = Number(env.PORT || 1111);
  const webPort = Number(env.WEB_PORT || 8899);
  await ensurePortFree(mainPort, 'main');
  await ensurePortFree(3000, 'web');
  await ensurePortFree(webPort, 'gateway');
  log(`步骤3 端口释放确认完成 main:${mainPort} web:3000 gateway:${webPort} (${Date.now() - t3}ms)`);

  // 4. 按 start.sh 语义拉起全部进程
  const t4 = Date.now();
  startOne('main', path.join(appDir, 'main'), ['dist/main'], {});
  startOne('web', path.join(appDir, 'web'), ['server.js'], { PORT: '3000', HOSTNAME: '127.0.0.1' });
  startOne('gateway', appDir, ['gateway.js'], {
    NEXT_PORT: '3000',
    WEB_PORT: String(webPort),
  });
  log(`步骤4 main/web/gateway 已拉起 (${Date.now() - t4}ms)`);

  // 5. 健康检查：轮询 gateway 直到 HTTP 200（上限 90s），并核验版本号
  const t5 = Date.now();
  const http = require('http');
  const healthOk = await (async () => {
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${webPort}/api/setup/health`, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(2000, () => { req.destroy(); resolve(false); });
      });
      if (ok) return true;
      await sleep(1000);
    }
    return false;
  })();
  if (!healthOk) {
    log(`⚠ 步骤5 健康检查 90s 未通过 (gateway :${webPort})——服务可能未起，查 run/main.log run/web.log`);
  } else {
    const ver = readVersion();
    const verOk = !targetVersion || ver === targetVersion;
    log(`步骤5 健康检查通过 (${Date.now() - t5}ms)，当前版本=${ver || '未知'}${targetVersion ? ` 目标=${targetVersion} 核验=${verOk ? '一致 ✓' : '不一致 ⚠（疑似升级文件被覆盖或回滚，查 run/restart.log 与 main 启动日志）'}` : ''}`);
  }

  log('═══ 全部进程已重启，restarter 退出 ═══');
})().catch((err) => {
  console.error(`[native-restarter] [${ts()}] 失败: ${err?.message || err}`);
  console.error(`[native-restarter] [${ts()}] 请手动恢复: bash ${appDir}/stop.sh && bash ${appDir}/start.sh`);
  process.exitCode = 1;
});
