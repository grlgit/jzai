/**
 * JianZhi Bridge Plugin for OpenClaw
 *
 * Connects an OpenClaw instance to the JianZhi main platform.
 * Responsibilities:
 * 1. Heartbeat reporting (keep-alive)
 * 2. Config hot-reload (watch for admin changes)
 * 3. Message sync (forward channel messages to main platform)
 * 4. MCP tool proxy (access main platform's KB tools)
 */

import { io, Socket } from 'socket.io-client';

interface BridgeConfig {
  mainUrl: string;
  token: string;
  coworkerId: string;
  reportInterval: number;
  configCheckInterval: number;
}

interface PendingMessage {
  channel: string;
  direction: 'in' | 'out';
  content: string;
  metadata?: Record<string, any>;
  createdAt: string;
}

export class JianZhiBridge {
  private config: BridgeConfig;
  private socket: Socket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private configCheckTimer: ReturnType<typeof setInterval> | null = null;
  private reportTimer: ReturnType<typeof setInterval> | null = null;
  private pendingMessages: PendingMessage[] = [];
  private pendingEvents: Array<{ type: string; payload: any }> = [];
  private currentConfigVersion = 0;
  private onConfigUpdate: ((data: { version: number; yaml?: string; json?: string; soul?: string }) => void) | null = null;

  constructor(config: BridgeConfig) {
    this.config = config;
    // mainUrl 可能带尾部斜杠；统一去掉，避免构造出 //ws/coworker 导致 Invalid namespace。
    if (this.config.mainUrl && this.config.mainUrl.endsWith('/')) {
      this.config.mainUrl = this.config.mainUrl.slice(0, -1);
    }
  }

  /**
   * Start the bridge: connect WebSocket, start timers.
   */
  start(callbacks?: { onConfigUpdate?: (data: { version: number; yaml?: string; json?: string; soul?: string }) => void }) {
    this.onConfigUpdate = callbacks?.onConfigUpdate || null;

    // Connect via WebSocket
    const connectUrl = `${this.config.mainUrl}/ws/coworker`;
    console.log(`[jianzhi-bridge] Connecting to ${connectUrl}, coworkerId=${this.config.coworkerId}, tokenPrefix=${this.config.token ? this.config.token.slice(0, 6) : 'empty'}`);
    this.socket = io(connectUrl, {
      auth: {
        token: this.config.token,
        coworkerId: this.config.coworkerId,
      },
      reconnection: true,
      reconnectionDelay: 5000,
      reconnectionAttempts: Infinity,
    });

    this.socket.on('connect', () => {
      console.log(`[jianzhi-bridge] Connected to main platform, socket.id=${this.socket?.id}`);
    });

    this.socket.on('connect_error', (err: any) => {
      console.error(`[jianzhi-bridge] Connect error: ${err?.message || err}`);
    });

    this.socket.on('cw.registered', (data: { assignmentId: string; configVersion: number }) => {
      console.log(`[jianzhi-bridge] Registered: assignment=${data.assignmentId}, server v${data.configVersion}`);
      // 不从 cw.registered 同步版本号——服务端注册时会主动推送完整配置（cw.config.update）。
      // 保留本地版本（首次为 0），让首次 cw.config.check 轮询也触发推送（双保险）。
    });

    this.socket.on('cw.config.update', (data: { version: number; yaml?: string; json?: string; soul?: string }) => {
      console.log(`[jianzhi-bridge] Config update received: v=${data.version}, hasJson=${!!data.json}, hasYaml=${!!data.yaml}, hasSoul=${!!data.soul}, jsonLength=${data.json?.length || 0}`);
      this.currentConfigVersion = data.version;
      if (this.onConfigUpdate) {
        try {
          this.onConfigUpdate(data);
          console.log(`[jianzhi-bridge] Config update v=${data.version} applied successfully`);
        } catch (err: any) {
          console.error(`[jianzhi-bridge] Config update v=${data.version} apply callback failed: ${err?.message}`);
        }
      } else {
        console.warn('[jianzhi-bridge] Config update received but no onConfigUpdate callback registered');
      }
    });

    this.socket.on('cw.chat.send', (data: { content: string; from: string }) => {
      console.log(`[jianzhi-bridge] Chat from ${data.from}: ${data.content.slice(0, 50)}`);
      // This would be handled by the gateway/agent system
    });

    this.socket.on('cw.error', (data: { error: string; code?: string }) => {
      console.error(`[jianzhi-bridge] Error: ${data.error}`);
      // Terminal failures: retrying with the same dead credential never recovers.
      // The marker is parsed by the Electron shell to surface a re-activation prompt.
      if (data.code === 'CREDENTIAL_INVALID' || data.code === 'CREDENTIAL_MISMATCH') {
        console.error(`[jianzhi-bridge] CREDENTIAL_FAILURE ${data.code}: ${data.error}`);
        if (this.socket?.io?.opts) this.socket.io.opts.reconnection = false;
        this.socket?.disconnect();
      }
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log(`[jianzhi-bridge] Disconnected from main platform, reason=${reason}`);
    });

    // Start heartbeat (every 30s)
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('cw.heartbeat');
      }
    }, 30000);

    // Start config check (every 60s)
    this.configCheckTimer = setInterval(() => {
      if (this.socket?.connected) {
        this.socket.emit('cw.config.check', { currentVersion: this.currentConfigVersion });
      }
    }, this.config.configCheckInterval);

    // Start message/event batch reporting
    this.reportTimer = setInterval(() => this.flushReports(), this.config.reportInterval);
  }

  /**
   * Stop the bridge: disconnect, clear timers.
   */
  stop() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.configCheckTimer) clearInterval(this.configCheckTimer);
    if (this.reportTimer) clearInterval(this.reportTimer);
    this.flushReports(); // Final flush
    this.socket?.disconnect();
    this.socket = null;
  }

  /**
   * Queue a message for batch reporting to main platform.
   */
  queueMessage(msg: PendingMessage) {
    this.pendingMessages.push(msg);
  }

  /**
   * Queue an event for batch reporting.
   */
  queueEvent(type: string, payload: any = {}) {
    this.pendingEvents.push({ type, payload });
  }

  /**
   * Sync messages via WebSocket (real-time, for active admin viewers).
   */
  syncMessages(messages: PendingMessage[]) {
    if (this.socket?.connected) {
      this.socket.emit('cw.chat.sync', { messages });
    }
  }

  /**
   * Stream a chat response back to the admin/employee on main platform.
   */
  streamResponse(delta: string, done: boolean, targetUserId?: string) {
    if (this.socket?.connected) {
      this.socket.emit('cw.chat.stream', { delta, done, targetUserId });
    }
  }

  /**
   * Call an MCP tool via the main platform proxy.
   */
  async callMcpTool(name: string, args: Record<string, any> = {}): Promise<string> {
    // 使用 JSON-RPC MCP 端点；旧 /api/cw/mcp/tools/call 仅处理 KB 工具。
    const resp = await fetch(`${this.config.mainUrl}/api/cw/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.token}`,
        'X-Coworker-Id': this.config.coworkerId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });

    console.log(`[jianzhi-bridge] MCP tool call ${name} status=${resp.status}`);
    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`MCP tool ${name} failed: ${resp.status} ${err.slice(0, 200)}`);
    }

    const data = await resp.json();
    return data.result?.content || JSON.stringify(data);
  }

  /**
   * Flush pending messages and events to main platform via HTTP batch.
   */
  private async flushReports() {
    if (this.pendingMessages.length > 0) {
      const messages = this.pendingMessages.splice(0);
      try {
        await fetch(`${this.config.mainUrl}/api/cw/report/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.token}`,
            'X-Coworker-Id': this.config.coworkerId,
          },
          body: JSON.stringify({ messages }),
        });
      } catch (err) {
        // Re-queue on failure
        this.pendingMessages.unshift(...messages);
        console.error('[jianzhi-bridge] Message report failed, will retry');
      }
    }

    if (this.pendingEvents.length > 0) {
      const events = this.pendingEvents.splice(0);
      try {
        await fetch(`${this.config.mainUrl}/api/cw/report/events`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.config.token}`,
            'X-Coworker-Id': this.config.coworkerId,
          },
          body: JSON.stringify({ events }),
        });
      } catch (err) {
        this.pendingEvents.unshift(...events);
        console.error('[jianzhi-bridge] Event report failed, will retry');
      }
    }
  }
}

/**
 * OpenClaw Plugin Entry Point — wired to the real OpenClaw plugin SDK.
 *
 * Contract (verified against openclaw src):
 * - Loader reads the default export's `register`/`activate`; we export `{ id, register }`.
 * - Config comes from `api.pluginConfig` (plugins.entries['jianzhi-bridge'].config) with env fallback.
 * - Agent events come via `api.registerAgentEventSubscription({ streams, handle })`.
 * - Main-platform TOOLS are exposed to OpenClaw via `mcp.servers.jianzhi-kb` config, NOT here.
 *
 * Deliberately no runtime import from openclaw/plugin-sdk — only type-shaped locals — so the
 * bundle is self-contained (esbuild only needs to inline socket.io-client).
 */

/** Minimal structural view of the OpenClaw plugin API surface this plugin uses. */
interface PluginApiLike {
  pluginConfig?: Record<string, unknown>;
  logger?: { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };
  registerAgentEventSubscription?: (sub: {
    id: string;
    description?: string;
    streams?: string[];
    handle: (
      event: { runId: string; seq: number; stream: string; ts: number; data: Record<string, unknown>; sessionKey?: string },
    ) => void | Promise<void>;
  }) => void;
  registerRuntimeLifecycle?: (hooks: { id: string; onShutdown?: () => void }) => void;
}

function isLegacyJwtToken(token?: string): token is string {
  return !!token && token.startsWith('eyJ');
}

function readBridgeConfig(api: PluginApiLike): BridgeConfig {
  const pc = (api.pluginConfig || {}) as Record<string, any>;
  const resolve = (val: string | undefined, envVar: string): string => {
    const envVal = process.env[envVar] || '';
    if (val && !val.startsWith('${') && !isLegacyJwtToken(val)) return val;
    return envVal;
  };
  return {
    mainUrl: resolve(pc.mainUrl, 'JIANZHI_MAIN_URL'),
    token: resolve(pc.token, 'JIANZHI_CW_TOKEN'),
    coworkerId: pc.coworkerId || process.env.JIANZHI_COWORKER_ID || '',
    reportInterval: Number(pc.reportInterval) || 30000,
    configCheckInterval: Number(pc.configCheckInterval) || 60000,
  };
}

function extractText(data: Record<string, unknown>): string {
  const d = data as any;
  if (typeof d?.text === 'string') return d.text;
  if (typeof d?.content === 'string') return d.content;
  if (typeof d?.message === 'string') return d.message;
  try { return JSON.stringify(data); } catch { return String(data); }
}

export function register(api: PluginApiLike) {
  const log = api.logger || console;
  log.info?.('[jianzhi-bridge] register() called');
  const config = readBridgeConfig(api);

  log.info?.(`[jianzhi-bridge] config resolved mainUrl=${config.mainUrl}, coworkerId=${config.coworkerId}, tokenPrefix=${config.token ? config.token.slice(0, 6) : 'empty'}, reportInterval=${config.reportInterval}, configCheckInterval=${config.configCheckInterval}`);

  if (!config.mainUrl || !config.token || !config.coworkerId) {
    log.warn?.('[jianzhi-bridge] Missing config (mainUrl/token/coworkerId), bridge disabled');
    return;
  }

  const bridge = new JianZhiBridge(config);

  // Config hot-reload apply side: write the pushed config to OpenClaw's watched config file;
  // OpenClaw's gateway config reloader picks it up automatically (no restart needed).
  bridge.start({
    onConfigUpdate: (data) => {
      log.info?.(`[jianzhi-bridge] onConfigUpdate fired, version=${data.version}, jsonLength=${data.json?.length || 0}, soulLength=${data.soul?.length || 0}`);
      if (!data.json) {
        log.warn?.('[jianzhi-bridge] config update had no json payload, skipping apply');
        return;
      }
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
        const configPath = path.join(stateDir, 'openclaw.json');
        log.info?.(`[jianzhi-bridge] applying config to ${configPath}, OPENCLAW_STATE_DIR=${process.env.OPENCLAW_STATE_DIR || '<unset>'}`);

        // Inject runtime secrets (OpenClaw does not expand ${ENV} placeholders).
        const injected = data.json
          .split('${JIANZHI_CW_TOKEN}').join(process.env.JIANZHI_CW_TOKEN || '')
          .split('${JIANZHI_MAIN_URL}').join(process.env.JIANZHI_MAIN_URL || '');
        const tokenReplaced = (data.json.match(/\$\{JIANZHI_CW_TOKEN\}/g) || []).length;
        const urlReplaced = (data.json.match(/\$\{JIANZHI_MAIN_URL\}/g) || []).length;
        log.info?.(`[jianzhi-bridge] placeholder replacement: JIANZHI_CW_TOKEN=${tokenReplaced}, JIANZHI_MAIN_URL=${urlReplaced}`);

        // 服务端下发的 workspace 是容器路径 /workspace；激活时已把真实宿主目录注入磁盘上的
        // openclaw.json。热更新必须保留该真实目录，否则会把 workspace 打回 /workspace。
        // 同理保留 gateway.auth.token（客户端注入，服务端配置不含）—— 否则热更新会清掉
        // gateway token，下一次 WS 连接就是 token_mismatch。
        // 还要保留 meta，否则 OpenClaw 会认为配置被外部篡改并触发 missing-meta-vs-last-good 自动恢复。
        let workspace = '';
        let gatewayAuth: any = undefined;
        let meta: any = undefined;
        let prevExists = false;
        try {
          const prev = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
          prevExists = true;
          workspace = prev?.agents?.defaults?.workspace || '';
          gatewayAuth = prev?.gateway?.auth;
          meta = prev?.meta;
          log.info?.(`[jianzhi-bridge] previous config read ok, workspace=${workspace}, hasGatewayAuth=${!!gatewayAuth}, hasMeta=${!!meta}`);
        } catch (e: any) {
          log.info?.(`[jianzhi-bridge] previous config read failed (first apply?): ${e?.message}`);
        }

        let toWrite = injected;
        if (workspace || gatewayAuth || meta) {
          try {
            const next = JSON.parse(injected);
            if (next && workspace && next.agents?.defaults) {
              next.agents.defaults.workspace = workspace;
            }
            if (next && gatewayAuth) {
              if (!next.gateway) next.gateway = {};
              next.gateway.auth = gatewayAuth;
            }
            if (next && meta) {
              next.meta = meta;
            }
            toWrite = JSON.stringify(next, null, 2);
            log.info?.('[jianzhi-bridge] preserved workspace, gateway.auth and meta in updated config');
          } catch (parseErr: any) {
            log.warn?.(`[jianzhi-bridge] failed to merge workspace/gateway.auth/meta, writing raw injected config: ${parseErr?.message}`);
          }
        }

        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(configPath, toWrite, 'utf-8');
        const writtenStat = fs.statSync(configPath);
        log.info?.(`[jianzhi-bridge] config v${data.version} applied to ${configPath} (${writtenStat.size} bytes, prevExists=${prevExists})`);

        // 人格热更新：写入 workspace 根目录的 SOUL.md（管理台是唯一来源，覆盖写入）。
        const soul = typeof data.soul === 'string' ? data.soul.trim() : '';
        if (workspace && soul) {
          const soulPath = path.join(workspace, 'SOUL.md');
          let changed = true;
          try { changed = fs.readFileSync(soulPath, 'utf-8') !== soul; } catch { /* 不存在 */ }
          if (changed) {
            fs.mkdirSync(workspace, { recursive: true });
            fs.writeFileSync(soulPath, soul, 'utf-8');
            log.info?.(`[jianzhi-bridge] soul v${data.version} written to ${soulPath} (${soul.length} chars)`);
          } else {
            log.info?.(`[jianzhi-bridge] soul v${data.version} unchanged, skipping write`);
          }
        } else {
          log.info?.(`[jianzhi-bridge] no soul to write (workspace=${!!workspace}, soulLength=${soul.length})`);
        }
      } catch (err: any) {
        log.error?.(`[jianzhi-bridge] config apply failed: ${err?.message}`);
      }
    },
  });

  // Audit: forward agent events (assistant output, tool calls, errors, lifecycle) to 见智.
  api.registerAgentEventSubscription?.({
    id: 'jianzhi-audit',
    description: 'Forward agent events to JianZhi main platform for audit',
    streams: ['assistant', 'tool', 'error', 'lifecycle'],
    handle: (event) => {
      const text = extractText(event.data || {});
      log.info?.(`[jianzhi-bridge] agent event stream=${event.stream} runId=${event.runId} seq=${event.seq} len=${text.length}`);
      const msg = {
        channel: event.sessionKey || 'agent',
        direction: (event.stream === 'assistant' ? 'out' : 'in') as 'in' | 'out',
        content: text,
        metadata: { stream: event.stream, runId: event.runId, seq: event.seq },
        createdAt: new Date(event.ts || Date.now()).toISOString(),
      };
      bridge.queueMessage(msg);
      bridge.syncMessages([msg]);
    },
  });

  // Cleanup on shutdown. id 是必填的，缺失时 registry 会丢弃这次注册。
  api.registerRuntimeLifecycle?.({ id: 'jianzhi-bridge-lifecycle', onShutdown: () => { log.info?.('[jianzhi-bridge] shutdown lifecycle triggered'); bridge.stop(); } });

  log.info?.(`[jianzhi-bridge] registered successfully, reporting to ${config.mainUrl}`);
}

// Default export: the loader reads `def.register ?? def.activate`.
export default { id: 'jianzhi-bridge', register };
