import { Injectable, Logger, OnModuleInit, Optional, Inject, forwardRef } from '@nestjs/common';
import type { InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import { loadPiAi, loadPiAgent } from '../../pi';
import type { AgentEvent as PiAgentEvent } from '../../pi';
import { AgentRegistryService, AgentDef } from './agent-registry.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { EditionService } from '../../edition/edition.service';
import { KnowledgeToolsService } from '../../knowledge/tools/knowledge-tools.service';
import { DistillService } from '../../bridge/knowledge/distill/distill.service';
import { AgentPoolService } from './agent-pool.service';
import { ToolBuilderService } from './tool-builder.service';
import { ToolBridgeService } from '../tool-bridge/tool-bridge.service';
import type { StructuredToolError } from '../tool-bridge/tool-error';
import { ContextPrunerService } from '../context/context-pruner.service';
import { ContextCompactorService } from '../context/context-compactor.service';
import { PromptSynthesizerService } from '../prompt/prompt-synthesizer.service';
import { ContextManagerService } from '../context/context-manager.service';
import { SessionService } from '../session/session.service';
import { AnalyticsService } from '../../platform/analytics/analytics.service';
import { PromptEnhancerService } from '../prompt/prompt-enhancer.service';
import { PromptEnhancerLoaderService } from '../prompt/prompt-enhancer.loader';
import { AgentDelegationRegistry } from './agent-delegation.registry';

/**
 * 防循环守卫的纯决策函数（便于单测）。
 * 只有"工具失败 + 相同参数 + 结果与上次几乎相同（无进展）"才累计；否则计数清零。
 * 这样像 distill_expand_frontier 这类"相同参数反复调用但每批结果不同"的推进型工具不会被误杀。
 */
export function evalToolRepeatGuard(opts: {
  failed: boolean;
  sameResult: boolean;
  prevCount: number;
  hasStructuredError: boolean;
  retryable?: boolean;
}): { abort: boolean; nextCount: number } {
  const { failed, sameResult, prevCount, hasStructuredError, retryable } = opts;
  if (!(failed && sameResult)) return { abort: false, nextCount: 0 };
  const nextCount = prevCount + 1;
  // Retryable (transient) → 同参最多 5 次；permanent → 2 次；legacy（无结构化错误）→ 3 次。
  const limit = !hasStructuredError ? 3 : (retryable ? 5 : 2);
  return { abort: nextCount >= limit, nextCount };
}

/**
 * 消息条数护栏：把过长历史折叠成一条摘要，确保 messages.length ≤ max，切点落在干净边界
 * （user / 无 tool_calls 的 assistant），不切断 assistant.tool_calls 与其 tool 结果配对。原地修改，返回折叠条数。
 */
export function enforceMaxMessages(messages: any[], max: number): number {
  if (!Array.isArray(messages) || messages.length <= max) return 0;
  const hasSystem = messages[0]?.role === 'system';
  const head = hasSystem ? 1 : 0;
  let cut = messages.length - (max - head - 1);
  if (cut < head + 1) cut = head + 1;
  while (cut < messages.length && !(messages[cut].role === 'user' || (messages[cut].role === 'assistant' && !messages[cut].tool_calls?.length))) cut++;
  if (cut >= messages.length || cut <= head) return 0;
  const removed = cut - head;
  const summary = { role: 'user', content: `[系统提示] 为控制对话规模，已折叠较早的 ${removed} 条消息（细节可在「专项蒸馏」面板查看或重新询问）。` };
  messages.splice(head, removed, summary);
  return removed;
}

/**
 * 修复非法的 tool 配对：删除"孤儿 tool 结果"（其前不是带匹配 tool_call 的 assistant），
 * 并把"带 tool_calls 但无任何对应 tool 结果"的 assistant 的 tool_calls 去掉（转为纯文本），
 * 避免 OpenAI/deepseek 因 messages 非法返回 400。原地重写 messages，返回被清理的条数。
 */
export function sanitizeToolPairs(messages: any[]): number {
  if (!Array.isArray(messages)) return 0;
  let changed = 0;
  const out: any[] = [];
  for (const m of messages) {
    if (m?.role === 'tool') {
      // 往回找拥有该 tool_call_id 的 assistant（可跨越已入列的连续 tool）
      let j = out.length - 1;
      while (j >= 0 && out[j].role === 'tool') j--;
      const owner = j >= 0 ? out[j] : null;
      const ok = owner?.role === 'assistant' && Array.isArray(owner.tool_calls) && owner.tool_calls.some((tc: any) => tc.id === m.tool_call_id);
      if (!ok) { changed++; continue; } // 孤儿 tool 结果 → 丢弃
    }
    out.push(m);
  }
  // 反向：assistant 的 tool_calls 若后面没有对应 tool 结果，去掉 tool_calls（防"未应答的 tool_calls"400）
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m?.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const answered = new Set<string>();
      for (let k = i + 1; k < out.length && out[k].role === 'tool'; k++) answered.add(out[k].tool_call_id);
      if (m.tool_calls.some((tc: any) => !answered.has(tc.id))) {
        delete m.tool_calls;
        if (!m.content) m.content = '(已省略未完成的工具调用)';
        changed++;
      }
    }
  }
  if (changed) { messages.length = 0; messages.push(...out); }
  return changed;
}

/**
 * L3 上下文压缩决策函数（便于单测）。
 * 返回值：skip / soft-prune / cooldown / compact。
 */
export function decideL3Action(
  existingCtx: number,
  maxCtx: number,
  msgCount: number,
  lastCompactionAt: number,
  now: number,
): 'skip' | 'soft-prune' | 'cooldown' | 'compact' {
  const L3_SOFT_THRESHOLD = 0.6;
  const L3_CRITICAL_THRESHOLD = 0.8;
  const L3_COMPACTION_COOLDOWN_MS = 30 * 1000;

  if (existingCtx <= maxCtx * L3_SOFT_THRESHOLD || msgCount <= 6) return 'skip';
  if (existingCtx <= maxCtx * L3_CRITICAL_THRESHOLD) return 'soft-prune';
  if (now - lastCompactionAt < L3_COMPACTION_COOLDOWN_MS) return 'cooldown';
  return 'compact';
}

export interface StreamChunk {
  type: 'text_delta' | 'thinking_delta' | 'thinking_start' | 'tool_call' | 'tool_start' | 'keepalive' | 'source' | 'done' | 'error' | 'debug' | 'action' | 'context_status';
  text?: string;
  toolName?: string;
  toolArgs?: any;
  toolResult?: any;
  source?: { file: string; page?: number };
  model?: string;
  cost?: number;
  tokens?: { input: number; output: number; total: number };
  error?: string;
  debug?: any;
  actionType?: string;
  actionData?: any;
  // P0-1: 上下文健康度指示器 — 让裁剪/压缩对用户可见
  contextStatus?: {
    usagePercent: number;       // 0-100，当前上下文使用率
    level: 'ok' | 'warn' | 'critical' | 'compacted' | 'reset';
    budget: number;             // 预算（chars）
    used: number;               // 已用（chars）
    messageCount: number;       // 消息数
    detail?: string;            // 人类可读说明
  };
}

@Injectable()
export class DynamicAgentService implements OnModuleInit {
  private readonly logger = new Logger(DynamicAgentService.name);
  private piAi: any = null;
  private piAgent: any = null;
  // synthesisCache moved to PromptSynthesizerService

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly modelRouter: ModelRouterService,
    private readonly mcpTools: KnowledgeToolsService,
    private readonly agentPool: AgentPoolService,
    private readonly toolBuilder: ToolBuilderService,
    private readonly toolBridge: ToolBridgeService,
    private readonly contextPruner: ContextPrunerService,
    private readonly contextCompactor: ContextCompactorService,
    private readonly promptSynthesizer: PromptSynthesizerService,
    private readonly contextManager: ContextManagerService,
    private readonly sessionService: SessionService,
    private readonly analytics: AnalyticsService,
    private readonly promptEnhancer: PromptEnhancerService,
    private readonly enhancerLoader: PromptEnhancerLoaderService,
    private readonly delegationRegistry: AgentDelegationRegistry,
    @Optional() @Inject(forwardRef(() => EditionService)) private readonly edition?: EditionService,
    @Optional() private readonly distill?: DistillService,
  ) {}

  async onModuleInit() {
    this.piAi = await loadPiAi();
    this.piAgent = await loadPiAgent();

    let codingTools: any[] = [];
    try {
      const piCoding = await import('@mariozechner/pi-coding-agent');
      codingTools = piCoding.createCodingTools(process.cwd());
      this.logger.log(`Loaded ${codingTools.length} coding tools`);
    } catch (err: any) {
      this.logger.warn(`Could not load pi-coding-agent: ${err.message}`);
    }

    await this.toolBuilder.init(this.piAi, codingTools);
    await this.toolBridge.init({ ...this.piAi, codingTools });
    this.logger.log(`DynamicAgentService initialized, ${this.registry.getAll().length} agents available`);

    // Register static delegation rules declared in agent YAMLs
    for (const agentDef of this.registry.getAll()) {
      if (agentDef.agentDelegation?.length) {
        for (const entry of agentDef.agentDelegation) {
          this.delegationRegistry.register({
            fromAgent: agentDef.id,
            targetAgent: entry.targetAgent,
            description: entry.description,
            keywords: entry.keywords,
          });
        }
        this.logger.log(`Registered ${agentDef.agentDelegation.length} delegation rules for agent ${agentDef.id}`);
      }
    }

    this.modelRouter.onConfigChange(() => {
      this.logger.log('Model config changed, clearing agent sessions');
      this.agentPool.clear();
    });

    // Auto-extract personal knowledge when sessions expire
    this.agentPool.onExpire((sessionId) => {
      this.sessionService.extractKnowledge(sessionId).catch(() => {});
    });
  }

  /**
   * Pre-warm the main agent for a user so the first message is fast.
   * Called on WebSocket connect (fire-and-forget).
   */
  async warmupAgent(userId: string, sessionId?: string, principal?: InvocationPrincipal) {
    const mainDef = this.registry.get('main');
    if (!mainDef) return;
    const sid = sessionId || 'default';
    const key = `${mainDef.id}_${sid}`;
    if (this.agentPool.has(key)) return; // already warm
    try {
      await this.getOrCreateAgent(mainDef, sid, userId, undefined, principal);
      this.logger.log(`Agent pre-warmed for user ${userId}`);
    } catch (err: any) {
      this.logger.warn(`Agent warmup failed: ${err.message}`);
    }
  }

  async *processMessage(
    agentId: string, sessionId: string, userId: string, content: string,
    pageContext?: { panel?: string; title?: string; nav?: string; url?: string; labels?: string[]; pdfFileId?: string; oemDataSources?: { mcp_name: string; label?: string; schema_hint?: string }[] },
    attachments?: { filePath: string; fileName: string }[],
    userEmail?: string,
    principal?: InvocationPrincipal,
  ): AsyncGenerator<StreamChunk> {
    const agentKey = `${agentId}_${sessionId}`;

    // Update contexts
    if (pageContext) this.contextManager.setPageContext(agentKey, pageContext);
    if (attachments?.length) this.contextManager.setAttachments(agentKey, attachments);
    else this.contextManager.clearAttachments(agentKey);

    const agentDef = this.registry.get(agentId);
    if (!agentDef) { yield { type: 'error', error: `未知的智能体: ${agentId}` }; return; }

    // Pre-flight credits check: when using official proxy (no own API key), check credits
    const modelConfig = this.modelRouter?.getConfig();
    const usingOfficialProxy = !modelConfig?.hasCloudKey && this.edition?.isRegistered();
    if (usingOfficialProxy) {
      try {
        const balance = await this.edition!.syncCredits();
        // Only block when balance is explicitly negative (confirmed debt).
        // balance=0 could mean API unreachable (syncCredits default) — let proxy decide.
        if (balance < 0) {
          yield { type: 'error', error: '积分不足，请联系管理员充值' };
          return;
        }
      } catch { /* if check fails, proceed and let proxy decide */ }
    }

    let agent = await this.getOrCreateAgent(agentDef, sessionId, userId, userEmail, principal);
    const chunks: StreamChunk[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;

    // KB degradation notice: tell frontend when KB is unavailable
    if (!agent._kbActive && agentDef.tools.some(t => t === 'knowledge' || t === 'kb_mcp')) {
      chunks.push({
        type: 'action', actionType: 'kb_degraded',
        actionData: { message: '企业心智暂时不可用，回答可能不包含企业知识' },
      });
    }

    // Debug: prompt context
    const state = agent.state;
    chunks.push({ type: 'debug', debug: {
      eventType: 'prompt_context', eventLabel: '发送给 LLM 的上下文', timestamp: Date.now(),
      systemPrompt: state.systemPrompt, model: state.model?.id || '',
      messageHistory: (state.messages || []).map((m: any) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content?.map?.((c: any) => c.text || c.type).join(' ') || '' })),
      userMessage: content,
    }});

    // Tool call safety: abort only if the same tool+args keeps failing WITHOUT making progress
    const toolFailureCount = new Map<string, number>(); // "toolName:argsHash" → 连续无进展失败计数
    const lastToolResultByKey = new Map<string, string>(); // 上次同参结果，用于"结果是否在变=是否在推进"判定
    let lastToolKey = '';
    // P0-1: only push context_status when the health level changes, to avoid spamming
    let lastContextLevel: string = 'ok';
    let lastEventTime = Date.now(); // reset by every event, checked by inactivity timer below

    let toolCallCount = 0;
    let lastEventType = '';
    let streamedTextChars = 0; // Track text already streamed to client in this prompt cycle

    let unsubscribe = agent.subscribe(async (event: PiAgentEvent) => {
      const now = Date.now();
      const idleSec = ((now - lastEventTime) / 1000).toFixed(1);
      lastEventTime = now;
      lastEventType = event.type;

      // Log significant events with idle gap
      if (event.type === 'tool_execution_start') {
        toolCallCount++;
        this.logger.debug(`[${agentId}] tool_start #${toolCallCount}: ${event.toolName} (idle=${idleSec}s)`);
      } else if (event.type === 'tool_execution_end') {
        const resultStr = typeof event.result === 'string' ? event.result : JSON.stringify(event.result || '');
        this.logger.debug(`[${agentId}] tool_end: ${event.toolName} resultSize=${resultStr.length}ch (idle=${idleSec}s)`);
        // CTX_METRIC: tool result size for analysis
        const _ctxNow = (agent.state.messages || []).reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
        this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=tool_result tool=${event.toolName} result_size=${resultStr.length} ctx_chars=${_ctxNow} msgs=${(agent.state.messages || []).length} tool_calls=${toolCallCount}`);
      } else if (event.type === 'message_end') {
        // Log LLM usage if available
        const lastMsg = agent.state.messages?.[agent.state.messages.length - 1];
        const usage = (lastMsg as any)?.usage;
        const usageIn = usage?.input || usage?.prompt_tokens || 0;
        const usageOut = usage?.output || usage?.completion_tokens || 0;
        this.logger.debug(`[${agentId}] message_end (idle=${idleSec}s)${usage ? ` usage: in=${usageIn}, out=${usageOut}` : ''}`);
        // CTX_METRIC: LLM call context snapshot
        if (usageIn > 0 || usageOut > 0) {
          const _ctxNow = (agent.state.messages || []).reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
          this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=llm_call ctx_chars=${_ctxNow} msgs=${(agent.state.messages || []).length} usage_in=${usageIn} usage_out=${usageOut} tool_calls=${toolCallCount}`);
        } else if (usage) {
          // 兜底告警：usage 存在但 in=out=0 → 本次模型调用空响应（真因由 streamFn 旁路记录）。附最近一条工具结果大小，便于关联大结果场景。
          const _ctxNow = (agent.state.messages || []).reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
          const _lastTool = [...(agent.state.messages || [])].reverse().find((m: any) => m.role === 'tool');
          const _lastToolLen = _lastTool ? (typeof _lastTool.content === 'string' ? _lastTool.content.length : JSON.stringify(_lastTool.content || '').length) : 0;
          this.logger.warn(`[${agentId}] 空响应 message_end: usage in=0/out=0 ctx_chars=${_ctxNow} msgs=${(agent.state.messages || []).length} tool_calls=${toolCallCount} last_tool_result_chars=${_lastToolLen}`);
        }
      } else if (event.type === 'message_start') {
        const ctxLen = (agent.state.messages || []).reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
        this.logger.debug(`[${agentId}] message_start (idle=${idleSec}s) ctx=${ctxLen}ch msgs=${(agent.state.messages || []).length}`);
        // 新一轮 LLM 调用开始：通知前端重置思考流显示（思考内容按轮次替换，不跨轮累积）
        chunks.push({ type: 'thinking_start' });
      } else if (event.type === 'turn_start') {
        // Dump agent internal message roles at turn boundary
        const _stMsgs = agent.state.messages || [];
        const _stRoles = _stMsgs.map((m: any, i: number) => {
          let r = m.role;
          if (m.role === 'assistant') {
            const hasTC = Array.isArray(m.content) && m.content.some((c: any) => c.type === 'toolCall');
            const textLen = Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => (c.text || '').length).reduce((a: number, b: number) => a + b, 0) : (typeof m.content === 'string' ? m.content.length : 0);
            r += `(text:${textLen}${hasTC ? ',tc' : ''})`;
          }
          if (m.role === 'tool') r += `(${(typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).length}ch)`;
          return `[${i}]${r}`;
        }).join(' ');
        this.logger.debug(`[${agentId}] turn_start (idle=${idleSec}s) stateRoles: ${_stRoles}`);
      } else if (event.type === 'turn_end') {
        this.logger.debug(`[${agentId}] ${event.type} (idle=${idleSec}s)`);
      }

      if (event.type === 'tool_execution_start') {
        confirmPending = true;
        const argsStr = JSON.stringify((event as any).args || {});
        lastToolKey = `${event.toolName}:${argsStr.length > 200 ? argsStr.substring(0, 200) : argsStr}`;
        // 活动信号对称：工具开始即推一条 tool_start，前端据此重置无活动超时（长工具不再误判超时）
        chunks.push({ type: 'tool_start', toolName: event.toolName });
      }
      if (event.type === 'tool_execution_end') {
        confirmPending = false;
        const resultObj = event.result;
        const resultStr = typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj || '');
        // Check if this is a confirm cancellation (user cancel or timeout) — skip failure counting
        const isConfirmCancel = resultObj?.details?.__confirmCancelled || resultObj?.content?.[0]?.text?.includes('确认超时');
        if (isConfirmCancel) {
          // User cancelled the confirm form — abort the agent run
          if (resultObj?.details?.__userCancelled) {
            this.logger.log(`[${agentId}] User cancelled confirm form, aborting`);
            agent.abort?.();
            chunks.push({ type: 'text_delta', text: '已取消操作。' });
            chunks.push({ type: 'done', model: 'cancelled', cost: 0 });
            done = true;
            const wake = () => { if (resolveNext) resolveNext(); else setTimeout(wake, 50); };
            wake();
            return;
          }
          // Timeout — don't count as failure, let LLM handle
        } else if (resultObj?.details?.__abort) {
          // Hard abort: stop agent immediately. Emit any pending action first.
          const rawAbortMsg = resultObj.details.__abortMessage || '';
          this.logger.warn(`[${agentId}] Agent abort: ${rawAbortMsg || '(silent)'}`);
          // Emit action event (e.g. switch_agent) before aborting so frontend receives it
          if (resultObj.details.__action) {
            chunks.push({ type: 'tool_call', toolName: event.toolName, toolResult: resultObj });
          }
          agent.abort?.();
          if (rawAbortMsg) {
            // 体面退出：清理报错文本（去重复前缀、压空白、截断），并给出明确的后续指引，
            // 避免把原始异常（如 java stack 首行）直接怼给用户且无任何下文。
            const clean = String(rawAbortMsg)
              .replace(/^(.{2,20}?(?:失败|错误|异常)[：:]\s*)\1+/, '$1')   // 去重复前缀："保存失败: 保存失败: " → "保存失败: "
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 300);
            chunks.push({ type: 'text_delta', text: `⚠️ 操作未能完成：${clean}\n\n如需重试、调整参数或换个方式处理，请直接告诉我。\n\n<!-- buttons:重试,换个方式,新建会话 -->` });
          }
          chunks.push({ type: 'done', model: 'aborted', cost: 0 });
          done = true;
          const wake = () => { if (resolveNext) resolveNext(); else setTimeout(wake, 50); };
          wake();
          return;
        } else {
          // P0-5 / P1-11: structured-error-aware failure handling.
          // Providers emitting __error let us distinguish transient (retryable) from permanent errors;
          // providers not yet migrated fall back to the legacy string check.
          const errorInfo: StructuredToolError | undefined = resultObj?.details?.__error;
          const failed = errorInfo ? true : (resultStr.includes('失败') || resultStr.includes('not a function'));
          if (lastToolKey) {
            // 进度感知：相同参数但结果不同 = 工具在推进（如 distill_expand_frontier 每批抽不同节点），不算死循环。
            const prevResult = lastToolResultByKey.get(lastToolKey);
            const sameResult = prevResult !== undefined && prevResult === resultStr;
            lastToolResultByKey.set(lastToolKey, resultStr);

            const guard = evalToolRepeatGuard({
              failed, sameResult,
              prevCount: toolFailureCount.get(lastToolKey) || 0,
              hasStructuredError: !!errorInfo,
              retryable: errorInfo?.retryable,
            });
            toolFailureCount.set(lastToolKey, guard.nextCount);
            if (guard.abort) {
              const count = guard.nextCount;
              const codeLabel = errorInfo ? `（${errorInfo.code}）` : '（相同参数无进展）';
              this.logger.warn(`[${agentId}] Tool ${event.toolName} failed ${count} times ${codeLabel}, aborting`);
              agent.abort?.();
              const hint = errorInfo?.userActionRequired
                ? `👉 ${errorInfo.userActionRequired}`
                : (errorInfo?.retryable ? '建议稍后重试。' : '');
              chunks.push({ type: 'error', error: errorInfo
                ? `工具 ${event.toolName} 连续失败 ${count} 次${codeLabel}，已停止。${hint}`
                : `工具调用连续失败 ${count} 次（相同参数无进展），已自动停止。` });
              done = true;
              const wake = () => { if (resolveNext) resolveNext(); else setTimeout(wake, 50); };
              wake();
              return;
            }
          }
        }

        // Handle __action in normal tool results (not just abort cases)
        if (resultObj?.details?.__action) {
          chunks.push({
            type: 'action',
            actionType: resultObj.details.actionType,
            actionData: resultObj.details.actionData,
          });
        }

        // L2: Aggregate context budget check — prune old tool results if approaching limit
        const _msgs = agent.state.messages || [];
        const _ctxChars = _msgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
        const _budget = this.modelRouter.getMaxContextChars();
        if (_ctxChars > _budget * 0.4 && _msgs.length > 6) {
          const _ctxBefore = _ctxChars;
          this.contextPruner.pruneOldToolResults(agent, _budget * 0.3);
          this.contextPruner.reinjectPinnedState(agent);
          const _ctxAfter = _msgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
          const _pinnedSize = agent._pinnedState?.length || 0;
          this.logger.warn(`[${agentId}] L2: Context pruned ${_ctxBefore}ch → ${_ctxAfter}ch (budget=${_budget})`);
          this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=l2_prune ctx_before=${_ctxBefore} ctx_after=${_ctxAfter} budget=${_budget} pinned_size=${_pinnedSize} msgs=${_msgs.length}`);
          // P0-1: notify frontend that old tool results were cleared
          chunks.push({ type: 'context_status', contextStatus: {
            usagePercent: Math.round((_ctxAfter / _budget) * 100),
            level: 'compacted', budget: _budget, used: _ctxAfter, messageCount: _msgs.length,
            detail: `已清理旧工具结果以释放空间（${Math.round(_ctxBefore / 1000)}K→${Math.round(_ctxAfter / 1000)}K 字符）`,
          }});
          lastContextLevel = 'compacted';
        } else {
          // P0-1: emit health status only when the level transitions
          const usagePercent = Math.round((_ctxChars / _budget) * 100);
          const level = this.getContextLevel(usagePercent);
          if (level !== lastContextLevel) {
            chunks.push({ type: 'context_status', contextStatus: {
              usagePercent, level, budget: _budget, used: _ctxChars, messageCount: _msgs.length,
            }});
            lastContextLevel = level;
          }
        }
      }

      const debugChunk = this.mapDebugEvent(event, agent);
      if (debugChunk) chunks.push(debugChunk);
      const chunk = this.mapEvent(event);
      if (chunk) {
        chunks.push(chunk);
        if (chunk.type === 'text_delta' && chunk.text) streamedTextChars += chunk.text.length;
      }
      resolveNext?.();
    });

    // Build prompt with page context and attachment context
    let promptContent = content;
    if (pageContext?.panel) {
      const panelLabels: Record<string, string> = { kb: '企业心智', cw: 'CoWorker管理', dashboard: '数据仪表', skills: '技能管理', connectors: '连接管理', agents: '智能体管理', users: '用户管理', cfg: '设置' };
      const panelName = panelLabels[pageContext.panel] || pageContext.title || pageContext.panel;
      promptContent += `\n\n【当前页面: ${panelName} (${pageContext.panel})】`;
      // Inject active PDF file context so LLM knows which file user is viewing
      if (pageContext.pdfFileId) {
        promptContent += `\n【用户正在查看的PDF文件: ${pageContext.pdfFileId}】\n如需编辑此文件，先调用 get_pdf_structure 查看其区块结构，再用 update_pdf 修改。`;
      }
    }
    // OEM session: constrain data sourcing to the接入方 bound MCP sources
    if (pageContext?.oemDataSources?.length) {
      const list = pageContext.oemDataSources
        .map(s => `  - mcp_name: "${s.mcp_name}"${s.label ? ` （${s.label}）` : ''}${s.schema_hint ? ` — ${s.schema_hint}` : ''}`)
        .join('\n');
      promptContent += `\n\n【OEM 数据源限制】本次会话只能从以下已绑定的外部数据源取数（widget 用 type:"mcp" + 对应 mcp_name），禁止使用其它数据源或本地库：\n${list}`;
    }
    const curAttachments = this.contextManager.getAttachments(agentKey);
    if (curAttachments?.length) {
      const fileList = curAttachments.map(a => `- 文件: ${a.fileName}, 路径: ${a.filePath}`).join('\n');
      promptContent += `\n\n【本次消息附件 — 请仅使用以下文件路径】\n${fileList}`;
    }

    // Proactive prune: if message count exceeds threshold, clean up before context grows too large
    const existingMsgs = agent.state.messages || [];
    const maxCtx = this.modelRouter.getMaxContextChars();
    if (existingMsgs.length > 30) {
      this.contextPruner.pruneOldToolResults(agent, maxCtx * 0.3);
      this.contextPruner.reinjectPinnedState(agent);
      this.logger.warn(`[${agentId}] Proactive prune: ${existingMsgs.length} msgs exceeded 30`);
    }

    // L3: Pre-check context size — tiered compaction (soft prune → LLM compaction → hard reset)
    // P0-1: raise entry threshold and compute context size once to reduce redundant work.
    const existingCtx = existingMsgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
    const ctxUsagePercent = Math.round((existingCtx / maxCtx) * 100);
    const l3Action = decideL3Action(existingCtx, maxCtx, existingMsgs.length, (agent as any)._lastCompactionAt || 0, Date.now());

    if (l3Action === 'soft-prune') {
      // Moderate: clear old tool results (Tool Result Clearing strategy)
      this.contextPruner.pruneOldToolResults(agent, maxCtx * 0.3);
      const afterCtx = existingMsgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      this.logger.warn(`[${agentId}] L3: Soft prune ${existingCtx}ch → ${afterCtx}ch`);
      this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=l3_soft_prune ctx_before=${existingCtx} ctx_after=${afterCtx} budget=${maxCtx}`);
      // P0-1: notify frontend that old tool results were cleared pre-flight
      chunks.push({ type: 'context_status', contextStatus: {
        usagePercent: Math.round((afterCtx / maxCtx) * 100),
        level: 'compacted', budget: maxCtx, used: afterCtx, messageCount: existingMsgs.length,
        detail: `已清理旧工具结果以释放空间（${Math.round(existingCtx / 1000)}K→${Math.round(afterCtx / 1000)}K 字符）`,
      }});
      lastContextLevel = 'compacted';
    } else if (l3Action === 'cooldown') {
      this.logger.warn(`[${agentId}] L3: Context critical (${existingCtx}ch, ${ctxUsagePercent}%) but compaction cooldown active; skipping semantic compaction`);
    } else if (l3Action === 'compact') {
      // Critical: try LLM semantic compaction before hard reset
      this.logger.warn(`[${agentId}] L3: Attempting semantic compaction (${existingCtx}ch > ${Math.round(maxCtx * 0.8)}ch)`);
      const compacted = await this.contextCompactor.compactAgentState(agent, maxCtx * 0.5);
      if (compacted) {
        (agent as any)._lastCompactionAt = Date.now();
        const afterCtx = (agent.state.messages || []).reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
        this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=l3_compact ctx_before=${existingCtx} ctx_after=${afterCtx} budget=${maxCtx} pinned_size=${agent._pinnedState?.length || 0}`);
        // P0-1: notify frontend that history was semantically compacted
        chunks.push({ type: 'context_status', contextStatus: {
          usagePercent: Math.round((afterCtx / maxCtx) * 100),
          level: 'compacted', budget: maxCtx, used: afterCtx, messageCount: (agent.state.messages || []).length,
          detail: '已压缩历史对话以继续',
        }});
      }
      if (!compacted) {
        // Compaction failed — fall back to hard reset
        this.logger.warn(`[${agentId}] L3: Compaction failed, hard reset`);
        this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=l3_hard_reset ctx_before=${existingCtx} budget=${maxCtx}`);
        // P0-1: notify frontend that a fresh session was started
        chunks.push({ type: 'context_status', contextStatus: {
          usagePercent: 0, level: 'reset', budget: maxCtx, used: 0, messageCount: 0,
          detail: '上下文已满，已自动开启新会话',
        }});
        lastContextLevel = 'reset';
        unsubscribe();
        this.agentPool.remove(agentKey);
        this.contextManager.removeSession(agentKey);
        agent = await this.getOrCreateAgent(agentDef, 'fresh_' + Date.now(), userId, userEmail, principal);
        unsubscribe = agent.subscribe(async (event: PiAgentEvent) => {
          const now = Date.now();
          lastEventTime = now;
          lastEventType = event.type;
          if (event.type === 'tool_execution_start') { toolCallCount++; }
          const streamChunk = this.mapEvent(event);
          if (streamChunk) chunks.push(streamChunk);
          const debugChunk = this.mapDebugEvent(event, agent);
          if (debugChunk) chunks.push(debugChunk);
          if (resolveNext) resolveNext();
        });
      }
    }

    // Inactivity timeout: abort if no event for 180s.
    // lastEventTime is reset in the subscribe callback above on every event.
    const INACTIVITY_TIMEOUT = 180000;
    let inactivityReject: ((err: Error) => void) | null = null;
    let confirmPending = false;

    const inactivityTimer = setInterval(() => {
      if (confirmPending) return;
      const idle = Date.now() - lastEventTime;
      if (idle >= INACTIVITY_TIMEOUT) {
        this.logger.warn(`[${agentId}] Inactivity timeout: ${(idle / 1000).toFixed(0)}s since last event (${lastEventType}), toolCalls=${toolCallCount}`);
        agent.abort();
        this.agentPool.remove(agentKey);
        if (inactivityReject) inactivityReject(new Error('响应超时（180秒无活动）'));
      }
    }, 5000);

    // Keepalive：回合存活期间每 45s 推一条心跳，前端据此重置自身超时。
    // ⚠️ 不能用 confirmPending 门控——工具执行期间(confirmPending=true)正是最长的同步阻塞段
    // （如 distill_expand_frontier 单批可跑数分钟），此时若静音心跳，前端会误判无活动而自动 chat.cancel。
    // 只在本回合结束(done)时停。后端 180s 看门狗才用 confirmPending 让路长工具，二者职责分开。
    const keepaliveTimer = setInterval(() => {
      if (done) return;
      chunks.push({ type: 'keepalive' });
      resolveNext?.();
    }, 45000);

    const promptPromise = Promise.race([
      agent.prompt(promptContent),
      new Promise<never>((_, reject) => { inactivityReject = reject; }),
    ]).then(() => {
      const _msgs = agent.state.messages || [];
      const _totalChars = _msgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      const _lastA = [..._msgs].reverse().find((m: any) => m.role === 'assistant');
      const _lastLen = typeof _lastA?.content === 'string' ? _lastA.content.length : (Array.isArray(_lastA?.content) ? _lastA.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('').length : 0);
      this.logger.debug(`[${agentId}] prompt completed: toolCalls=${toolCallCount}, msgs=${_msgs.length}, contextChars=${_totalChars}, lastAssistantLen=${_lastLen}`);
      done = true; resolveNext?.();
    }).catch((err: any) => {
      // 用户主动取消导致的 prompt reject 不是错误——前端已本地提示，静默结束
      if (!(agent as any).__userCancelled) {
        this.logger.error(`[${agentId}] prompt error: ${err.message}, toolCalls=${toolCallCount}`);
        chunks.push({ type: 'error', error: err.message });
      }
      done = true;
      const wake = () => { if (resolveNext) resolveNext(); else setTimeout(wake, 50); };
      wake();
    }).finally(() => {
      clearInterval(inactivityTimer);
      clearInterval(keepaliveTimer);
    });

    while (!done || chunks.length > 0) {
      if (chunks.length > 0) yield chunks.shift()!;
      else if (!done) await new Promise<void>(r => { resolveNext = r; });
      else break; // done=true and no chunks, exit
    }

    const msgs = agent.state.messages || [];
    const lastMsg = msgs[msgs.length - 1];
    const usage = lastMsg?.role === 'assistant' ? (lastMsg as any).usage : undefined;

    // Fallback: if LLM produced no final reply, generate error with context
    // But if text was already streamed to the client, the user saw partial output — don't destroy the session
    const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
    const lastAssistantLen = typeof lastAssistant?.content === 'string' ? lastAssistant.content.length
      : (Array.isArray(lastAssistant?.content) ? lastAssistant.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('').length : 0);
    // CTX_METRIC: completion event
    const _finalCtx = msgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
    const _completionStatus = lastAssistantLen > 0 ? 'normal' : (streamedTextChars > 0 && toolCallCount > 0) ? 'normal_toolloop' : streamedTextChars > 0 ? 'empty_final' : 'no_response';
    this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=completion status=${_completionStatus} ctx_chars=${_finalCtx} msgs=${msgs.length} streamed_chars=${streamedTextChars} tool_calls=${toolCallCount} last_assistant_len=${lastAssistantLen}`);

    // 用户主动取消（cancelAgent 标记）——不是上游故障：
    // 前端本地已追加取消提示，服务端只发 done(cancelled)，不再发"模型调用失败"或空回复兜底。
    if ((agent as any).__userCancelled) {
      (agent as any).__userCancelled = false;
      yield { type: 'done', model: 'cancelled', cost: 0 };
      return;
    }

    // 上游模型调用以错误收尾（如 402 积分不足、限流等）→ 把真因透传给前端，而不是当成"空回复/回复中断"。
    const _llmStop = (lastAssistant as any)?.stopReason;
    const _llmErr = (lastAssistant as any)?.errorMessage;
    if (lastAssistantLen === 0 && _llmErr && (_llmStop === 'error' || _llmStop === 'aborted')) {
      const is402 = /402|积分不足|INSUFFICIENT|credit/i.test(String(_llmErr));
      const isRate = /429|rate.?limit|频繁|过载|overload/i.test(String(_llmErr));
      this.logger.warn(`[${agentId}] 上游错误透传前端: stop=${_llmStop} msg=${String(_llmErr).slice(0, 200)}`);
      yield { type: 'error', error: is402 ? '积分不足，请充值后继续使用' : isRate ? '请求过于频繁，请稍后重试' : `模型调用失败：${String(_llmErr).slice(0, 200)}` };
      return;
    }

    if (lastAssistantLen === 0 && streamedTextChars > 0) {
      // Empty final message but text was streamed — LLM didn't produce a closing summary.
      // Prune old tool results to shrink context, then retry for a proper conclusion.
      this.logger.warn(`[${agentId}] Empty final message (${streamedTextChars}ch streamed, ${toolCallCount} tool calls). Pruning context then retrying...`);
      const _budget = this.modelRouter.getMaxContextChars();
      this.contextPruner.pruneOldToolResults(agent, _budget * 0.2);
      const prunedCtx = (agent.state.messages || []).reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      this.logger.log(`[CTX_METRIC] agent=${agentId} session=${sessionId} event=retry_prune ctx_before=${_finalCtx} ctx_after=${prunedCtx}`);
      try {
        let retryDone = false;
        const retryPromise = agent.prompt('请根据以上工具调用的结果，给出总结回复。').then(() => { retryDone = true; resolveNext?.(); }).catch(() => { retryDone = true; resolveNext?.(); });
        while (!retryDone || chunks.length > 0) {
          if (chunks.length > 0) yield chunks.shift()!;
          else if (!retryDone) await new Promise<void>(r => { resolveNext = r; });
          else break;
        }
        await retryPromise;
        const retryMsgs = agent.state.messages || [];
        const retryLast = [...retryMsgs].reverse().find((m: any) => m.role === 'assistant');
        const retryLen = typeof retryLast?.content === 'string' ? retryLast.content.length : 0;
        if (retryLen > 0) {
          this.logger.log(`[${agentId}] Retry after prune succeeded: ${retryLen}ch response`);
        } else {
          this.logger.warn(`[${agentId}] Retry after prune also empty. Showing interruption notice.`);
          yield { type: 'text_delta', text: `\n\n*(AI 回复中断，可继续提问)*` };
        }
      } catch (retryErr: any) {
        this.logger.warn(`[${agentId}] Retry failed: ${retryErr.message}`);
        yield { type: 'text_delta', text: `\n\n*(AI 回复中断，可继续提问)*` };
      }
    } else if (lastAssistantLen === 0) {
      const contextChars = msgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      // Find last tool result text for display — check multiple message formats:
      // 1. role='tool' (standard), 2. content[].type='tool_result' (pi-agent), 3. role='assistant' with tool_use blocks
      let toolResultText = '';
      for (let i = msgs.length - 1; i >= 0 && !toolResultText; i--) {
        const m = msgs[i];
        if (m.role === 'tool') {
          toolResultText = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).substring(0, 500);
        } else if (Array.isArray(m.content)) {
          // Look for tool_result blocks inside any message
          const toolResults = m.content.filter((c: any) => c.type === 'tool_result' || c.type === 'tool-result');
          if (toolResults.length > 0) {
            const last = toolResults[toolResults.length - 1];
            toolResultText = (typeof last.content === 'string' ? last.content : (Array.isArray(last.content) ? last.content.map((c: any) => c.text || '').join('') : JSON.stringify(last.content || ''))).substring(0, 500);
          }
          // Also check for text blocks in assistant messages that have tool_use siblings
          if (!toolResultText && m.content.some((c: any) => c.type === 'tool_use' || c.type === 'toolCall')) {
            const textParts = m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('');
            if (textParts) toolResultText = textParts.substring(0, 500);
          }
        }
      }

      // Auto-clear agent so next message starts fresh
      this.agentPool.remove(agentKey);
      this.contextManager.removeSession(agentKey);

      if (toolCallCount > 0 && toolResultText) {
        // Tool succeeded but LLM couldn't generate follow-up — show tool result + hint
        this.logger.warn(`[${agentId}] Empty reply after ${toolCallCount} tool calls (ctx=${contextChars}ch). Showing tool result as fallback.`);
        yield { type: 'text_delta', text: `${toolResultText}\n\n*(AI 未生成总结回复，以上为最近工具返回结果)*\n\n<!-- buttons:继续,新建会话 -->` };
      } else if (toolCallCount > 0) {
        // Tool calls happened but we couldn't extract result text — still better than generic error
        this.logger.warn(`[${agentId}] Empty reply after ${toolCallCount} tool calls, no extractable result (ctx=${contextChars}ch).`);
        yield { type: 'text_delta', text: `已执行 ${toolCallCount} 次工具调用，但 AI 未能生成总结回复。请尝试重新提问或简化请求。\n\n<!-- buttons:继续,新建会话 -->` };
      } else if (contextChars > this.modelRouter.getMaxContextChars()) {
        this.logger.warn(`[${agentId}] Empty reply with oversized context (${contextChars}ch).`);
        yield { type: 'text_delta', text: `对话上下文过长（${Math.round(contextChars / 1000)}K字符），AI 无法继续处理。\n\n<!-- buttons:新建会话 -->` };
      } else {
        this.logger.warn(`[${agentId}] Empty reply (ctx=${contextChars}ch, tools=${toolCallCount}).`);
        yield { type: 'text_delta', text: `AI 未能生成回复，请尝试重新提问。\n\n<!-- buttons:新建会话 -->` };
      }
    }

    yield {
      type: 'done', model: usage?.model || agent.state.model.id, cost: usage?.cost?.total || 0,
      tokens: usage ? { input: usage.input || 0, output: usage.output || 0, total: usage.totalTokens || 0 } : undefined,
    };

    unsubscribe();
    await promptPromise;
  }

  /** Cancel a running agent for a user — abort the target session (or all when sessionId unknown) */
  cancelAgent(agentId: string, userId: string, sessionId?: string) {
    for (const key of this.agentPool.keys()) {
      // 精确中止目标会话；无 sessionId（旧客户端）时退化为全部——
      // 否则会中止池内其他会话的运行，其流各自再发一条取消/错误消息，
      // 造成"用户取消一次、界面出现多条取消消息"（2026-09-09 修复）。
      if (!key.startsWith(`${agentId}_`)) continue;
      if (sessionId && key !== `${agentId}_${sessionId}`) continue;
      const agent = this.agentPool.get(key);
      if (agent) {
        this.logger.log(`[${agentId}] User cancelled — aborting agent (session=${key.slice(agentId.length + 1).slice(0, 8)})`);
        // 标记为用户主动取消：后处理的上游错误透传/空回复兜底不得再发"模型调用失败"
        (agent as any).__userCancelled = true;
        agent.abort?.();
      }
    }
  }

  removeSession(agentId: string, sessionId: string) {
    const key = `${agentId}_${sessionId}`;
    this.agentPool.remove(key);
    this.contextManager.removeSession(key);
  }

  /** #2: per-agent session reuse window (minutes), defaults to 10 when unconfigured. */
  getReuseWindowMinutes(agentId: string): number {
    return this.registry.get(agentId)?.sessionConfig?.reuseWindowMinutes ?? 10;
  }

  private async getOrCreateAgent(
    def: AgentDef,
    sessionId: string,
    userId: string,
    userEmail?: string,
    principal?: InvocationPrincipal,
  ): Promise<any> {
    const key = `${def.id}_${sessionId}`;
    if (this.agentPool.has(key)) return this.agentPool.get(key)!;

    const model = this.modelRouter.resolveModelForLevel(def.modelLevel);
    const tools = await this.toolBridge.buildForAgent(
      def.tools,
      { principal, userId, agentKey: key, userEmail, appId: this.registry.getOwnerAppId(def.id) },
      def.context?.maxToolOutputChars,
    );

    // Inject user identity headers for community edition LLM proxy tracking
    const userName = this.analytics.getUserName(userId) || userId;
    const userHeaders = this.modelRouter.getCommunityUserHeaders?.(userId);
    if (userHeaders) userHeaders['X-User-Name'] = encodeURIComponent(userName);
    const streamFn = (m: any, ctx: any, opts?: any) => {
      if (userHeaders) {
        opts = { ...opts, headers: { ...opts?.headers, ...userHeaders } };
      }
      // 请求指纹（用于把"空响应"与具体请求对上）
      const reqMsgs = Array.isArray(ctx?.messages) ? ctx.messages.length : 0;
      let reqChars = 0;
      try { reqChars = JSON.stringify(ctx?.messages || ctx || '').length; } catch { /* circular, skip */ }
      const modelId = m?.id || m?.model || '(unknown)';

      let stream: any;
      try {
        stream = this.piAi.streamSimple(m, ctx, opts);
      } catch (err: any) {
        // 同步抛错（建流失败）——直接记，再抛给上层
        this.logger.error(`[${def.id}] streamSimple threw: ${err?.status || ''} ${err?.message || err} (model=${modelId} reqMsgs=${reqMsgs} reqChars=${reqChars})`);
        throw err;
      }

      // 旁路诊断：不消费迭代器，仅观察最终结果。pi-ai 协议里上游失败会以 error 事件结束，
      // 但到 message_end 时 errorMessage 已丢失——这里用非消费的 .result() 把真因捞出来。
      try {
        stream?.result?.().then((finalMsg: any) => {
          const stop = finalMsg?.stopReason;
          const errMsg = finalMsg?.errorMessage;
          const content = finalMsg?.content;
          const textLen = typeof content === 'string' ? content.length
            : (Array.isArray(content) ? content.filter((c: any) => c?.type === 'text').reduce((s: number, c: any) => s + (c.text?.length || 0), 0) : 0);
          const toolCalls = Array.isArray(finalMsg?.toolCalls) ? finalMsg.toolCalls.length : 0;
          const usage = finalMsg?.usage || {};
          const usageIn = usage.input ?? usage.prompt_tokens ?? 0;
          const usageOut = usage.output ?? usage.completion_tokens ?? 0;
          if (stop === 'error' || stop === 'aborted' || errMsg) {
            this.logger.error(`[${def.id}] LLM 调用异常结束: stopReason=${stop} errorMessage=${(errMsg || '(none)').toString().slice(0, 800)} model=${modelId} reqMsgs=${reqMsgs} reqChars=${reqChars} usage_in=${usageIn} usage_out=${usageOut}`);
          } else if (textLen === 0 && toolCalls === 0 && usageIn === 0 && usageOut === 0) {
            // 上游返回空（200 但无 choices / 被吞）——记请求规模便于复现
            this.logger.error(`[${def.id}] LLM 返回空（in=0/out=0、无文本无工具调用）: model=${modelId} reqMsgs=${reqMsgs} reqChars=${reqChars} stopReason=${stop}`);
          }
        }).catch((e: any) => {
          this.logger.error(`[${def.id}] LLM stream.result() 失败: ${e?.status || ''} ${e?.message || e} (model=${modelId} reqMsgs=${reqMsgs} reqChars=${reqChars})`);
        });
      } catch { /* result() 不可用则忽略，不影响主流程 */ }

      return stream;
    };

    // Build system prompt — enterprise mind LLM fusion
    // Soul (agent personality) is fused with enterprise culture + rules via LLM
    // Results are cached by content hash to avoid redundant LLM calls
    const baseSoul = def.soul || `你是${def.name}。`;
    let systemPrompt = baseSoul;
    let kbActive = false;

    if (def.loadKnowledge !== false && this.mcpTools.isAvailable()) {
      try {
        const [characterLayer, rulesLayer, knowledgeDigest] = await Promise.all([
          this.mcpTools.fetchCharacterLayer(),
          this.mcpTools.fetchRulesLayer(),
          this.mcpTools.fetchKnowledgeDigest(),
        ]);

        const character = characterLayer ? this.promptSynthesizer.truncateToTokenLimit(characterLayer, 2000) : null;
        const rules = rulesLayer ? this.promptSynthesizer.truncateToTokenLimit(rulesLayer, 3000) : null;

        if (character || rules) {
          kbActive = true;
          systemPrompt = await this.promptSynthesizer.synthesize(baseSoul, character, rules);
          this.logger.log(`Agent ${def.id}: system prompt synthesized with enterprise mind`);
        }

        // Inject knowledge digest as a lightweight "table of contents" for the KB
        if (knowledgeDigest) {
          kbActive = true;
          const digest = this.promptSynthesizer.truncateToTokenLimit(knowledgeDigest, 1500);
          systemPrompt += `\n\n## 知识库索引\n\n${digest}\n\n> 当用户问题涉及以上领域时，主动使用 search_knowledge 工具检索详情。不要凭记忆回答企业知识相关问题。`;
          this.logger.log(`Agent ${def.id}: knowledge digest injected (${digest.length} chars)`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to synthesize KB layers for ${def.id}: ${err.message}, using agent soul`);
      }
    }

    // P1-15: 主动知识沉淀 — 让具备知识库能力的 Agent 主动识别并建议沉淀（只建议，不自动写入）
    if (def.tools.includes('knowledge')) {
      systemPrompt += `\n\n## 知识沉淀建议\n\n当对话中出现以下情况时，主动建议用户将内容保存到知识库：\n- 用户确认了一个重要的业务规则或决策\n- 通过多次工具调用获得了有价值的数据洞察\n- 解决了一个复杂问题，解决方案值得记录\n- 用户分享了未在知识库中记录的领域知识\n\n使用 \`suggest_kb_save\` 工具发起保存建议（仅生成确认卡片，由用户决定是否保存，不要自行写入）。不要频繁打扰：同一对话中至多建议 1-2 次，且仅在内容确有沉淀价值时。`;
    }

    if (def.tools.includes('ui_control')) {
      const panels = [
        { id: 'kb', name: '企业心智' }, { id: 'cw', name: 'CoWorker管理' },
        { id: 'dashboard', name: '数据仪表' }, { id: 'skills', name: '技能管理' }, { id: 'connectors', name: '连接管理' },
        { id: 'agents', name: '智能体管理' }, { id: 'users', name: '用户管理' }, { id: 'cfg', name: '设置' },
      ];
      const agentDefs = this.registry.getAll().filter(a => a.id !== def.id);
      systemPrompt += `\n\n## 可用面板\n${panels.map(p => `  - "${p.name}" → ${p.id}`).join('\n')}`;
      systemPrompt += `\n\n## 可切换智能体\n${agentDefs.map(a => `  - "${a.name}" → ${a.id}`).join('\n')}`;

      const pageMemory = await this.contextManager.loadPageMemory(userId);
      const memEntries = Object.entries(pageMemory);
      if (memEntries.length > 0) {
        systemPrompt += `\n\n## 已学习的页面\n${memEntries.map(([name, info]: [string, any]) => `  - "${name}" → ${info.panel}`).join('\n')}`;
      }

      // Inject any dynamic delegation rules registered by extension packages
      const dynamicRules = this.delegationRegistry.getForAgent(def.id).filter(r => r.appId);
      if (dynamicRules.length > 0) {
        const rows = dynamicRules
          .map(r => `    | ${r.description} | ${r.targetAgent} | ${r.keywords.map(k => `"${k}"`).join('、')} |`)
          .join('\n');
        systemPrompt += `\n\n## 扩展委派规则（来自已安装应用）\n\n    | 用户意图 | 目标智能体 | 识别关键词 |\n    |---------|-----------|----------|\n${rows}\n\n同上方委派规则，遇到匹配关键词时立即 switch_agent 委派，禁止自行处理。`;
      }
    }

    // Generic prompt enhancer — declared in agent YAML, no agent-id hardcoding here
    if (def.promptEnhancer) {
      systemPrompt = await this.enhancerLoader.enhance(systemPrompt, def.promptEnhancer, { userId });
    }

    // Load and compress history for session continuity
    let historyContext = '';
    try {
      const history = await this.sessionService.getMessages(sessionId);
      if (history.length > 0) {
        historyContext = await this.contextCompactor.compressHistory(history);
        if (historyContext) {
          this.logger.log(`Compressed ${history.length} history messages for session ${sessionId} (${historyContext.length} chars)`);
        }
      }
    } catch (err: any) {
      this.logger.warn(`Failed to load history for ${sessionId}: ${err.message}`);
    }
    if (historyContext) systemPrompt += `\n\n## 会话上下文（续接之前的对话）\n\n${historyContext}`;

    const agent = new this.piAgent.Agent({
      initialState: { systemPrompt, model, tools },
      streamFn,
      getApiKey: (provider: string) => this.modelRouter.getLlmAuthToken(provider) || this.piAi.getEnvApiKey(provider),
      // Fix: DeepSeek returns empty choices when the last message is not 'user' or 'assistant'.
      // This hook runs AFTER convertToLlm, directly on the OpenAI messages array.
      onPayload: (payload: any) => {
        const messages = payload?.messages;
        if (Array.isArray(messages) && messages.length > 0) {
          // 修复非法 tool 配对（孤儿 tool 结果 / 未应答 tool_calls），否则 provider 400
          const _fixed = sanitizeToolPairs(messages);
          if (_fixed > 0) this.logger.warn(`[${def.id}] onPayload: 修复非法 tool 配对 ${_fixed} 处`);
          // 消息条数护栏：长会话（如蒸馏数百次工具往返）折叠较早历史，防膨胀 + 防 provider 因超长/畸形 400
          const _folded = enforceMaxMessages(messages, 100);
          if (_folded > 0) this.logger.warn(`[${def.id}] onPayload: 消息条数护栏折叠 ${_folded} 条 → 现 ${messages.length} 条`);

          // 埋点：请求体字节分解 —— 定位"什么工具调用把 body 撑爆"。官网代理 body 硬限 1MB（超出 413）。
          try {
            const bytesOf = (o: any) => Buffer.byteLength(JSON.stringify(o ?? ''), 'utf8');
            const bodyBytes = bytesOf(payload);
            const msgsBytes = bytesOf(messages);
            const toolsBytes = payload?.tools ? bytesOf(payload.tools) : 0;
            // tool_call_id → 工具名（用于把 tool 结果归因到具体工具）
            const idToName: Record<string, string> = {};
            for (const m of messages) if (m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) idToName[tc.id] = tc.function?.name || '?';
            const ranked = messages.map((m: any, i: number) => {
              const bytes = bytesOf(m);
              let tag = m.role;
              if (m.role === 'tool') tag = `tool:${idToName[m.tool_call_id] || '?'}`;
              else if (m.role === 'assistant' && m.tool_calls?.length) tag = `asst→[${m.tool_calls.map((tc: any) => tc.function?.name).join(',')}]`;
              return { i, tag, bytes };
            }).sort((a: any, b: any) => b.bytes - a.bytes).slice(0, 6);
            const top = ranked.map((r: any) => `#${r.i}:${r.tag}=${(r.bytes / 1024).toFixed(1)}KB`).join(' ');
            // 按工具名聚合 tool 结果体积（哪个工具累计最占体积）
            const byTool: Record<string, number> = {};
            for (const m of messages) if (m.role === 'tool') { const n = idToName[m.tool_call_id] || '?'; byTool[n] = (byTool[n] || 0) + bytesOf(m); }
            const toolAgg = Object.entries(byTool).sort((a, b) => b[1] - a[1]).map(([n, b]) => `${n}=${(b / 1024).toFixed(1)}KB`).join(' ');
            this.logger.log(`[CTX_METRIC] agent=${def.id} event=req_body bytes_total=${bodyBytes} bytes_msgs=${msgsBytes} bytes_toolschemas=${toolsBytes} msgs=${messages.length} tools=${payload?.tools?.length || 0} top=[${top}] by_tool=[${toolAgg}]`);
            if (bodyBytes > 900 * 1024) this.logger.warn(`[${def.id}] ⚠️ 请求体逼近代理上限(1MB)：${(bodyBytes / 1024).toFixed(1)}KB；最大块 ${top}；工具累计 ${toolAgg}`);
          } catch { /* 埋点失败不影响主流程 */ }

          // Deep diagnostic: dump message role sequence and last 3 messages summary
          const roleSeq = messages.map((m: any) => {
            let label = m.role;
            if (m.role === 'assistant' && m.tool_calls?.length) label += `(tc:${m.tool_calls.length})`;
            if (m.role === 'tool') label += `(${m.tool_call_id?.substring(0, 8) || '?'})`;
            const contentLen = typeof m.content === 'string' ? m.content.length : (Array.isArray(m.content) ? JSON.stringify(m.content).length : 0);
            if (contentLen === 0 && m.role === 'assistant') label += '(EMPTY)';
            return label;
          }).join(' → ');
          this.logger.debug(`[${def.id}] onPayload: roleSeq=[${roleSeq}]`);

          // Dump last 4 messages content length + snippet
          const tail = messages.slice(-4);
          for (let i = 0; i < tail.length; i++) {
            const m = tail[i];
            const contentLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
            const contentSnippet = typeof m.content === 'string' ? m.content.substring(0, 80) : JSON.stringify(m.content || '').substring(0, 80);
            const tcInfo = m.tool_calls ? ` tool_calls=[${m.tool_calls.map((tc: any) => `${tc.function?.name}`).join(',')}]` : '';
            this.logger.debug(`[${def.id}] onPayload: msg[${messages.length - 4 + i}] role=${m.role} len=${contentLen}${tcInfo} snippet=${contentSnippet}`);
          }

          // Log payload metadata
          const payloadModel = payload?.model || '(none)';
          const payloadTools = Array.isArray(payload?.tools) ? payload.tools.length : 0;
          const payloadStream = payload?.stream;
          this.logger.debug(`[${def.id}] onPayload: model=${payloadModel} tools=${payloadTools} stream=${payloadStream} msgs=${messages.length}`);

          const lastMsg = messages[messages.length - 1];
          // DeepSeek requires last message to be 'user' or 'assistant' with tool_calls
          if (lastMsg.role !== 'user' && lastMsg.role !== 'system') {
            if (lastMsg.role !== 'assistant' || !lastMsg.tool_calls) {
              // 若上一条工具结果明确要求"停下等用户"（如 distill_scope），注入"停"而非"继续"，避免被催着自问自答
              const lastContent = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content || '');
              const awaitUser = /本轮到此为止|停下等用户|等用户真实回复/.test(lastContent);
              messages.push({ role: 'user', content: awaitUser
                ? '（请遵照上一条工具结果的指示：把方案讲给用户后本轮即停，不要调用任何工具、不要替用户回答）'
                : '请根据以上工具调用结果继续' });
              this.logger.debug(`[${def.id}] onPayload: INJECTED ${awaitUser ? 'await-user' : 'continue'} msg after role=${lastMsg.role} (msgs=${messages.length})`);
            }
          }
        }
        return payload;
      },
    });

    // Tag agent with KB status for degradation notice
    agent._kbActive = kbActive;
    agent._contextConfig = def.context || {};
    this.agentPool.set(key, agent, sessionId);
    this.logger.log(`Created agent: ${def.id} (${def.name}) for session ${sessionId}, kbActive=${kbActive}, hasHistory=${!!historyContext}`);
    return agent;
  }

  private mapEvent(event: PiAgentEvent): StreamChunk | null {
    switch (event.type) {
      case 'message_update': {
        const ame = event.assistantMessageEvent;
        if (ame?.type === 'text_delta' && 'delta' in ame) return { type: 'text_delta', text: (ame as any).delta || '' };
        // 推理模型的思考流：转发给前端做"思考过程"展示（不计入正文、不落库）
        if (ame?.type === 'thinking_delta' && 'delta' in ame) return { type: 'thinking_delta', text: (ame as any).delta || '' };
        return null;
      }
      case 'tool_execution_start':
        return { type: 'tool_call', toolName: event.toolName, toolArgs: (event as any).args, text: `正在调用: ${event.toolName}...` };
      case 'tool_execution_end':
        return { type: 'tool_call', toolName: event.toolName, toolResult: event.result };
      default: return null;
    }
  }

  private mapDebugEvent(event: PiAgentEvent, agent: any): StreamChunk | null {
    if (event.type === 'message_update') {
      const ame = event.assistantMessageEvent;
      if (!ame || ame.type === 'text_delta' || ame.type === 'thinking_delta' || ame.type === 'toolcall_delta' || ame.type === 'toolcall_end') return null;
    }
    if (event.type === 'tool_execution_update') return null;

    const labels: Record<string, string> = {
      message_start: 'LLM 开始响应', message_end: 'LLM 响应结束',
      tool_execution_start: '执行工具', tool_execution_end: '工具返回结果',
      turn_start: '新轮次', turn_end: '轮次结束',
    };
    const debug: any = { eventType: event.type, eventLabel: labels[event.type] || event.type, timestamp: Date.now() };

    if (event.type === 'message_update' && event.assistantMessageEvent) {
      const ame = event.assistantMessageEvent;
      if (ame.type === 'toolcall_start') {
        debug.subLabel = 'LLM 请求调用工具';
        const partial = (ame as any).partial;
        if (partial?.content) { const tcs = partial.content.filter((c: any) => c.type === 'toolCall'); const last = tcs[tcs.length - 1]; if (last) { debug.toolName = last.name; debug.toolArgs = last.arguments; } }
      }
      if (ame.type === 'done') { debug.subLabel = 'Token 用量'; debug.usage = ame; }
    }
    if (event.type === 'message_end') {
      const msgs = agent.state.messages || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          const text = typeof msgs[i].content === 'string' ? msgs[i].content : Array.isArray(msgs[i].content) ? msgs[i].content.map((c: any) => c.text || '').filter(Boolean).join('') : '';
          if (text) debug.responseText = text;
          break;
        }
      }
    }
    if (event.type === 'tool_execution_start') { debug.toolName = event.toolName; debug.toolArgs = (event as any).args; }
    if (event.type === 'tool_execution_end') { debug.toolName = event.toolName; debug.toolResult = event.result; }

    return { type: 'debug', debug };
  }

  private estimateTokens(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }

  /** P0-1: map context usage percentage to a health level */
  private getContextLevel(usagePercent: number): 'ok' | 'warn' | 'critical' {
    if (usagePercent < 50) return 'ok';
    if (usagePercent < 75) return 'warn';
    return 'critical';
  }

  /**
   * Compress session history into a concise summary via LLM.
   * Filters noise (retries, errors), keeps key decisions and data.
   */
}
