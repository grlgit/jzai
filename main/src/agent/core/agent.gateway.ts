import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect, MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Optional, Inject, forwardRef } from '@nestjs/common';
import { DynamicAgentService, StreamChunk } from './dynamic-agent.service';
import { SessionService } from '../session/session.service';
import { UserService } from '../../user/user.service';
import { AnalyticsService } from '../../platform/analytics/analytics.service';
import { EditionService } from '../../edition/edition.service';
import { OemService } from '../../platform/oem/oem.service';
import { ConfirmationBridgeService, ConfirmRequest } from '../support/confirmation-bridge.service';
import {
  createUserPrincipal,
  InvocationPrincipal,
} from '../../platform/app-store/runtime/invocation-principal';

/** OEM sessions are locked to the data_master agent. */
const OEM_AGENT_ID = 'data_master';

const TC_CONTENT_CAP = 8_000;
const TC_DETAILS_CAP = 20_000;

/** 落库前精简 toolCalls：截断超大文本/丢弃超大 details，但始终保留面板消息 */
function sanitizeToolCallsForStorage(toolCalls: any[] | undefined): any[] {
  return (toolCalls || []).map((tc) => {
    if (!tc?.result) return { name: tc?.name, args: tc?.args };
    const r = tc.result;
    const result: any = {};
    if (Array.isArray(r.content)) {
      result.content = r.content.map((b: any) =>
        b?.type === 'text' && typeof b.text === 'string' && b.text.length > TC_CONTENT_CAP
          ? { ...b, text: b.text.slice(0, TC_CONTENT_CAP) + '…' }
          : b,
      );
    } else if (r.content !== undefined) {
      result.content = r.content;
    }
    if (r.details !== undefined && JSON.stringify(r.details).length <= TC_DETAILS_CAP) {
      result.details = r.details;
    }
    if (r._panel_output) result._panel_output = r._panel_output;
    if (r._panel_update) result._panel_update = r._panel_update;
    return { name: tc.name, args: tc.args, result };
  });
}

/** 进行中的一轮生成：供重进会话（chat.attach）恢复流式状态用。内存态，后端重启即丢失（退化为仅历史）。 */
interface ActiveRun {
  key: string;              // `${userId}:${agentSessionId}`
  room: string;             // `chatrun:${userId}:${agentSessionId}`
  userId: string;
  agentId: string;
  agentSessionId: string;
  conversationId: string;
  status: 'running' | 'done' | 'error';
  text: string;             // 已流式正文累计
  toolCalls: { name: string; args?: any; result?: any }[];
  startedAt: number;
  model?: string;
  cost?: number;
  tokens?: any;
  error?: string;
  expiresAt?: number;       // done/error 后保留 60s 供 attach 取最终态，读取处惰性清理
}

/** done/error 后注册表保留时长（ms），消除"attach 恰在 done 与落库之间"的竞态窗口 */
const RUN_RETENTION_MS = 60_000;

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : true, credentials: true },
  namespace: '/ws/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ChatGateway.name);
  private socketUsers = new Map<string, {
    id: string;
    name: string;
    email?: string;
    principal: InvocationPrincipal;
    oem?: { appId: string; externalUid: string; dataSources: any[]; rateLimit: any };
  }>();
  private activeRuns = new Map<string, ActiveRun>();

  /** 惰性清理已过期的 done/error run */
  private pruneRuns() {
    const now = Date.now();
    for (const [k, r] of this.activeRuns) {
      if (r.expiresAt && r.expiresAt <= now) this.activeRuns.delete(k);
    }
  }

  constructor(
    private readonly agentService: DynamicAgentService,
    private readonly sessionService: SessionService,
    private readonly userService: UserService,
    private readonly analytics: AnalyticsService,
    private readonly confirmBridge: ConfirmationBridgeService,
    @Optional() private readonly oemService?: OemService,
    @Optional() @Inject(forwardRef(() => EditionService)) private readonly edition?: EditionService,
  ) {}

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token || (client.handshake.query.token as string);
    if (!token) {
      this.logger.warn(`Rejected: ${client.id} (no token)`);
      client.emit('chat.error', { error: '缺少认证令牌' });
      client.disconnect();
      return;
    }
    const user = this.userService.verifyToken(token);
    if (!user) {
      this.logger.warn(`Rejected: ${client.id} (invalid token)`);
      client.emit('chat.error', { error: '令牌无效或已过期' });
      client.disconnect();
      return;
    }

    // OEM session: lock to data_master + carry the接入方's bound data sources
    const oemClaims = this.userService.decodeOem(token);
    let oem: { appId: string; externalUid: string; dataSources: any[]; rateLimit: any } | undefined;
    if (oemClaims && this.oemService) {
      // OEM requires chat scope
      if (!user.role.permissions?.includes('chat:use')) {
        this.logger.warn(`Rejected OEM: ${client.id} (missing chat:use scope)`);
        client.emit('chat.error', { error: 'OEM 令牌缺少对话权限' });
        client.disconnect();
        return;
      }
      const cfg = await this.oemService.getRuntimeConfig(oemClaims.appId).catch(() => null);
      if (!cfg) {
        this.logger.warn(`Rejected OEM: ${client.id} (app ${oemClaims.appId} inactive)`);
        client.emit('chat.error', { error: '接入方已停用' });
        client.disconnect();
        return;
      }
      // Origin 白名单强校验（配置了才校验，留空=放行，便于开发）
      const origin = (client.handshake.headers.origin || '') as string;
      if (cfg.allowedOrigins.length && origin && !cfg.allowedOrigins.includes(origin)) {
        this.logger.warn(`Rejected OEM: ${client.id} (origin ${origin} not allowed for ${oemClaims.appId})`);
        client.emit('chat.error', { error: '来源域不被允许' });
        client.disconnect();
        return;
      }
      oem = { appId: oemClaims.appId, externalUid: oemClaims.externalUid, dataSources: cfg.dataSources, rateLimit: cfg.rateLimit };
    }

    const principal = createUserPrincipal(user, 'websocket:chat');
    this.socketUsers.set(client.id, {
      id: user.id,
      name: user.username || user.name,
      email: user.email,
      principal,
      oem,
    });
    this.analytics.registerUser(user.id, user.username || user.name);
    this.logger.log(`Connected: ${client.id} (${user.username || user.name})${oem ? ` [OEM ${oem.appId}]` : ''}`);

    // Pre-warm main agent in background so first message is fast
    this.agentService.warmupAgent(user.id, undefined, principal).catch(() => {});
  }

  handleDisconnect(client: Socket) {
    this.socketUsers.delete(client.id);
  }

  @SubscribeMessage('chat.send')
  async handleChatSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: {
      conversationId: string;
      agentId?: string;
      sessionId?: string;
      content: string;
      attachments?: { filePath: string; fileName: string }[];
      pageContext?: { panel?: string; title?: string; nav?: string; url?: string; labels?: string[] };
      forceNewSession?: boolean;  // 用户显式"新建会话"：跳过最近会话复用，强制开新会话
    },
  ) {
    const { conversationId, content, attachments } = data;
    let { pageContext } = data;
    const user = this.socketUsers.get(client.id);
    const userId = user?.id || 'anonymous';

    // OEM sessions are locked to data_master, and carry the接入方's bound MCP sources
    let agentId = data.agentId || 'main';
    if (user?.oem) {
      // 按 app 限流 / 每日配额
      if (this.oemService) {
        const rate = await this.oemService.checkRate(user.oem.appId, 'chat_msg', user.oem.rateLimit || {});
        if (!rate.allowed) {
          client.emit('chat.error', { conversationId: data.conversationId, error: rate.reason || '请求过于频繁' });
          client.emit('chat.stream', { conversationId: data.conversationId, delta: '', done: true });
          return;
        }
      }
      agentId = OEM_AGENT_ID;
      const oemDataSources = (user.oem.dataSources || []).map((s: any) => ({
        mcp_name: s.mcp_name, label: s.label, schema_hint: s.schema_hint,
      }));
      pageContext = { ...(pageContext || {}), panel: 'dashboard', oemDataSources } as any;
      this.oemService?.recordUsage(user.oem.appId, user.oem.externalUid, 'chat_msg').catch(() => {});
    }
    this.logger.log(`chat.send: user=${userId}, agent=${agentId}, session=${data.sessionId || '(null)'}, msg=${content?.substring(0, 30)}`);

    // Ensure session exists and belongs to the correct agent
    let sessionId = data.sessionId;
    // 用户显式"新建会话"：忽略任何旧 session，强制开新会话（否则下方会复用最近会话，消息持续累加）
    if (data.forceNewSession) sessionId = undefined;
    if (sessionId) {
      // Validate session belongs to this agent — reject cross-agent session leaks
      const session = await this.sessionService.getSession(sessionId);
      if (!session || session.agentType !== agentId) {
        this.logger.warn(`Session ${sessionId} belongs to ${session?.agentType}, not ${agentId} — creating new`);
        sessionId = undefined;
      }
    }
    if (!sessionId && userId !== 'anonymous') {
      // Try to reuse a recent session for this agent (#2: per-agent window) to prevent context loss.
      // 但显式新建会话时跳过复用，直接建新会话。
      const reuseWindow = this.agentService.getReuseWindowMinutes(agentId);
      sessionId = (!data.forceNewSession && await this.sessionService.getRecentSession(userId, agentId, reuseWindow)) ||
                  await this.sessionService.createSession(userId, agentId);
      client.emit('chat.session', { conversationId, sessionId });
    }

    // Build full content — attachments are tracked separately by agentService
    // to avoid confusion between current and historical files
    let fullContent = content;

    // Save user message & auto-title (include attachment names for display)
    let savedContent = content;
    if (attachments?.length) {
      savedContent = `${content}\n\n${attachments.map(a => `[附件: ${a.fileName}]`).join(' ')}`;
    }
    if (sessionId) {
      await this.sessionService.saveUserMessage(sessionId, savedContent, content.substring(0, 50));
    }

    const agentSessionId = sessionId || conversationId;

    // 注册进行中 run 并让发起方入 room：重进会话的其他 socket 可 attach 到同一 room 接续收事件
    this.pruneRuns();
    const run: ActiveRun = {
      key: `${userId}:${agentSessionId}`,
      room: `chatrun:${userId}:${agentSessionId}`,
      userId, agentId, agentSessionId, conversationId,
      status: 'running', text: '', toolCalls: [], startedAt: Date.now(),
    };
    this.activeRuns.set(run.key, run);
    client.join(run.room);

    // Record user message event for analytics
    this.analytics.recordEvent({ type: 'conversation_message', conversationId, userId, agentId, contentLength: content?.length || 0 }).catch(() => {});
    const startTime = Date.now();

    // Listen for tool confirmation requests during this message processing
    const onConfirmRequest = (req: ConfirmRequest) => {
      this.logger.log(`[EMIT] chat.confirm tool=${req.toolName} id=${req.confirmId}`);
      client.emit('chat.confirm', { conversationId, ...req });
    };
    const onConfirmTimeout = (data: { confirmId: string }) => {
      this.logger.log(`[EMIT] chat.confirm_dismiss id=${data.confirmId}`);
      client.emit('chat.confirm_dismiss', { conversationId, confirmId: data.confirmId });
    };
    this.confirmBridge.events.on('confirm_request', onConfirmRequest);
    this.confirmBridge.events.on('confirm_timeout', onConfirmTimeout);

    // 提到 try 外：会话中断(catch)时也能把已流式产出的部分内容落库，避免重进会话后该轮内容丢失
    let assistantContent = '';
    try {
      let gotDone = false;
      let doneModel = '';
      let doneCost = 0;
      let doneTokens = { input: 0, output: 0, total: 0 };

      const userEmail = user?.email || undefined;
      for await (const chunk of this.agentService.processMessage(
        agentId,
        agentSessionId,
        userId,
        fullContent,
        pageContext,
        attachments,
        userEmail,
        user?.principal,
      )) {
        this.emitChunk(run, chunk);
        if (chunk.type === 'text_delta' && chunk.text) {
          assistantContent += chunk.text;
          run.text += chunk.text;
        }
        if (chunk.type === 'tool_call' && chunk.toolName) {
          // 对齐前端合并规则：无 result 追加新调用，有 result 合并到最后一个同名调用
          if (chunk.toolResult) {
            const last = [...run.toolCalls].reverse().find(t => t.name === chunk.toolName && t.result === undefined);
            if (last) last.result = chunk.toolResult; else run.toolCalls.push({ name: chunk.toolName, args: chunk.toolArgs, result: chunk.toolResult });
          } else {
            run.toolCalls.push({ name: chunk.toolName, args: chunk.toolArgs });
          }
          this.analytics.recordEvent({ type: 'tool_call', conversationId, userId, agentId, toolName: chunk.toolName }).catch(() => {});
          // P2-17: record structured tool failures (from P0-5 __error) for the efficiency board
          const err = chunk.toolResult?.details?.__error;
          if (err?.code) {
            this.analytics.recordEvent({ type: 'tool_error', conversationId, userId, agentId, toolName: chunk.toolName, errorCode: err.code, errorMessage: err.message }).catch(() => {});
          }
        }
        if (chunk.type === 'done') {
          gotDone = true;
          doneModel = chunk.model || '';
          doneCost = chunk.cost || 0;
          if (chunk.tokens) doneTokens = chunk.tokens;
        }
      }

      // Safety: ensure frontend always gets a done signal
      if (!gotDone) {
        this.server.to(run.room).emit('chat.stream', { conversationId, sessionId: run.agentSessionId, delta: '', done: true, model: 'unknown' });
      }

      // run 置终态并保留 60s：attach 恰在 done 与落库之间时可取回最终文本
      run.status = 'done';
      run.model = doneModel; run.cost = doneCost; run.tokens = doneTokens;
      run.expiresAt = Date.now() + RUN_RETENTION_MS;

      // Record completion event for analytics
      const routeType = doneModel.startsWith('Local') || doneModel.includes('qwen') || doneModel.includes('ollama') ? 'local' : 'cloud';
      this.analytics.recordEvent({
        type: 'conversation_complete', conversationId, userId, agentId,
        durationMs: Date.now() - startTime, model: doneModel, cost: doneCost,
        tokensInput: doneTokens.input, tokensOutput: doneTokens.output, tokensTotal: doneTokens.total,
        routeType,
      }).catch(() => {});

      if (sessionId && assistantContent) {
        // metadata 携带 toolCalls（截断大结果，保留面板消息 _panel_output/_panel_update）：
        // 历史恢复时可重建面板数据（如图纸预览），同时防止长会话落库体积失控
        await this.sessionService.saveMessage(
          sessionId, 'assistant', assistantContent,
          { toolCalls: sanitizeToolCallsForStorage(run.toolCalls) },
        );
        await this.sessionService.checkAndCompress(sessionId);
      }
    } catch (error: any) {
      this.logger.error(`chat.send error: ${error.message}`, error.stack);
      const msg = error.message || '处理消息时出错';
      const is402 = /402|积分不足|INSUFFICIENT/.test(msg);
      // 中断时把已产出的部分内容落库（含错误附注），重进会话不丢这轮
      if (sessionId && assistantContent.trim()) {
        await this.sessionService.saveMessage(sessionId, 'assistant', `${assistantContent}\n\n⚠️ ${is402 ? '积分不足，请充值后继续使用' : msg}`).catch(() => {});
      }
      run.status = 'error';
      run.error = is402 ? '积分不足，请充值后继续使用' : msg;
      run.expiresAt = Date.now() + RUN_RETENTION_MS;
      this.server.to(run.room).emit('chat.error', { conversationId, sessionId: run.agentSessionId, error: run.error });
      // Ensure streaming ends on frontend even after error
      this.server.to(run.room).emit('chat.stream', { conversationId, sessionId: run.agentSessionId, delta: '', done: true });
    } finally {
      this.confirmBridge.events.off('confirm_request', onConfirmRequest);
      this.confirmBridge.events.off('confirm_timeout', onConfirmTimeout);
    }
  }

  @SubscribeMessage('chat.cancel')
  handleChatCancel(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { conversationId: string; sessionId?: string },
  ) {
    const user = this.socketUsers.get(client.id);
    const userId = user?.id || 'anonymous';
    const agentId = data.conversationId === 'default' ? 'main' : data.conversationId;
    this.logger.log(`chat.cancel: user=${userId}, agent=${agentId}, session=${(data.sessionId || '').slice(0, 8) || '(all)'}`);
    this.agentService.cancelAgent(agentId, userId, data.sessionId);
  }

  @SubscribeMessage('chat.confirm_reply')
  handleConfirmReply(
    @ConnectedSocket() _client: Socket,
    @MessageBody() data: { confirmId: string; confirmed: boolean; editedArgs?: Record<string, any> },
  ) {
    this.logger.log(`chat.confirm_reply: id=${data.confirmId} confirmed=${data.confirmed}`);
    this.confirmBridge.handleReply(data.confirmId, data.confirmed, data.editedArgs);
  }

  /**
   * 重进会话恢复：join 进行中 run 的 room 并回发快照。
   * 有 sessionId 时校验归属后按 session 精确匹配；无 sessionId 时按 userId+agentId 找 run（main agent 刷新恢复用）。
   */
  @SubscribeMessage('chat.attach')
  async handleAttach(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { sessionId?: string; agentId?: string },
  ) {
    const user = this.socketUsers.get(client.id);
    const userId = user?.id || 'anonymous';
    this.pruneRuns();

    let run: ActiveRun | undefined;
    if (data.sessionId) {
      const session = await this.sessionService.getSession(data.sessionId).catch(() => null);
      // 归属校验：防止越权订阅他人 run；OEM 锁定 data_master
      if (!session || session.userId !== userId || (user?.oem && session.agentType !== OEM_AGENT_ID)) {
        client.emit('chat.attached', { sessionId: data.sessionId, status: 'none' });
        return;
      }
      run = this.activeRuns.get(`${userId}:${data.sessionId}`);
    } else {
      const agentId = user?.oem ? OEM_AGENT_ID : (data.agentId || 'main');
      const candidates = [...this.activeRuns.values()].filter(r => r.userId === userId && r.agentId === agentId);
      run = candidates.find(r => r.status === 'running') ||
            candidates.sort((a, b) => b.startedAt - a.startedAt)[0];
    }

    if (!run) {
      client.emit('chat.attached', { sessionId: data.sessionId, status: 'none' });
      return;
    }

    // 先 join 再发快照：消除快照与实时事件之间的漏事件窗口
    client.join(run.room);
    client.emit('chat.attached', {
      conversationId: run.conversationId,
      sessionId: run.agentSessionId,
      status: run.status,
      snapshot: {
        text: run.text,
        toolCalls: run.toolCalls,
        model: run.model, cost: run.cost, tokens: run.tokens, error: run.error,
        startedAt: run.startedAt,
      },
    });
  }

  /** 广播到 run 的 room：发起方与 attach 重进的其他 socket 都能收到；payload 统一带 sessionId 供前端二次过滤 */
  private emitChunk(run: ActiveRun, chunk: StreamChunk) {
    const to = this.server.to(run.room);
    const base = { conversationId: run.conversationId, sessionId: run.agentSessionId };
    switch (chunk.type) {
      case 'debug':
        to.emit('chat.debug', { ...base, ...chunk.debug });
        break;
      case 'text_delta':
        this.logger.debug(`[EMIT] text_delta len=${(chunk.text || '').length} text=${(chunk.text || '').substring(0, 80).replace(/\n/g, '\\n')}`);
        to.emit('chat.stream', { ...base, delta: chunk.text, done: false });
        break;
      case 'thinking_delta':
        // 推理模型思考流：单独通道，不进正文、不落库；不逐条记日志（量大）
        to.emit('chat.thinking', { ...base, delta: chunk.text });
        break;
      case 'thinking_start':
        // 新一轮 LLM 调用：前端重置思考流显示（按轮次替换）
        to.emit('chat.thinking_reset', { ...base });
        break;
      case 'tool_call':
        const resultSnippet = chunk.toolResult ? (typeof chunk.toolResult.content?.[0]?.text === 'string' ? chunk.toolResult.content[0].text : JSON.stringify(chunk.toolResult)).substring(0, 100) : '(start)';
        this.logger.debug(`[EMIT] tool_call ${chunk.toolName} ${chunk.toolResult ? 'result=' + resultSnippet : 'args=' + JSON.stringify(chunk.toolArgs || {}).substring(0, 100)}`);
        to.emit('chat.tool', { ...base, toolName: chunk.toolName, args: chunk.toolArgs, result: chunk.toolResult });
        if (chunk.toolResult?.details) {
          this.logger.debug(`[EMIT] tool_call ${chunk.toolName} has details: ${JSON.stringify(Object.keys(chunk.toolResult.details))}`);
        }
        if (chunk.toolResult?.details?.__action) {
          this.logger.log(`[EMIT] chat.action: ${chunk.toolResult.details.actionType} → ${JSON.stringify(chunk.toolResult.details.actionData || {}).substring(0, 100)}`);
          to.emit('chat.action', { ...base, ...chunk.toolResult.details });
        }
        break;
      case 'context_status':
        this.logger.debug(`[EMIT] chat.context level=${chunk.contextStatus?.level} usage=${chunk.contextStatus?.usagePercent}%`);
        to.emit('chat.context', { ...base, ...chunk.contextStatus });
        break;
      case 'tool_start':
        // 工具开始：仅作前端"无活动超时"的活动信号（长工具不误超时），不改变可见消息
        to.emit('chat.tool_start', { ...base, toolName: chunk.toolName });
        break;
      case 'keepalive':
        // 回合存活心跳：重置前端无活动计时器
        to.emit('chat.keepalive', { ...base });
        break;
      case 'error':
        this.logger.warn(`[EMIT] error: ${chunk.error}`);
        to.emit('chat.error', { ...base, error: chunk.error });
        break;
      case 'done':
        this.logger.debug(`[EMIT] done model=${chunk.model} cost=${chunk.cost}`);
        to.emit('chat.stream', { ...base, delta: '', done: true, model: chunk.model, cost: chunk.cost, tokens: chunk.tokens });
        break;
    }
  }
}
