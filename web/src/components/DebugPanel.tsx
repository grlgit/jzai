'use client';

import { useEffect, useRef } from 'react';
import { DebugEvent } from '@/hooks/useChat';

interface Props {
  events: DebugEvent[];
  isStreaming: boolean;
}

/** Color and icon for each event type */
function getEventStyle(evt: DebugEvent) {
  const t = evt.eventType;
  if (t === 'message_update') return { color: 'text-orange-600', bg: 'bg-orange-50', icon: '🔧' };
  if (t === 'message_start') return { color: 'text-blue-600', bg: 'bg-blue-50', icon: '▶' };
  if (t === 'message_end') return { color: 'text-blue-600', bg: 'bg-blue-50', icon: '■' };
  if (t === 'tool_execution_start') return { color: 'text-amber-600', bg: 'bg-amber-50', icon: '⏳' };
  if (t === 'tool_execution_end') return { color: 'text-green-600', bg: 'bg-green-50', icon: '✅' };
  if (t === 'prompt_context') return { color: 'text-cyan-600', bg: 'bg-cyan-50', icon: '📋' };
  if (t === 'turn_start' || t === 'turn_end') return { color: 'text-gray-500', bg: 'bg-gray-50', icon: '🔄' };
  if (t === 'agent_start' || t === 'agent_end') return { color: 'text-indigo-600', bg: 'bg-indigo-50', icon: '🤖' };
  return { color: 'text-gray-500', bg: 'bg-gray-50', icon: '•' };
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const hms = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hms}.${ms}`;
}

function truncate(s: string, max: number) {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export default function DebugPanel({ events, isStreaming }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [events.length]);

  if (events.length === 0 && !isStreaming) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        <div className="text-center">
          <div className="text-3xl mb-2">🔍</div>
          <div>发送消息后，调试事件流将显示在此处</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto font-mono text-xs">
      {/* Legend */}
      <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-gray-100 px-3 py-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-500 z-10">
        <span>📋 Prompt上下文</span>
        <span>▶■ LLM消息</span>
        <span>🔧 LLM请求工具</span>
        <span>⏳✅ 工具执行</span>
        <span>🔄 轮次</span>
        <span>🤖 Agent</span>
      </div>

      <div className="divide-y divide-gray-50">
        {events.map((evt, i) => {
          const style = getEventStyle(evt);
          return (
            <div key={i} className={`px-3 py-1.5 ${style.bg} hover:brightness-95 transition-colors`}>
              {/* Header line */}
              <div className="flex items-center gap-1.5">
                <span className="flex-shrink-0">{style.icon}</span>
                <span className={`font-semibold ${style.color}`}>{evt.eventLabel}</span>
                {evt.subLabel && (
                  <span className="text-gray-400">→ {evt.subLabel}</span>
                )}
                {evt.toolName && (
                  <span className="px-1.5 py-0 rounded bg-white/80 border border-gray-200 text-gray-600">{evt.toolName}</span>
                )}
                <span className="ml-auto text-gray-300 flex-shrink-0">{formatTime(evt.timestamp)}</span>
              </div>

              {/* Detail lines */}
              {evt.toolArgs && (
                <div className="mt-0.5 pl-5 text-orange-700">
                  <span className="text-gray-400">参数: </span>
                  {truncate(JSON.stringify(evt.toolArgs), 300)}
                </div>
              )}

              {evt.toolResult && (
                <details className="mt-0.5 pl-5">
                  <summary className="text-amber-700 cursor-pointer hover:underline">工具返回结果 (展开)</summary>
                  <pre className="mt-1 p-2 bg-white/80 rounded border border-gray-200 text-gray-700 overflow-x-auto max-h-40 whitespace-pre-wrap break-all">
                    {JSON.stringify(evt.toolResult, null, 2)}
                  </pre>
                </details>
              )}

              {evt.usage && (
                <div className="mt-0.5 pl-5 text-purple-600">
                  {Object.entries(evt.usage)
                    .filter(([k]) => k !== 'type')
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' | ')}
                </div>
              )}

              {/* LLM response text (attached to message_end) */}
              {(evt as any).responseText && (
                <details className="mt-1 pl-5">
                  <summary className="text-blue-600 cursor-pointer hover:underline">LLM 完整响应</summary>
                  <pre className="mt-1 p-2 bg-white/80 rounded border border-blue-200 text-gray-700 overflow-x-auto max-h-60 whitespace-pre-wrap text-[11px]">
                    {(evt as any).responseText}
                  </pre>
                </details>
              )}

              {/* Prompt context: system prompt + message history */}
              {evt.eventType === 'prompt_context' && (evt as any).systemPrompt && (
                <div className="mt-1 pl-5 space-y-2">
                  <div className="text-cyan-600 text-[10px] font-medium">模型: {(evt as any).model}</div>
                  <details open>
                    <summary className="text-cyan-700 cursor-pointer hover:underline">System Prompt</summary>
                    <pre className="mt-1 p-2 bg-white/80 rounded border border-cyan-200 text-gray-700 overflow-x-auto max-h-48 whitespace-pre-wrap text-[11px]">
                      {(evt as any).systemPrompt}
                    </pre>
                  </details>
                  {(evt as any).messageHistory?.length > 0 && (
                    <details>
                      <summary className="text-cyan-700 cursor-pointer hover:underline">
                        消息历史 ({(evt as any).messageHistory.length} 条)
                      </summary>
                      <div className="mt-1 space-y-1">
                        {(evt as any).messageHistory.map((m: any, j: number) => (
                          <div key={j} className={`p-2 rounded border text-[11px] whitespace-pre-wrap ${
                            m.role === 'user' ? 'bg-blue-50/50 border-blue-200' :
                            m.role === 'assistant' ? 'bg-green-50/50 border-green-200' :
                            'bg-gray-50 border-gray-200'
                          }`}>
                            <span className={`font-semibold ${
                              m.role === 'user' ? 'text-blue-600' :
                              m.role === 'assistant' ? 'text-green-600' : 'text-gray-500'
                            }`}>
                              {m.role === 'user' ? '用户' : m.role === 'assistant' ? '助手' : m.role}:
                            </span>
                            <span className="ml-1 text-gray-700">{truncate(m.content, 500)}</span>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                  <div className="p-2 rounded border bg-blue-50/50 border-blue-200 text-[11px]">
                    <span className="font-semibold text-blue-600">当前用户消息:</span>
                    <span className="ml-1 text-gray-700">{(evt as any).userMessage}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {isStreaming && (
        <div className="px-3 py-2 text-gray-400 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
          等待事件...
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}
