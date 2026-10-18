'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { getSocket } from '@/lib/socket';
import { createStreamBatcher } from '@/lib/streamBatcher';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

export interface Attachment {
  filePath: string;
  fileName: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: Attachment[];
  source?: { file: string; page?: number };
  model?: string;
  cost?: number;
  tokens?: { input: number; output: number; total: number };
  toolCalls?: { name: string; args?: any; result?: any }[];
  timestamp: Date;
}

export interface DebugEvent {
  eventType: string;
  eventLabel: string;
  subType?: string;
  subLabel?: string;
  timestamp: number;
  delta?: string;
  toolName?: string;
  toolArgs?: any;
  toolArgsDelta?: string;
  toolResult?: any;
  usage?: any;
}

export interface ConfirmFormColumn {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
  columns?: ConfirmFormColumn[];
}

export interface ConfirmFormField {
  key: string;
  label: string;
  type: string;          // string | number | boolean | date | datetime | table
  required?: boolean;
  default?: any;
  format?: string;       // date/datetime output format, e.g. "yyyy-MM-dd HH:mm:ss"
  columns?: ConfirmFormColumn[];
}

export interface PendingConfirm {
  confirmId: string;
  toolName: string;
  args: Record<string, any>;
  parameters: { name: string; type: string; required?: boolean; description?: string; label?: string }[];
  confirmForm?: ConfirmFormField[];
  timeoutSec?: number;
  description?: string;
}

// P0-1: 上下文健康度
export interface ContextStatus {
  usagePercent: number;
  level: 'ok' | 'warn' | 'critical' | 'compacted' | 'reset';
  detail?: string;
}

export function useChat(conversationId: string, token?: string | null, agentId: string = 'main') {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [errorHint, setErrorHint] = useState('');
  const [debugEvents, setDebugEvents] = useState<DebugEvent[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // ref 镜像：socket 事件 handler 闭包内读取最新值（sessionId 过滤 / 重连 re-attach）
  const sessionIdRef = useRef<string | null>(null);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  // 当前正在跟踪的 run（后端 chat.run / chat.attached 下发）：流事件按 runId 精确过滤。
  // 旧的 sessionId 过滤在 sessionId 尚未就位的空窗期会放行一切（新建会话到 chat.session 回包之间），
  // 导致旧会话的 delta 闪入新会话——runId 过滤没有这个空窗。
  const currentRunIdRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => { messagesRef.current = messages; }, [messages]);
  // 最近一次已应用的 attach 快照签名（sessionId:startedAt:status:textLen），重连重复 attach 时幂等
  const lastAttachSigRef = useRef('');
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [contextStatus, setContextStatus] = useState<ContextStatus | null>(null);
  // 推理模型的思考流（chat.thinking）：仅作过程展示，不进消息正文、不落库
  const [thinkingText, setThinkingText] = useState('');
  const [thinkingHead, setThinkingHead] = useState('');
  const thinkingBufRef = useRef('');
  const thinkingHeadRef = useRef('');
  const thinkingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const assistantIdRef = useRef('');
  const socketRef = useRef<ReturnType<typeof getSocket> | null>(null);
  // 分段气泡：工具结果到达后置位，下一段文本开启新气泡（懒创建，避免空气泡），
  // 使"叙事文本"与"工具效果（面板更新）"按事件到达顺序交织呈现。
  const splitNextRef = useRef(false);

  // P0-7: batch high-frequency stream deltas instead of calling setMessages on every token
  const streamBatcherRef = useRef(createStreamBatcher(setMessages, { getAssistantId: () => assistantIdRef.current }));

  // Reset session when conversationId changes (agent switch) — prevents stale session leaking across agents
  const prevConvRef = useRef(conversationId);
  useEffect(() => {
    if (prevConvRef.current !== conversationId) {
      prevConvRef.current = conversationId;
      setSessionId(null);
    }
  }, [conversationId]);
  const tokenRef = useRef(token);
  const lastActivityRef = useRef(0);  // timestamp of last stream/tool/debug event
  const inactivityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const forceNewRef = useRef(false);  // 用户点"新建会话"后置 true：下一条消息强制开新会话，避免后端复用旧会话致消息累加

  // Rebuild socket when token changes
  if (token !== tokenRef.current) {
    tokenRef.current = token;
    socketRef.current = null;
  }
  if (!socketRef.current && token) {
    socketRef.current = getSocket(token);
  }
  const socket = socketRef.current || (token ? getSocket(token) : null);

  /** 重进会话恢复：询问后端该会话是否有进行中的 run，有则快照续流（响应走 chat.attached） */
  const attachSession = useCallback((sid?: string) => {
    if (!socket) return;
    socket.emit('chat.attach', { sessionId: sid, agentId });
  }, [socket, agentId]);

  /**
   * 重置流式 UI 瞬态（不清消息列表）：切换/新建会话时调用。
   * 必须清干净——会话事件的 sessionId 过滤会丢弃旧会话的 done/thinking，
   * 不重置的话 isStreaming 浮动气泡与思考区会永久卡在旧会话状态。
   */
  const resetStreamUi = useCallback(() => {
    if (inactivityTimerRef.current) { clearInterval(inactivityTimerRef.current); inactivityTimerRef.current = null; }
    streamBatcherRef.current.reset();
    assistantIdRef.current = '';
    currentRunIdRef.current = null;
    splitNextRef.current = false;
    thinkingBufRef.current = '';
    thinkingHeadRef.current = '';
    setThinkingText('');
    setThinkingHead('');
    setIsStreaming(false);
  }, []);

  // Clear state and load latest session when agent/conversation changes
  useEffect(() => {
    setMessages([]);
    setDebugEvents([]);
    setSessionId(null);
    setIsStreaming(false);
    setContextStatus(null);
    streamBatcherRef.current.reset();
    assistantIdRef.current = '';
    currentRunIdRef.current = null;
    splitNextRef.current = false;
    thinkingBufRef.current = '';
    thinkingHeadRef.current = '';
    setThinkingText('');
    setThinkingHead('');

    // Auto-load the most recent session for non-main agents
    if (token && agentId && agentId !== 'main') {
      fetch(`${MAIN_URL}/api/sessions?agentType=${agentId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      }).then(r => r.json()).then(sessions => {
        // 竞态防护：switch_agent 转发等场景下会话已开始流式进行，
        // 历史加载不得覆盖进行中的消息，也不得篡改 sessionId
        if (assistantIdRef.current) return;
        if (Array.isArray(sessions) && sessions.length > 0) {
          const latest = sessions[0]; // Already sorted by updated_at DESC
          setSessionId(latest.id);
          // Load messages — mark as history (model='history') so UI shows them as complete
          fetch(`${MAIN_URL}/api/sessions/${latest.id}/messages`).then(r => r.json()).then(msgs => {
            if (assistantIdRef.current) return; // 流式已开始，放弃覆盖
            if (Array.isArray(msgs) && msgs.length > 0) {
              setMessages(msgs.map((m: any) => ({
                id: m.id,
                role: m.role as 'user' | 'assistant' | 'system',
                content: m.content,
                timestamp: new Date(m.createdAt),
                model: m.role === 'assistant' ? (m.metadata?.model || 'history') : undefined,
                toolCalls: m.metadata?.toolCalls,
              })));
            }
          }).catch(() => {}).finally(() => {
            // 重进恢复：历史加载完再 attach，进行中的 run 快照续流（避免历史覆盖快照）
            if (!assistantIdRef.current) attachSession(latest.id);
          });
        }
      }).catch(() => {});
    } else if (token && agentId === 'main') {
      // main agent 不自动加载历史，但可能有进行中的 run（如生成中刷新页面）——按 agentId 探测恢复
      attachSession(undefined);
    }
  }, [agentId, token, attachSession]);

  // 兜底无活动看门狗：sendMessage 与 attach 恢复进行中 run 时共用。
  // 后端有自己的 180s 无活动看门狗(会 abort 并发 chat.error)，且回合存活期每 45s 发心跳，
  // 故前端阈值 240s——只在"连心跳都收不到"(断线/后端真死)时才触发，并补发 chat.cancel。
  const armInactivityWatch = useCallback(() => {
    if (inactivityTimerRef.current) clearInterval(inactivityTimerRef.current);
    inactivityTimerRef.current = setInterval(() => {
      const idle = Date.now() - lastActivityRef.current;
      if (idle >= 240000) {
        if (inactivityTimerRef.current) { clearInterval(inactivityTimerRef.current); inactivityTimerRef.current = null; }
        if (socket) socket.emit('chat.cancel', { conversationId });
        setIsStreaming(prev => {
          if (prev) {
            const aid = assistantIdRef.current;
            if (aid) {
              // 尤达大师的后台蒸馏与会话解耦——会话兜底超时不代表后台停了
              const bgHint = agentId === 'distiller'
                ? '\n\n⚠️ 会话响应超时（已中止本轮对话）。若你正在蒸馏，后台任务仍在继续，可到「专项蒸馏」查看进度。'
                : '\n\n⚠️ 响应超时（连接无活动），已自动中止。';
              setMessages(ms => ms.map(m =>
                m.id === aid && !m.model ? { ...m, content: m.content + bgHint, model: 'timeout' } : m
              ));
            }
          }
          return false;
        });
      }
    }, 5000);
  }, [conversationId, socket, agentId]);

  useEffect(() => {
    /**
     * 统一的流事件过滤：是否属于当前正在跟踪的 run。
     * 1) conversationId 必须匹配（跨 agent 隔离）；
     * 2) 事件带 runId 时须等于 currentRunIdRef（本轮 run 的精确匹配，无空窗）；
     * 3) 兼容无 runId 的旧事件：退化为 sessionId 过滤。
     */
    const isCurrentRun = (data: { conversationId?: string; sessionId?: string; runId?: string }): boolean => {
      if (data.conversationId !== conversationId) return false;
      if (data.runId) return data.runId === currentRunIdRef.current;
      if (data.sessionId && sessionIdRef.current && data.sessionId !== sessionIdRef.current) return false;
      return true;
    };

    const onStream = (data: { conversationId: string; sessionId?: string; runId?: string; delta: string; done: boolean; model?: string; cost?: number; tokens?: { input: number; output: number; total: number } }) => {
      if (!isCurrentRun(data)) return;
      lastActivityRef.current = Date.now();
      if (data.done) {
        // 本地未跟踪任何 run（如已被 stop/超时收尾）——忽略迟到的 done，防止其清掉新 run 的状态
        if (!assistantIdRef.current) return;
        currentRunIdRef.current = null;
        if (inactivityTimerRef.current) { clearInterval(inactivityTimerRef.current); inactivityTimerRef.current = null; }
        const finalText = streamBatcherRef.current.flush();
        const aid = assistantIdRef.current;
        setMessages(prev => prev.map(m => {
          if (m.id !== aid) return m;
          // Don't overwrite error content with empty stream buffer
          if (!finalText && m.content) return { ...m, model: data.model || m.model, cost: data.cost, tokens: data.tokens };
          // Fallback: done with no text — show tool result summary or warning
          if (!finalText && !m.content) {
            if ((m.toolCalls?.length || 0) > 0) {
              const lastTc = m.toolCalls![m.toolCalls!.length - 1];
              const resultText = typeof lastTc.result === 'string' ? lastTc.result : JSON.stringify(lastTc.result || '').substring(0, 300);
              return { ...m, content: `⚠️ 工具 "${lastTc.name}" 已执行完成，但 AI 未生成回复（可能是上下文过长）。\n\n工具结果: ${resultText}`, model: data.model || 'incomplete', cost: data.cost };
            }
            return { ...m, content: '⚠️ 会话异常结束，未收到回复。请开始新对话重试。', model: data.model || 'incomplete', cost: data.cost };
          }
          return { ...m, content: finalText, model: data.model, cost: data.cost, tokens: data.tokens };
        }));
        streamBatcherRef.current.reset();
        assistantIdRef.current = '';
        thinkingBufRef.current = '';
        thinkingHeadRef.current = '';
        setThinkingText('');
        setThinkingHead('');
        setIsStreaming(false);
      } else if (data.delta) {
        if (!assistantIdRef.current) return; // 本地未跟踪 run（如新建会话后旧 run 残余事件）——忽略
        // 分段：上一个工具结果之后的首段文本 → 开新气泡，使文本与工具效果按序交织
        if (splitNextRef.current) {
          splitNextRef.current = false;
          streamBatcherRef.current.flush();
          streamBatcherRef.current.reset();
          const segId = `${Date.now()}-seg${Math.random().toString(36).slice(2, 6)}`;
          assistantIdRef.current = segId;
          setMessages(prev => [...prev, { id: segId, role: 'assistant' as const, content: '', timestamp: new Date() }]);
        }
        streamBatcherRef.current.onDelta(data.delta);
      }
    };

    const onMetadata = (data: { conversationId: string; sessionId?: string; source: { file: string; page?: number } }) => {
      if (!isCurrentRun(data)) return;
      const aid = assistantIdRef.current;
      setMessages(prev => prev.map(m =>
        m.id === aid ? { ...m, source: data.source } : m
      ));
    };

    const onTool = (data: { conversationId: string; sessionId?: string; toolName: string; args?: any; result?: any }) => {
      if (!isCurrentRun(data)) return;
      if (!assistantIdRef.current) return; // 本地未跟踪 run——忽略残余事件
      lastActivityRef.current = Date.now();
      const aid = assistantIdRef.current;
      setMessages(prev => prev.map(m => {
        if (m.id !== aid) return m;
        const existing = m.toolCalls || [];
        // If this is a result event for an already-started tool, merge into existing entry
        if (data.result && existing.length > 0) {
          const last = existing[existing.length - 1];
          if (last.name === data.toolName && !last.result) {
            return { ...m, toolCalls: [...existing.slice(0, -1), { ...last, result: data.result }] };
          }
        }
        return { ...m, toolCalls: [...existing, { name: data.toolName, args: data.args, result: data.result }] };
      }));
      if (data.result) {
        // 工具结果到达：后续文本另起气泡（见 splitNextRef）
        splitNextRef.current = true;
      }
    };

    const onError = (data: { conversationId: string; sessionId?: string; error: string }) => {
      if (!isCurrentRun(data)) return;
      streamBatcherRef.current.flush();
      setIsStreaming(false);
      if (inactivityTimerRef.current) { clearInterval(inactivityTimerRef.current); inactivityTimerRef.current = null; }
      // Detect credits/quota errors and show as persistent hint
      const isCreditsError = /积分不足|INSUFFICIENT|402/.test(data.error);
      const isTimeoutError = /超时|timeout/i.test(data.error);
      if (isCreditsError) {
        setErrorHint('积分不足，请联系管理员充值');
      } else if (isTimeoutError) {
        setErrorHint('响应超时，请检查网络连接或稍后重试');
      }
      // 会话中断时【不清除已流式输出的内容/工具卡】——把错误作为附注追加，保留用户已看到的消息。
      // （之前是用 "错误:…" 覆盖 content，导致中断后整轮只剩报错一行。）
      const aid = assistantIdRef.current;
      setMessages(prev => {
        if (aid && prev.some(m => m.id === aid)) {
          return prev.map(m => {
            if (m.id !== aid) return m;
            const hasStreamed = !!(m.content && m.content.trim()) || !!(m.toolCalls && m.toolCalls.length);
            return hasStreamed
              ? { ...m, content: `${m.content || ''}\n\n⚠️ ${data.error}`, model: m.model || 'error' }   // 保留已产出 + 追加错误
              : { ...m, content: `错误: ${data.error}`, model: 'error' };                                  // 还没产出任何内容才整条作为错误
          });
        }
        return [...prev, { id: Date.now().toString(), role: 'assistant' as const, content: `错误: ${data.error}`, timestamp: new Date(), model: 'error' }];
      });
      // 清空流缓冲，避免随后的 done 事件用空串覆盖（onStream 对空 finalText 已会保留 content）
      streamBatcherRef.current.reset();
      thinkingBufRef.current = '';
      thinkingHeadRef.current = '';
      setThinkingText('');
      setThinkingHead('');
    };

    const onDebug = (data: any) => {
      if (!isCurrentRun(data)) return;
      lastActivityRef.current = Date.now();
      setDebugEvents(prev => [...prev, data as DebugEvent]);
    };

    const onSession = (data: { conversationId: string; sessionId: string }) => {
      // chat.session 仅发给发起方，且 forceNewSession 时 sessionId 是"新"值——不做 sessionId 过滤
      if (data.conversationId !== conversationId) return;
      setSessionId(data.sessionId);
    };

    // 本轮 run 的标识（chat.send 被受理后下发）：流事件按它精确过滤
    const onRun = (data: { conversationId: string; sessionId?: string; runId: string }) => {
      if (data.conversationId !== conversationId) return;
      currentRunIdRef.current = data.runId;
    };

    // 推理模型思考流：过程展示 + 活动信号（长推理期间重置无活动超时）
    const onThinking = (data: { conversationId: string; sessionId?: string; delta: string }) => {
      if (!isCurrentRun(data)) return;
      if (!assistantIdRef.current) return; // 本地未跟踪 run——忽略残余思考事件（否则思考区卡在旧会话）
      lastActivityRef.current = Date.now();
      if (!data.delta) return;
      // 头部独立捕获：固定行要锚定思考的真正开头（缓冲尾部截断不影响它）。
      // 上限 400 字符——11px 字体 + 宽容器下两行约需 200-360 字符，120 撑不满两行
      // （修复"固行第二行为空"）；起首个 delta 去前导空白/换行，避免首行空白。
      if (thinkingHeadRef.current.length < 400) {
        const piece = thinkingHeadRef.current ? data.delta : data.delta.replace(/^\s+/, '');
        thinkingHeadRef.current = (thinkingHeadRef.current + piece).slice(0, 400);
        setThinkingHead(thinkingHeadRef.current);
      }
      thinkingBufRef.current = (thinkingBufRef.current + data.delta).slice(-6000);
      if (!thinkingTimerRef.current) {
        thinkingTimerRef.current = setTimeout(() => {
          thinkingTimerRef.current = null;
          setThinkingText(thinkingBufRef.current);
        }, 150);
      }
    };

    // 新一轮 LLM 调用：重置思考流（思考内容按轮次替换，不跨轮叠加）
    const onThinkingReset = (data: { conversationId: string; sessionId?: string }) => {
      if (!isCurrentRun(data)) return;
      lastActivityRef.current = Date.now();
      thinkingBufRef.current = '';
      thinkingHeadRef.current = '';
      setThinkingText('');
      setThinkingHead('');
    };

    // P0-1: context health — show usage / compaction / reset notices
    const onContext = (data: { conversationId: string; sessionId?: string } & ContextStatus) => {
      if (!isCurrentRun(data)) return;
      lastActivityRef.current = Date.now();
      setContextStatus({ usagePercent: data.usagePercent, level: data.level, detail: data.detail });
      // compacted/reset are transient toasts — downgrade to a quiet state after a few seconds
      if (data.level === 'compacted' || data.level === 'reset') {
        if (contextResetTimerRef.current) clearTimeout(contextResetTimerRef.current);
        contextResetTimerRef.current = setTimeout(() => {
          setContextStatus(prev => {
            if (!prev || prev.level !== data.level) return prev;
            // reset clears entirely (new session); compacted falls back to a usage badge
            return data.level === 'reset' ? null : { ...prev, level: 'warn', detail: undefined };
          });
        }, data.level === 'reset' ? 5000 : 3000);
      }
    };

    const onAction = (data: any) => {
      if (!isCurrentRun(data)) return;
      window.dispatchEvent(new CustomEvent('jianzhi:agent-action', { detail: data }));
    };

    const onConfirm = (data: any) => {
      if (!isCurrentRun(data)) return;
      lastActivityRef.current = Date.now();
      setPendingConfirm({
        confirmId: data.confirmId,
        toolName: data.toolName,
        args: data.args,
        parameters: data.parameters,
        confirmForm: data.confirmForm,
        timeoutSec: data.timeoutSec,
        description: data.description,
      });
    };

    // 重进会话恢复（chat.attach 响应）：running → 快照续流；done/error → 补全该轮；none → 无操作
    const onAttached = (data: {
      conversationId?: string; sessionId?: string; runId?: string;
      status: 'running' | 'done' | 'error' | 'none';
      snapshot?: { text: string; toolCalls?: ChatMessage['toolCalls']; model?: string; cost?: number; tokens?: any; error?: string; startedAt?: number };
    }) => {
      if (data.status === 'none') {
        // 后端已无此 run（如后端重启丢内存态）：本地若还在 streaming，按中断收尾，避免气泡卡死
        if (assistantIdRef.current) {
          const aid = assistantIdRef.current;
          const finalText = streamBatcherRef.current.flush();
          setMessages(prev => prev.map(m =>
            m.id === aid && !m.model ? { ...m, content: finalText || m.content, model: 'incomplete' } : m
          ));
          resetStreamUi();
        }
        return;
      }
      if (data.conversationId && data.conversationId !== conversationId) return;
      // 幂等：同一 run 的快照只应用一次（断线重连会重复 attach）
      const sig = `${data.sessionId}:${data.snapshot?.startedAt}:${data.status}:${(data.snapshot?.text || '').length}`;
      if (sig === lastAttachSigRef.current) return;
      lastAttachSigRef.current = sig;

      const sid = data.sessionId;
      if (sid) setSessionId(sid);

      const applySnapshot = () => {
        if (data.status === 'running') {
          // 续流前记录该 run 的 runId：后续实时事件按 runId 过滤，不记录会被全部丢弃
          if (data.runId) currentRunIdRef.current = data.runId;
          if (assistantIdRef.current) return; // 本端已在流式（如重连场景），仅 re-join room 即可
          const aid = `reattach-${Date.now()}`;
          assistantIdRef.current = aid;
          splitNextRef.current = false;
          streamBatcherRef.current.reset();
          streamBatcherRef.current.seed(data.snapshot?.text || '');
          // 按设计不恢复历史 thinking：思考区从空接后续增量
          setMessages(prev => [...prev, {
            id: aid, role: 'assistant' as const,
            content: data.snapshot?.text || '',
            toolCalls: data.snapshot?.toolCalls,
            timestamp: new Date(),
          }]);
          setIsStreaming(true);
          lastActivityRef.current = Date.now();
          armInactivityWatch();
        } else {
          // done/error：补全该轮最终消息（run 对应的 user 消息已落库，历史里已有，只补 assistant 侧）
          const text = data.snapshot?.text || '';
          const finalContent = data.status === 'error' && data.snapshot?.error
            ? `${text}${text ? '\n\n' : ''}⚠️ ${data.snapshot.error}` : text;
          if (!finalContent) return;
          setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.content === finalContent) return prev;
            return [...prev, {
              id: `reattach-done-${Date.now()}`, role: 'assistant' as const,
              content: finalContent, toolCalls: data.snapshot?.toolCalls,
              timestamp: new Date(), model: data.snapshot?.model || 'history',
              cost: data.snapshot?.cost, tokens: data.snapshot?.tokens,
            }];
          });
        }
      };

      // main agent 刷新恢复：消息列表为空且后端给了 sessionId → 先补拉历史再应用快照（避免覆盖）
      if (sid && messagesRef.current.length === 0 && tokenRef.current) {
        fetch(`${MAIN_URL}/api/sessions/${sid}/messages`, {
          headers: { 'Authorization': `Bearer ${tokenRef.current}` },
        }).then(r => r.json()).then(msgs => {
          if (Array.isArray(msgs) && msgs.length > 0 && messagesRef.current.length === 0) {
            setMessages(msgs.map((m: any) => ({
              id: m.id, role: m.role as 'user' | 'assistant' | 'system', content: m.content,
              timestamp: new Date(m.createdAt),
              model: m.role === 'assistant' ? (m.metadata?.model || 'history') : undefined,
            })));
          }
        }).catch(() => {}).finally(applySnapshot);
      } else {
        applySnapshot();
      }
    };

    if (!socket) return;

    socket.on('chat.stream', onStream);
    socket.on('chat.metadata', onMetadata);
    socket.on('chat.tool', onTool);
    socket.on('chat.debug', onDebug);
    socket.on('chat.error', onError);
    socket.on('chat.session', onSession);
    socket.on('chat.run', onRun);
    socket.on('chat.thinking', onThinking);
    socket.on('chat.thinking_reset', onThinkingReset);
    socket.on('chat.context', onContext);
    socket.on('chat.action', onAction);
    socket.on('chat.confirm', onConfirm);

    const onConfirmDismiss = (data: any) => {
      if (!isCurrentRun(data)) return;
      setPendingConfirm(null);
    };
    socket.on('chat.confirm_dismiss', onConfirmDismiss);

    // 活动信号：工具开始 / 回合心跳 —— 仅重置无活动超时，避免长工具/慢生成被误判超时
    const onActivity = (data: { conversationId: string; sessionId?: string }) => {
      if (!isCurrentRun(data)) return;
      lastActivityRef.current = Date.now();
    };
    socket.on('chat.tool_start', onActivity);
    socket.on('chat.keepalive', onActivity);
    socket.on('chat.attached', onAttached);

    // socket 断线重连：room 随旧 socket 销毁，需重新 attach 接续进行中的 run。
    // 非 main 且无 sessionId 时不发（避免 attach 到非当前查看会话的 run）；该场景由自动加载流程按 sid attach
    const onReconnect = () => {
      if (agentId === 'main' || sessionIdRef.current) {
        socket.emit('chat.attach', { sessionId: sessionIdRef.current || undefined, agentId });
      }
    };
    socket.on('connect', onReconnect);

    return () => {
      streamBatcherRef.current.flush();
      socket.off('connect', onReconnect);
      socket.off('chat.attached', onAttached);
      socket.off('chat.tool_start', onActivity);
      socket.off('chat.keepalive', onActivity);
      socket.off('chat.stream', onStream);
      socket.off('chat.metadata', onMetadata);
      socket.off('chat.tool', onTool);
      socket.off('chat.debug', onDebug);
      socket.off('chat.error', onError);
      socket.off('chat.session', onSession);
      socket.off('chat.run', onRun);
      socket.off('chat.thinking', onThinking);
      socket.off('chat.thinking_reset', onThinkingReset);
      socket.off('chat.context', onContext);
      socket.off('chat.action', onAction);
      socket.off('chat.confirm', onConfirm);
      socket.off('chat.confirm_dismiss', onConfirmDismiss);
    };
  }, [conversationId, socket, agentId, armInactivityWatch, resetStreamUi]);

  const uploadFile = useCallback(async (file: File): Promise<Attachment | null> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('fileName', file.name);
    try {
      const headers: Record<string, string> = {};
      if (tokenRef.current) headers['Authorization'] = `Bearer ${tokenRef.current}`;
      const resp = await fetch(`${MAIN_URL}/api/files/upload`, { method: 'POST', headers, body: formData });
      const data = await resp.json();
      if (data.filePath) {
        const attachment: Attachment = { filePath: data.filePath, fileName: data.fileName };
        setPendingAttachments(prev => [...prev, attachment]);
        return attachment;
      }
    } catch {}
    return null;
  }, []);

  const removePendingAttachment = useCallback((idx: number) => {
    setPendingAttachments(prev => prev.filter((_, i) => i !== idx));
  }, []);

  const sendMessage = useCallback((content: string, pageContext?: { panel?: string; title?: string; nav?: string; url?: string; labels?: string[] }) => {
    const attachments = pendingAttachments.length > 0 ? [...pendingAttachments] : undefined;

    let displayContent = content;
    if (attachments) {
      displayContent = content + '\n' + attachments.map(a => `📎 ${a.fileName}`).join('\n');
    }

    const userMsg: ChatMessage = {
      id: Date.now().toString(), role: 'user',
      content: displayContent, attachments, timestamp: new Date(),
    };

    const assistantId = (Date.now() + 1).toString();
    const assistantMsg: ChatMessage = {
      id: assistantId, role: 'assistant', content: '', timestamp: new Date(),
    };

    assistantIdRef.current = assistantId;
    splitNextRef.current = false;
    thinkingBufRef.current = '';
    thinkingHeadRef.current = '';
    setThinkingText('');
    setThinkingHead('');
    streamBatcherRef.current.reset();
    setDebugEvents([]);
    setErrorHint('');
    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsStreaming(true);
    setPendingAttachments([]);

    if (!socket) return;
    socket.emit('chat.send', { conversationId, agentId, sessionId, content, attachments, pageContext, forceNewSession: forceNewRef.current });
    forceNewRef.current = false;  // 仅对"新建会话"后的第一条消息生效
    lastActivityRef.current = Date.now();
    armInactivityWatch();
  }, [conversationId, socket, pendingAttachments, agentId, sessionId, armInactivityWatch]);

  /** Load a historical session's messages */
  const loadSession = useCallback(async (sid: string) => {
    setSessionId(sid);
    // 先重置流式瞬态：旧会话的 done/thinking 已被 sessionId 过滤丢弃，不清会永久卡住
    resetStreamUi();
    try {
      const tkn = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
      const headers: Record<string, string> = {};
      if (tkn) headers['Authorization'] = `Bearer ${tkn}`;
      const resp = await fetch(`${MAIN_URL}/api/sessions/${sid}/messages`, { headers });
      const data = await resp.json();
      const msgs = Array.isArray(data) ? data : (data.messages || data.data || []);
      const loaded: ChatMessage[] = msgs.map((m: any) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
        timestamp: new Date(m.createdAt),
        model: m.role === 'assistant' ? (m.metadata?.model || 'history') : undefined,
        // 历史恢复时还原工具调用（含面板消息 _panel_output，供图纸预览等面板数据重建）
        toolCalls: m.metadata?.toolCalls,
      }));
      setMessages(loaded);
    } catch {}
    // 历史加载完再 attach：若该会话有进行中的 run，快照续流（避免历史覆盖快照）
    attachSession(sid);
  }, [attachSession, resetStreamUi]);

  /** Start a new session (clear messages, reset sessionId) */
  const newSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setDebugEvents([]);
    setContextStatus(null);
    resetStreamUi();  // 旧 run 残余事件由 handler 的 assistantIdRef 防御拦截
    forceNewRef.current = true;  // 下一条消息带 forceNewSession，后端强制开新会话（不复用最近会话）
  }, [resetStreamUi]);

  /** Reply to a pending tool parameter confirmation */
  const confirmReply = useCallback((confirmed: boolean, editedArgs?: Record<string, any>) => {
    if (!pendingConfirm || !socket) return;
    socket.emit('chat.confirm_reply', {
      confirmId: pendingConfirm.confirmId,
      confirmed,
      editedArgs,
    });
    setPendingConfirm(null);
  }, [pendingConfirm, socket]);

  const stopGeneration = useCallback(() => {
    if (!isStreaming) return;
    // Notify backend to abort the agent run（带 sessionId：只中止当前会话，避免池内其他会话被取消后各自再发一条取消消息）
    if (socket) {
      socket.emit('chat.cancel', { conversationId, sessionId });
    }
    // Append cancellation text to current stream and force done
    const aid = assistantIdRef.current;
    const finalText = streamBatcherRef.current.flush();
    setMessages(prev => prev.map(m =>
      m.id === aid ? { ...m, content: (finalText || '') + '\n\n*(用户取消了会话)*', model: 'cancelled' } : m
    ));
    streamBatcherRef.current.reset();
    assistantIdRef.current = '';
    currentRunIdRef.current = null;
    setIsStreaming(false);
    if (inactivityTimerRef.current) { clearInterval(inactivityTimerRef.current); inactivityTimerRef.current = null; }
  }, [isStreaming, socket, conversationId, sessionId]);

  return {
    messages, isStreaming, errorHint, sendMessage, stopGeneration, debugEvents,
    uploadFile, pendingAttachments, removePendingAttachment,
    sessionId, loadSession, newSession,
    pendingConfirm, confirmReply,
    contextStatus, thinkingText, thinkingHead,
  };
}
