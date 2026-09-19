/**
 * CompanionServiceManager —— 伴随服务托管（PLAT-016）。
 *
 * APP manifest.services[] 声明的长驻服务制品（求解器/推理服务/协议适配器等），
 * 由平台在激活时拉起、健康检查门控、运行期监管（崩溃重启+降级标记），并随
 * deactivate/upgrade/uninstall 回收。制品是 APP 包内容，不进标准产品；
 * 本管理器是平台通用机制，不含任何特定服务内容。
 *
 * 形态：
 * - process：平台运行环境已含依赖时直接 spawn（loopback 自动分配端口，最小环境变量）；
 * - container：docker 可用时以包内 Dockerfile 构建或指定镜像跑 sidecar 容器，
 *   加入平台所在网络（JIANZHI_COMPANION_NETWORK 或自动探测），经容器名互访。
 *
 * 模板变量（command/env/inject 中）：{port}（process=分配端口，container=containerPort）、
 * {host}（process=127.0.0.1，container=容器名）。env 值 {secret:<key>} 用激活时
 * resolveConfig 的结果替换（复用 PLAT-005 credential store 语义，不落库）。
 *
 * 健康语义：
 * - 激活门：health.path 轮询至 timeoutSec，未过则激活失败（install 走清理路径）；
 * - 运行期：poller 周期性探测，失败→degraded（工具/invoke 入口拒绝，APP_SERVICE_UNHEALTHY）
 *   →按指数退避重启（maxRestarts 上限）→恢复→healthy；连续失败耗尽后保持 degraded。
 */
import { Injectable, Logger } from '@nestjs/common';
import { spawn, ChildProcess, execFile } from 'child_process';
import { promisify } from 'util';
import * as net from 'net';
import * as path from 'path';
import { DbService } from '../../../db/db.service';
import { AppLogService } from '../services/app-log.service';
import { AppManifest } from '../validators/manifest.schema';

const execFileAsync = promisify(execFile);

type ServiceDecl = NonNullable<AppManifest['services']>[number];

export interface CompanionStatus {
  serviceId: string;
  runtime: 'process' | 'container';
  status: 'starting' | 'healthy' | 'degraded' | 'stopped';
  detail?: string;
  endpoint?: string;
  restarts: number;
}

interface Handle {
  appId: string;
  decl: ServiceDecl;
  shortName: string;
  version: string;
  installDir: string;
  env: Record<string, string>;
  status: CompanionStatus['status'];
  detail?: string;
  host: string;
  port: number;
  endpoint: string;
  restarts: number;
  child?: ChildProcess;
  containerName?: string;
  runArgs?: string[];
  poller?: NodeJS.Timeout;
  stopping?: boolean;
  restarting?: boolean;
}

export interface StartRequest {
  appId: string;
  shortName: string;
  version: string;
  installDir: string;
  services: ServiceDecl[];
  /** 激活时 resolveConfig 的结果（secret 已解析为内存真值） */
  resolvedConfig: Record<string, unknown>;
}

@Injectable()
export class CompanionServiceManager {
  private readonly logger = new Logger(CompanionServiceManager.name);
  private readonly handles = new Map<string, Handle>(); // key = appId/serviceId
  private readonly injected = new Map<string, Record<string, unknown>>(); // appId → config 注入值
  private dockerOk?: boolean;
  private companionNet?: string;

  constructor(
    private readonly db: DbService,
    private readonly logBuffer: AppLogService,
  ) {}

  /** 激活入口：拉起全部声明服务（任一失败→回滚已拉起者并抛错），返回 config 注入值 */
  async startForApp(req: StartRequest): Promise<Record<string, unknown>> {
    const started: Handle[] = [];
    try {
      for (const decl of req.services ?? []) {
        started.push(await this.startOne(req, decl));
      }
    } catch (err) {
      for (const h of started.reverse()) {
        await this.stopOne(h, 'activate-rollback').catch(() => {});
      }
      throw err;
    }
    const injected: Record<string, unknown> = {};
    for (const h of started) {
      for (const [key, tpl] of Object.entries(h.decl.inject ?? {})) {
        injected[key.replace(/^config\./, '')] = this.render(tpl, h);
      }
    }
    this.injected.set(req.appId, injected);
    return injected;
  }

  /** 停用/升级/卸载回收：幂等 */
  async stopForApp(appId: string, reason: string): Promise<void> {
    const mine = [...this.handles.values()].filter(h => h.appId === appId);
    for (const h of mine) {
      await this.stopOne(h, reason).catch(err =>
        this.logger.warn(`stop ${h.decl.id} failed: ${err.message}`));
    }
    this.injected.delete(appId);
  }

  /** 工具/invoke 守卫：运行期健康丢失 → degraded */
  isDegraded(appId: string): { degraded: boolean; reason?: string } {
    for (const h of this.handles.values()) {
      if (h.appId === appId && h.status === 'degraded') {
        return { degraded: true, reason: `伴随服务 ${h.decl.id} 不健康：${h.detail ?? '未知原因'}` };
      }
    }
    return { degraded: false };
  }

  listServices(appId: string): CompanionStatus[] {
    return [...this.handles.values()]
      .filter(h => h.appId === appId)
      .map(h => ({
        serviceId: h.decl.id, runtime: h.decl.runtime, status: h.status,
        detail: h.detail, endpoint: h.endpoint, restarts: h.restarts,
      }));
  }

  // ────────────────────────── 启动 ──────────────────────────

  private async startOne(req: StartRequest, decl: ServiceDecl): Promise<Handle> {
    const key = `${req.appId}/${decl.id}`;
    this.handles.delete(key); // 防御：重复激活不留旧柄
    const env = this.buildEnv(decl, req.resolvedConfig);
    const h: Handle = {
      appId: req.appId, decl, shortName: req.shortName, version: req.version,
      installDir: req.installDir, env,
      status: 'starting', host: '', port: 0, endpoint: '', restarts: 0,
    };
    this.handles.set(key, h);

    try {
      if (decl.runtime === 'process') {
        h.host = '127.0.0.1';
        h.port = await this.allocatePort();
        this.spawnProcess(h);
      } else {
        await this.ensureDocker();
        h.containerName = `jzsvc-${req.shortName}-${decl.id}`;
        const image = decl.image ?? await this.buildImage(h);
        h.host = h.containerName;
        h.port = decl.containerPort!;
        h.runArgs = await this.containerRunArgs(h, image);
        await this.docker(['rm', '-f', h.containerName]).catch(() => {});
        await this.docker(h.runArgs);
      }
      h.endpoint = `http://${h.host}:${h.port}`;
      await this.waitHealthy(h);
    } catch (err) {
      // 启动失败必须自清：句柄已在 map 中，调用方的回滚只覆盖已成功返回的服务
      h.stopping = true;
      if (h.poller) clearInterval(h.poller);
      if (h.child && !h.child.killed) h.child.kill('SIGKILL');
      if (h.containerName) await this.docker(['rm', '-f', h.containerName], 30000).catch(() => {});
      this.handles.delete(key);
      await this.emit(h, 'start_failed', { detail: (err as Error).message }).catch(() => {});
      throw err;
    }
    h.status = 'healthy';
    await this.emit(h, 'started', { endpoint: h.endpoint, runtime: h.decl.runtime });
    this.startPoller(h);
    this.logBuffer.append(req.appId, 'log', `[service:${decl.id}] up at ${h.endpoint} (${decl.runtime})`);
    return h;
  }

  private buildEnv(decl: ServiceDecl, resolvedConfig: Record<string, unknown>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(decl.env ?? {})) {
      const m = /^\{secret:([a-zA-Z][a-zA-Z0-9_]{0,31})\}$/.exec(v);
      if (m) {
        const secret = resolvedConfig[m[1]];
        if (secret == null) throw new Error(`SERVICE_SECRET_UNRESOLVED: ${decl.id} env ${k} 引用的 ${m[1]} 无值`);
        env[k] = String(secret);
      } else {
        env[k] = v;
      }
    }
    return env;
  }

  private render(tpl: string, h: Handle): string {
    return tpl.replaceAll('{port}', String(h.port)).replaceAll('{host}', h.host);
  }

  private allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const port = (srv.address() as net.AddressInfo).port;
        srv.close(() => resolve(port));
      });
    });
  }

  private spawnProcess(h: Handle): void {
    const decl = h.decl;
    const cmd = (decl.command ?? []).map(part => this.render(part, h));
    if (!cmd.length) throw new Error(`SERVICE_COMMAND_MISSING: ${decl.id}`);
    const cwd = path.join(h.installDir, decl.cwd);
    const child = spawn(cmd[0], cmd.slice(1), {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '/tmp',
        LANG: 'C.UTF-8',
        ...h.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    h.child = child;
    const pipe = (stream: NodeJS.ReadableStream, level: 'log' | 'warn') => {
      let buf = '';
      stream.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) this.logBuffer.append(h.appId, level, `[service:${decl.id}] ${line}`);
        }
      });
    };
    pipe(child.stdout!, 'log');
    pipe(child.stderr!, 'warn');
    child.on('exit', (code, signal) => {
      if (h.stopping) return;
      void this.onUnexpectedDown(h, `进程退出 code=${code} signal=${signal}`);
    });
  }

  // ────────────────────────── docker ──────────────────────────

  private async ensureDocker(): Promise<void> {
    if (this.dockerOk) return;
    try {
      await this.docker(['version', '--format', '{{.Server.Version}}']);
      this.dockerOk = true;
    } catch (err: any) {
      throw new Error(
        'SERVICE_RUNTIME_UNAVAILABLE: runtime=container 需要实例内可用的 docker（socket+CLI），' +
        `当前不可用（${err.message}）。请在部署中为平台容器挂载 /var/run/docker.sock 并安装 docker CLI。`);
    }
  }

  private docker(args: string[], timeoutMs = 60000): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }) as any;
  }

  /** 伴随容器加入平台所在网络：显式环境变量优先，否则反查自身容器（hostname 与容器名可能不同） */
  private async companionNetwork(): Promise<string> {
    if (this.companionNet) return this.companionNet;
    if (process.env.JIANZHI_COMPANION_NETWORK) {
      this.companionNet = process.env.JIANZHI_COMPANION_NETWORK;
      return this.companionNet;
    }
    const selfHostname = process.env.HOSTNAME ?? '';
    try {
      // 先按 HOSTNAME 直接试（多数部署容器名==hostname）
      const names = [selfHostname];
      try {
        const { stdout } = await this.docker(['ps', '--format', '{{.Names}}']);
        names.push(...stdout.trim().split('\n').filter(n => n && n !== selfHostname));
      } catch {}
      for (const name of names) {
        if (!name) continue;
        try {
          const { stdout } = await this.docker([
            'inspect', name, '--format',
            '{{.Config.Hostname}}|{{range $k, $_ := .NetworkSettings.Networks}}{{$k}} {{end}}',
          ]);
          const [hostname, networks] = stdout.trim().split('|');
          if (hostname === selfHostname && networks?.trim()) {
            this.companionNet = networks.trim().split(/\s+/)[0];
            return this.companionNet;
          }
        } catch { /* 下一个候选 */ }
      }
      throw new Error(`no container matches HOSTNAME=${selfHostname}`);
    } catch (err: any) {
      throw new Error(
        'SERVICE_RUNTIME_UNAVAILABLE: 无法探测平台容器所在 docker 网络' +
        `（${err.message}）。请设 JIANZHI_COMPANION_NETWORK 显式指定。`);
    }
  }

  private async buildImage(h: Handle): Promise<string> {
    const tag = `jzsvc-${h.shortName}-${h.decl.id}:${h.version}`;
    const context = path.join(h.installDir, h.decl.cwd);
    this.logBuffer.append(h.appId, 'log', `[service:${h.decl.id}] docker build ${tag} ...`);
    await this.docker(['build', '-q', '-t', tag, context], 600000);
    return tag;
  }

  private async containerRunArgs(h: Handle, image: string): Promise<string[]> {
    const network = await this.companionNetwork();
    const args = ['run', '-d', '--name', h.containerName!, '--network', network, '--restart', 'no'];
    if (h.decl.resources?.cpuMillis) args.push('--cpus', String(h.decl.resources.cpuMillis / 1000));
    if (h.decl.resources?.memoryMb) args.push('--memory', `${h.decl.resources.memoryMb}m`);
    for (const [k, v] of Object.entries(h.env)) args.push('-e', `${k}=${this.render(v, h)}`);
    args.push(image);
    if (h.decl.command?.length) args.push(...h.decl.command.map(part => this.render(part, h)));
    return args;
  }

  // ────────────────────────── 健康与监管 ──────────────────────────

  private async probe(h: Handle): Promise<{ ok: boolean; detail?: string }> {
    const healthPath = h.decl.health?.path ?? '/health';
    try {
      const resp = await fetch(`${h.endpoint}${healthPath}`, { signal: AbortSignal.timeout(3000) });
      return resp.status < 500
        ? { ok: true }
        : { ok: false, detail: `HTTP ${resp.status}` };
    } catch (err: any) {
      return { ok: false, detail: err.message };
    }
  }

  private async waitHealthy(h: Handle): Promise<void> {
    const timeoutSec = h.decl.health?.timeoutSec ?? 60;
    const intervalSec = h.decl.health?.intervalSec ?? 5;
    const deadline = Date.now() + timeoutSec * 1000;
    let last = '未响应';
    while (Date.now() < deadline) {
      const r = await this.probe(h);
      if (r.ok) return;
      last = r.detail ?? last;
      await new Promise(res => setTimeout(res, intervalSec * 1000));
    }
    h.status = 'degraded';
    h.detail = last;
    throw new Error(
      `SERVICE_HEALTH_TIMEOUT: 伴随服务 ${h.decl.id} 健康检查 ${timeoutSec}s 内未通过（${h.endpoint}${h.decl.health?.path ?? '/health'}: ${last}）`);
  }

  private startPoller(h: Handle): void {
    const intervalSec = h.decl.health?.intervalSec ?? 5;
    h.poller = setInterval(() => void this.healthTick(h), intervalSec * 1000);
    h.poller.unref();
  }

  private async healthTick(h: Handle): Promise<void> {
    if (h.stopping || h.restarting || h.status === 'stopped') return;
    const r = await this.probe(h);
    if (r.ok) {
      if (h.status === 'degraded') {
        h.status = 'healthy';
        h.detail = undefined;
        h.restarts = 0;
        await this.emit(h, 'recovered', { endpoint: h.endpoint });
        this.logBuffer.append(h.appId, 'log', `[service:${h.decl.id}] recovered at ${h.endpoint}`);
      }
      return;
    }
    if (h.status === 'healthy') {
      h.status = 'degraded';
      h.detail = r.detail;
      await this.emit(h, 'unhealthy', { detail: r.detail });
      this.logBuffer.append(h.appId, 'warn', `[service:${h.decl.id}] unhealthy: ${r.detail}`);
    }
    await this.attemptRestart(h, r.detail ?? '健康检查失败');
  }

  private async onUnexpectedDown(h: Handle, detail: string): Promise<void> {
    if (h.stopping || h.status === 'stopped') return;
    if (h.status !== 'degraded') {
      h.status = 'degraded';
      h.detail = detail;
      await this.emit(h, 'exited', { detail });
      this.logBuffer.append(h.appId, 'warn', `[service:${h.decl.id}] ${detail}`);
    }
    await this.attemptRestart(h, detail);
  }

  private async attemptRestart(h: Handle, reason: string): Promise<void> {
    if (h.restarting || h.stopping) return;
    const max = h.decl.maxRestarts ?? 5;
    if (h.restarts >= max) {
      if (h.restarts === max) {
        h.restarts++;
        await this.emit(h, 'restart_exhausted', { maxRestarts: max, reason });
        this.logBuffer.append(h.appId, 'error', `[service:${h.decl.id}] 重启次数耗尽（${max}），保持 degraded`);
      }
      return;
    }
    h.restarting = true;
    h.restarts++;
    const backoffMs = Math.min(1000 * 2 ** (h.restarts - 1), 30000);
    await new Promise(res => setTimeout(res, backoffMs));
    try {
      await this.emit(h, 'restarting', { attempt: h.restarts, reason });
      this.logBuffer.append(h.appId, 'log', `[service:${h.decl.id}] restart #${h.restarts}: ${reason}`);
      if (h.decl.runtime === 'process') {
        this.spawnProcess(h); // 同一 host:port 重拉，endpoint 稳定
      } else {
        await this.docker(['start', h.containerName!]).catch(async () => {
          await this.docker(h.runArgs!); // 容器已消失 → 重新 run
        });
      }
      await this.waitHealthy(h);
      h.status = 'healthy';
      h.detail = undefined;
      h.restarts = 0;
      await this.emit(h, 'recovered', { endpoint: h.endpoint, afterRestarts: true });
      this.logBuffer.append(h.appId, 'log', `[service:${h.decl.id}] restart succeeded`);
    } catch (err: any) {
      h.status = 'degraded';
      h.detail = err.message;
      await this.emit(h, 'restart_failed', { attempt: h.restarts, detail: err.message });
    } finally {
      h.restarting = false;
    }
  }

  // ────────────────────────── 停止 ──────────────────────────

  private async stopOne(h: Handle, reason: string): Promise<void> {
    h.stopping = true;
    if (h.poller) clearInterval(h.poller);
    if (h.decl.runtime === 'process') {
      const child = h.child;
      if (child && !child.killed) {
        child.kill('SIGTERM');
        const exited = await Promise.race([
          new Promise<boolean>(res => child.once('exit', () => res(true))),
          new Promise<boolean>(res => setTimeout(() => res(false), 5000)),
        ]);
        if (!exited) child.kill('SIGKILL');
      }
    } else if (h.containerName) {
      await this.docker(['rm', '-f', h.containerName], 30000).catch(() => {});
    }
    h.status = 'stopped';
    this.handles.delete(`${h.appId}/${h.decl.id}`);
    await this.emit(h, 'stopped', { reason });
    this.logBuffer.append(h.appId, 'log', `[service:${h.decl.id}] stopped (${reason})`);
  }

  private async emit(h: Handle, event: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO jz_app_service_events (app_id, service_id, event, detail) VALUES ($1,$2,$3,$4)`,
        [h.appId, h.decl.id, event, JSON.stringify(detail)]);
    } catch (err: any) {
      this.logger.warn(`service event persist failed (${h.appId}/${h.decl.id}/${event}): ${err.message}`);
    }
  }
}
