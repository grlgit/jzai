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

  // Clear state and load latest session when agent/conversation changes
  useEffect(() => {
    setMessages([]);
    setDebugEvents([]);
    setSessionId(null);
    setIsStreaming(false);
    setContextStatus(null);
    streamBatcherRef.current.reset();
    assistantIdRef.current = '';
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
              })));
            }
          }).catch(() => {});
        }
      }).catch(() => {});
    }
  }, [agentId, token]);

  useEffect(() => {
    const onStream = (data: { conversationId: string; delta: string; done: boolean; model?: string; cost?: number; tokens?: { input: number; output: number; total: number } }) => {
      if (data.conversationId !== conversationId) return;
      lastActivityRef.current = Date.now();
      if (data.done) {
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

    const onMetadata = (data: { conversationId: string; source: { file: string; page?: number } }) => {
      if (data.conversationId !== conversationId) return;
      const aid = assistantIdRef.current;
      setMessages(prev => prev.map(m =>
        m.id === aid ? { ...m, source: data.source } : m
      ));
    };

    const onTool = (data: { conversationId: string; toolName: string; args?: any; result?: any }) => {
      if (data.conversationId !== conversationId) return;
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

    const onError = (data: { conversationId: string; error: string }) => {
      if (data.conversationId !== conversationId) return;
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
      if (data.conversationId !== conversationId) return;
      lastActivityRef.current = Date.now();
      setDebugEvents(prev => [...prev, data as DebugEvent]);
    };

    const onSession = (data: { conversationId: string; sessionId: string }) => {
      if (data.conversationId !== conversationId) return;
      setSessionId(data.sessionId);
    };

    // 推理模型思考流：过程展示 + 活动信号（长推理期间重置无活动超时）
    const onThinking = (data: { conversationId: string; delta: string }) => {
      if (data.conversationId !== conversationId) return;
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
    const onThinkingReset = (data: { conversationId: string }) => {
      if (data.conversationId !== conversationId) return;
      lastActivityRef.current = Date.now();
      thinkingBufRef.current = '';
      thinkingHeadRef.current = '';
      setThinkingText('');
      setThinkingHead('');
    };

    // P0-1: context health — show usage / compaction / reset notices
    const onContext = (data: { conversationId: string } & ContextStatus) => {
      if (data.conversationId !== conversationId) return;
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
      if (data.conversationId !== conversationId) return;
      window.dispatchEvent(new CustomEvent('jianzhi:agent-action', { detail: data }));
    };

    const onConfirm = (data: any) => {
      if (data.conversationId !== conversationId) return;
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

    if (!socket) return;

    socket.on('chat.stream', onStream);
    socket.on('chat.metadata', onMetadata);
    socket.on('chat.tool', onTool);
    socket.on('chat.debug', onDebug);
    socket.on('chat.error', onError);
    socket.on('chat.session', onSession);
    socket.on('chat.thinking', onThinking);
    socket.on('chat.thinking_reset', onThinkingReset);
    socket.on('chat.context', onContext);
    socket.on('chat.action', onAction);
    socket.on('chat.confirm', onConfirm);

    const onConfirmDismiss = (data: any) => {
      if (data.conversationId !== conversationId) return;
      setPendingConfirm(null);
    };
    socket.on('chat.confirm_dismiss', onConfirmDismiss);

    // 活动信号：工具开始 / 回合心跳 —— 仅重置无活动超时，避免长工具/慢生成被误判超时
    const onActivity = (data: { conversationId: string }) => {
      if (data.conversationId !== conversationId) return;
      lastActivityRef.current = Date.now();
    };
    socket.on('chat.tool_start', onActivity);
    socket.on('chat.keepalive', onActivity);

    return () => {
      streamBatcherRef.current.flush();
      socket.off('chat.tool_start', onActivity);
      socket.off('chat.keepalive', onActivity);
      socket.off('chat.stream', onStream);
      socket.off('chat.metadata', onMetadata);
      socket.off('chat.tool', onTool);
      socket.off('chat.debug', onDebug);
      socket.off('chat.error', onError);
      socket.off('chat.session', onSession);
      socket.off('chat.thinking', onThinking);
      socket.off('chat.thinking_reset', onThinkingReset);
      socket.off('chat.context', onContext);
      socket.off('chat.action', onAction);
      socket.off('chat.confirm', onConfirm);
      socket.off('chat.confirm_dismiss', onConfirmDismiss);
    };
  }, [conversationId, socket]);

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

    // 兜底超时：后端有自己的 180s 无活动看门狗(会 abort 并发 chat.error)，且回合存活期每 45s 发心跳。
    // 故前端阈值抬到 240s（>后端 180s + 心跳间隔）——只在"连心跳都收不到"(断线/后端真死)时才触发。
    // 触发时补发 chat.cancel 终止服务端前台 loop，消除"前端超时、后端还在跑"的不一致。
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
  }, [conversationId, socket, pendingAttachments, agentId, sessionId]);

  /** Load a historical session's messages */
  const loadSession = useCallback(async (sid: string) => {
    setSessionId(sid);
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
      }));
      setMessages(loaded);
    } catch {}
  }, []);

  /** Start a new session (clear messages, reset sessionId) */
  const newSession = useCallback(() => {
    setSessionId(null);
    setMessages([]);
    setDebugEvents([]);
    setContextStatus(null);
    forceNewRef.current = true;  // 下一条消息带 forceNewSession，后端强制开新会话（不复用最近会话）
  }, []);

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
