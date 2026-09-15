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

/** OEM sessions are locked to the data_master agent. */
const OEM_AGENT_ID = 'data_master';

@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : true, credentials: true },
  namespace: '/ws/chat',
})
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(ChatGateway.name);
  private socketUsers = new Map<string, { id: string; name: string; email?: string; oem?: { appId: string; externalUid: string; dataSources: any[]; rateLimit: any } }>();

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

    this.socketUsers.set(client.id, { id: user.id, name: user.username || user.name, email: user.email, oem });
    this.analytics.registerUser(user.id, user.username || user.name);
    this.logger.log(`Connected: ${client.id} (${user.username || user.name})${oem ? ` [OEM ${oem.appId}]` : ''}`);

    // Pre-warm main agent in background so first message is fast
    this.agentService.warmupAgent(user.id).catch(() => {});
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
      for await (const chunk of this.agentService.processMessage(agentId, agentSessionId, userId, fullContent, pageContext, attachments, userEmail)) {
        this.emitChunk(client, conversationId, chunk);
        if (chunk.type === 'text_delta' && chunk.text) assistantContent += chunk.text;
        if (chunk.type === 'tool_call' && chunk.toolName) {
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
        client.emit('chat.stream', { conversationId, delta: '', done: true, model: 'unknown' });
      }

      // Record completion event for analytics
      const routeType = doneModel.startsWith('Local') || doneModel.includes('qwen') || doneModel.includes('ollama') ? 'local' : 'cloud';
      this.analytics.recordEvent({
        type: 'conversation_complete', conversationId, userId, agentId,
        durationMs: Date.now() - startTime, model: doneModel, cost: doneCost,
        tokensInput: doneTokens.input, tokensOutput: doneTokens.output, tokensTotal: doneTokens.total,
        routeType,
      }).catch(() => {});

      if (sessionId && assistantContent) {
        await this.sessionService.saveMessage(sessionId, 'assistant', assistantContent);
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
      client.emit('chat.error', { conversationId, error: is402 ? '积分不足，请充值后继续使用' : msg });
      // Ensure streaming ends on frontend even after error
      client.emit('chat.stream', { conversationId, delta: '', done: true });
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

  private emitChunk(client: Socket, conversationId: string, chunk: StreamChunk) {
    switch (chunk.type) {
      case 'debug':
        client.emit('chat.debug', { conversationId, ...chunk.debug });
        break;
      case 'text_delta':
        this.logger.debug(`[EMIT] text_delta len=${(chunk.text || '').length} text=${(chunk.text || '').substring(0, 80).replace(/\n/g, '\\n')}`);
        client.emit('chat.stream', { conversationId, delta: chunk.text, done: false });
        break;
      case 'thinking_delta':
        // 推理模型思考流：单独通道，不进正文、不落库；不逐条记日志（量大）
        client.emit('chat.thinking', { conversationId, delta: chunk.text });
        break;
      case 'thinking_start':
        // 新一轮 LLM 调用：前端重置思考流显示（按轮次替换）
        client.emit('chat.thinking_reset', { conversationId });
        break;
      case 'tool_call':
        const resultSnippet = chunk.toolResult ? (typeof chunk.toolResult.content?.[0]?.text === 'string' ? chunk.toolResult.content[0].text : JSON.stringify(chunk.toolResult)).substring(0, 100) : '(start)';
        this.logger.debug(`[EMIT] tool_call ${chunk.toolName} ${chunk.toolResult ? 'result=' + resultSnippet : 'args=' + JSON.stringify(chunk.toolArgs || {}).substring(0, 100)}`);
        client.emit('chat.tool', { conversationId, toolName: chunk.toolName, args: chunk.toolArgs, result: chunk.toolResult });
        if (chunk.toolResult?.details) {
          this.logger.debug(`[EMIT] tool_call ${chunk.toolName} has details: ${JSON.stringify(Object.keys(chunk.toolResult.details))}`);
        }
        if (chunk.toolResult?.details?.__action) {
          this.logger.log(`[EMIT] chat.action: ${chunk.toolResult.details.actionType} → ${JSON.stringify(chunk.toolResult.details.actionData || {}).substring(0, 100)}`);
          client.emit('chat.action', { conversationId, ...chunk.toolResult.details });
        }
        break;
      case 'context_status':
        this.logger.debug(`[EMIT] chat.context level=${chunk.contextStatus?.level} usage=${chunk.contextStatus?.usagePercent}%`);
        client.emit('chat.context', { conversationId, ...chunk.contextStatus });
        break;
      case 'tool_start':
        // 工具开始：仅作前端"无活动超时"的活动信号（长工具不误超时），不改变可见消息
        client.emit('chat.tool_start', { conversationId, toolName: chunk.toolName });
        break;
      case 'keepalive':
        // 回合存活心跳：重置前端无活动计时器
        client.emit('chat.keepalive', { conversationId });
        break;
      case 'error':
        this.logger.warn(`[EMIT] error: ${chunk.error}`);
        client.emit('chat.error', { conversationId, error: chunk.error });
        break;
      case 'done':
        this.logger.debug(`[EMIT] done model=${chunk.model} cost=${chunk.cost}`);
        client.emit('chat.stream', { conversationId, delta: '', done: true, model: chunk.model, cost: chunk.cost, tokens: chunk.tokens });
        break;
    }
  }
}
