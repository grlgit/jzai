'use client';

import { useEffect, useRef, useState, memo, useCallback, useMemo, Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '@/i18n';
import { useMessageDisplay } from '@/hooks/useMessageDisplay';
import type { ChatMessage, PendingConfirm } from '@/hooks/useChat';
import ConfirmFormCard from '@/components/ConfirmFormDialog';
import InlineChart from '@/components/dashboard/InlineChart';
import { apiFetch } from '@/modules/kb/lib/api';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

const TOOL_LABEL_KEYS: Record<string, string> = {
  search_knowledge: 'chat.searchKb', get_character: 'chat.getCharacter', get_rules: 'chat.getRules',
  suggest_knowledge: 'chat.suggestKnowledge', parse_attachment: 'chat.parseAttachment',
  analyze_har: 'chat.analyzeHar', test_skill: 'chat.testSkill', reload_skills: 'chat.loadSkills',
  read: 'chat.readFile', edit: 'chat.editFile', write: 'chat.writeFile',
};

const REMARK_PLUGINS = [remarkGfm];

const MARKDOWN_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => { e.stopPropagation(); }}>{children}</a>
  ),
  pre: ({ children }: { children?: React.ReactNode }) => {
    const child = Array.isArray(children) ? children[0] : children;
    if (child && typeof child === 'object' && 'props' in child) {
      const cls = child.props.className || '';
      if (cls === 'language-chart') {
        try {
          const chartSpec = JSON.parse(String(child.props.children));
          return <InlineChart type={chartSpec.type} title={chartSpec.title} data={chartSpec.data} config={chartSpec.config} />;
        } catch { /* fall through to default rendering */ }
      }
    }
    return <pre>{children}</pre>;
  },
};

interface ChatMessagesProps {
  messages: ChatMessage[];
  compact?: boolean;
  isStreaming?: boolean;
  thinkingText?: string;
  thinkingHead?: string;
  onResend?: (content: string) => void;
  onButtonClick?: (text: string) => void;
  activeAgent?: string;
  pendingConfirm?: PendingConfirm | null;
  onConfirmReply?: (confirmed: boolean, editedArgs?: Record<string, any>) => void;
}

/**
 * 推理模型思考流：无边框无底色的纯文本区。
 * - 固定行：思考的开头两行（head 独立锚定，不随缓冲截断滚动）
 *   用固定行高 + overflow-hidden 保证"完整两行"，不用 line-clamp（会在第二行末尾出省略号）
 * - 折叠提示：点击在"末尾两行滚动跟随"与"8 行可滚动全文"之间切换
 */
function ThinkingBlock({ head, text }: { head: string; text: string }) {
  const [expanded, setExpanded] = useState(false);
  const tailRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = tailRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, expanded]);
  useEffect(() => {
    const el = fullRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, expanded]);
  return (
    <div className="text-[11px] text-gray-400 italic leading-5 px-1">
      {/* 固定两行：2 × 20px(leading-5) = h-10，完整两行、无省略号；折线箭头并入行末，不单独占行 */}
      <div className="flex items-end gap-1">
        <div className="h-10 flex-1 min-w-0 overflow-hidden whitespace-pre-wrap break-words">{head}</div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="shrink-0 text-gray-300 hover:text-gray-500 not-italic leading-5 px-0.5"
          title={expanded ? '收起' : '展开全部'}
        >
          {expanded ? '▴' : '▾'}
        </button>
      </div>
      {expanded ? (
        <div ref={fullRef} className="h-36 overflow-y-auto whitespace-pre-wrap break-words">{text}</div>
      ) : (
        /* 滚动跟随区同样完整两行 */
        <div ref={tailRef} className="h-10 overflow-hidden whitespace-pre-wrap break-words">{text}</div>
      )}
    </div>
  );
}

export default function ChatMessages({ messages, compact, isStreaming, thinkingText, thinkingHead, onResend, onButtonClick, activeAgent, pendingConfirm, onConfirmReply }: ChatMessagesProps) {
  const { t } = useI18n();
  const { shouldShow } = useMessageDisplay(activeAgent);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const userScrolledUp = useRef(false);

  // Track if user has scrolled away from bottom
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      userScrolledUp.current = !atBottom;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll: only if user is near bottom, use instant for streaming
  useEffect(() => {
    if (userScrolledUp.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Force scroll to bottom when confirm form appears
  useEffect(() => {
    if (!pendingConfirm) return;
    const el = containerRef.current;
    if (el) {
      userScrolledUp.current = false;
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }
  }, [pendingConfirm]);

  // Precompute previous user content for each assistant message so resend handlers stay stable.
  const prevUserContentById = useMemo(() => {
    const map = new Map<string, string>();
    if (!onResend) return map;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'assistant') continue;
      for (let j = i - 1; j >= 0; j--) {
        if (messages[j].role === 'user') {
          map.set(messages[i].id, messages[j].content);
          break;
        }
      }
    }
    return map;
  }, [messages, onResend]);

  if (messages.length === 0) return <div className="flex-1" />;

  const lastMsg = messages[messages.length - 1];
  // 等待指示由 hook 的 isStreaming 驱动、渲染在列表底部——不依赖"最后一条是空 assistant 气泡"，
  // 分段气泡/系统状态行插入后依然持续可见；空内容气泡自身不再渲染常驻点点点。
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  const lastToolCall = isStreaming && lastAssistant?.toolCalls?.length
    ? lastAssistant.toolCalls[lastAssistant.toolCalls.length - 1] : null;
  const toolLabelKey = lastToolCall ? TOOL_LABEL_KEYS[lastToolCall.name] : null;
  const activeToolLabel = lastToolCall ? (toolLabelKey ? t(toolLabelKey) : lastToolCall.name) : null;

  // 思考块定位：最后一条是 assistant 气泡时渲染在其正下方（汽泡在上、思考在下），
  // 否则落列表底部。消除时机不变（done/error/新消息时由 useChat 清空）。
  const thinkingAbove = !!(isStreaming && thinkingText && lastMsg?.role === 'assistant');

  return (
    <div ref={containerRef} className={`flex-1 overflow-y-auto overflow-x-hidden min-w-0 flex flex-col gap-3 ${compact ? 'p-3' : 'px-[15%] py-4'}`}>
      {messages.map((msg) => (
        <Fragment key={msg.id}>
          <MessageItem
            msg={msg}
            compact={compact}
            isLast={msg.id === lastMsg.id}
            resendContent={prevUserContentById.get(msg.id)}
            shouldShow={shouldShow}
            t={t}
            onResend={onResend}
            onButtonClick={onButtonClick}
          />
          {/* 思考过程置于最新汽泡下方（用户调优 2026-09-09：汽泡在上、思考在下） */}
          {thinkingAbove && msg.id === lastMsg.id && (
            <ThinkingBlock head={thinkingHead || ''} text={thinkingText!} />
          )}
        </Fragment>
      ))}
      {!thinkingAbove && isStreaming && thinkingText ? <ThinkingBlock head={thinkingHead || ''} text={thinkingText} /> : null}
      {isStreaming && (
        <div className="flex items-center gap-2 text-gray-400 text-xs">
          <span className="flex gap-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
          </span>
          {shouldShow('toolProcess') && activeToolLabel && (
            <span className="text-[11px] text-gray-400 animate-pulse">{activeToolLabel}...</span>
          )}
        </div>
      )}
      {pendingConfirm && onConfirmReply && (
        <ConfirmFormCard
          toolName={pendingConfirm.toolName}
          description={pendingConfirm.description}
          args={pendingConfirm.args}
          parameters={pendingConfirm.parameters}
          confirmForm={pendingConfirm.confirmForm}
          onConfirm={(editedArgs) => onConfirmReply(true, editedArgs)}
          onCancel={() => onConfirmReply(false)}
        />
      )}
      <div ref={bottomRef} />
    </div>
  );
}

interface MessageItemProps {
  msg: ChatMessage;
  compact?: boolean;
  isLast: boolean;
  resendContent?: string;
  shouldShow: (k: 'toolProcess' | 'toolResult' | 'sourceRef' | 'modelUsage') => boolean;
  t: (k: string, p?: any) => string;
  onResend?: (content: string) => void;
  onButtonClick?: (text: string) => void;
}

const MessageItem = memo(function MessageItem({
  msg, compact, isLast, resendContent, shouldShow, t, onResend, onButtonClick,
}: MessageItemProps) {
  return (
    <div className={`min-w-0 ${msg.role === 'user' ? 'self-end max-w-[80%]' : 'self-stretch'}`}>
      {msg.role === 'user' ? (
        <div className="bg-gray-100 rounded-lg px-3 py-2 text-xs leading-relaxed text-gray-900 whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      ) : msg.role === 'system' ? (
        <div className="bg-blue-50 rounded-lg px-3 py-1.5 text-[11px] text-blue-600 border border-blue-100 break-words">
          {msg.content}
        </div>
      ) : (
        <div>
          {shouldShow('toolResult') && msg.toolCalls?.length ? (
            <div className="mb-2 space-y-1">
              {msg.toolCalls.filter(tc => tc.result && tc.name !== 'suggest_kb_save').map((tc, i) => (
                <ToolResultBlock key={i} name={tc.name} args={tc.args} result={tc.result!} labelKeys={TOOL_LABEL_KEYS} t={t} />
              ))}
            </div>
          ) : null}
          {msg.toolCalls?.filter(tc => tc.name === 'suggest_kb_save').map((tc, i) => (
            <SaveKbCard key={`kb-${i}`} data={(tc.result?.details?.actionData) || tc.args || {}} />
          ))}
          {/* 空内容气泡不渲染等待点——等待指示统一由列表底部的 isStreaming 行承担，
              避免无文本的气泡（如仅含工具卡的分段）常驻点点点 */}
          {msg.content ? (
            <AssistantContent msg={msg} isLast={isLast} shouldShow={shouldShow} t={t} resendContent={resendContent} onResend={onResend} onButtonClick={onButtonClick} />
          ) : null}
        </div>
      )}
    </div>
  );
});

interface AssistantContentProps {
  msg: ChatMessage;
  isLast: boolean;
  shouldShow: (k: 'toolProcess' | 'toolResult' | 'sourceRef' | 'modelUsage') => boolean;
  t: (k: string, p?: any) => string;
  resendContent?: string;
  onResend?: (content: string) => void;
  onButtonClick?: (text: string) => void;
}

const AssistantContent = memo(function AssistantContent({ msg, isLast, shouldShow, t, resendContent, onResend, onButtonClick }: AssistantContentProps) {
  const btnMatch = msg.content.match(/<!-- buttons:(.*?) -->/);
  const btnLabels = btnMatch ? btnMatch[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  const textContent = btnMatch ? msg.content.replace(/<!-- buttons:.*? -->/, '').trimEnd() : msg.content;

  const handleResend = useCallback(() => {
    if (resendContent) onResend?.(resendContent);
  }, [resendContent, onResend]);

  return <>
    <div className="prose prose-xs prose-gray max-w-none min-w-0 break-words text-xs leading-relaxed [&_p]:my-1 [&_pre]:bg-gray-900 [&_pre]:text-green-300 [&_pre]:rounded-lg [&_pre]:p-2.5 [&_pre]:text-[11px] [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:text-indigo-600 [&_code]:bg-indigo-50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[11px] [&_code]:break-all [&_pre_code]:text-green-300 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:break-normal [&_img]:max-w-full [&_img]:h-auto [&_table]:text-xs [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:border [&_table]:border-gray-200 [&_table]:rounded-lg [&_th]:bg-gray-50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:border [&_th]:border-gray-200 [&_th]:text-left [&_th]:font-semibold [&_td]:px-3 [&_td]:py-1.5 [&_td]:border [&_td]:border-gray-200 [&_blockquote]:border-indigo-300 [&_blockquote]:text-gray-600 [&_blockquote]:pl-3 [&_blockquote]:my-2 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_ul]:my-1 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-1 [&_ol]:pl-5 [&_ol]:list-decimal [&_li]:my-0.5 [&_li]:pl-0.5">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={MARKDOWN_COMPONENTS}>{textContent}</ReactMarkdown>
    </div>
    {btnLabels.length > 0 && msg.model !== undefined && (
      <div className="flex gap-2 mt-2">
        {btnLabels.map(label => (
          <button key={label}
            className="px-3 py-1 text-xs rounded-full border border-indigo-300 text-indigo-600 hover:bg-indigo-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={!isLast}
            onClick={() => onButtonClick?.(label)}
          >{label}</button>
        ))}
      </div>
    )}
    {shouldShow('sourceRef') && msg.source && (
      <div className="text-[10px] text-gray-400 mt-1">
        📎 <a href="#" className="text-indigo-500 hover:underline">{msg.source.file}{msg.source.page ? ` (${t('chat.page', { page: msg.source.page })})` : ''}</a>
      </div>
    )}
    {msg.model !== undefined && <div className="flex items-center gap-2 mt-1.5">
      <MessageActions messageId={msg.id} content={textContent} onResend={handleResend} />
      {shouldShow('modelUsage') && (msg.model || msg.tokens) && (
        <div className="flex items-center gap-1.5 text-[10px] text-gray-400">
          {msg.model && (
            <span className="px-1.5 py-0.5 bg-gray-100 rounded-full" title={t('chat.currentModel')}>{msg.model}</span>
          )}
          {msg.tokens && msg.tokens.total > 0 && (
            <span className="px-1.5 py-0.5 bg-gray-100 rounded-full" title={t('chat.tokenUsage')}>
              {(msg.tokens.total / 1000).toFixed(1)}k tokens
            </span>
          )}
        </div>
      )}
    </div>}
  </>;
});

const ToolResultBlock = memo(function ToolResultBlock({ name, args, result, labelKeys, t }: { name: string; args?: any; result: any; labelKeys: Record<string, string>; t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const label = labelKeys[name] ? t(labelKeys[name]) : name;

  const argsText = args ? (typeof args === 'string' ? args : JSON.stringify(args, null, 2)) : '';
  const argsSummary = args ? (typeof args === 'object'
    ? Object.entries(args).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(', ')
    : String(args)) : '';

  const resultText = typeof result === 'string' ? result
    : result?.content ? (Array.isArray(result.content) ? result.content.map((c: any) => c.text || '').join('\n') : String(result.content))
    : JSON.stringify(result, null, 2);
  const preview = argsSummary
    ? (argsSummary.length > 60 ? argsSummary.slice(0, 60) + '...' : argsSummary)
    : (resultText.length > 80 ? resultText.slice(0, 80) + '...' : resultText);

  const chartMatch = resultText.match(/```chart\n([\s\S]*?)\n```/);
  if (chartMatch) {
    try {
      const spec = JSON.parse(chartMatch[1]);
      return <InlineChart type={spec.type} title={spec.title} data={spec.data} config={spec.config} />;
    } catch { /* fall through to default */ }
  }
  const linkMatch = resultText.match(/\[📥[^\]]*\]\([^)]+\)/);
  if (linkMatch) {
    return (
      <div className="text-xs py-1">
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={{
          a: ({ href, children }: { href?: string; children?: React.ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-indigo-600 underline">{children}</a>,
        }}>{resultText}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className="border border-gray-100 rounded-lg text-[11px] bg-gray-50/50">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-gray-50 rounded-lg">
        <span className="text-green-500 shrink-0">&#9654;</span>
        <span className="text-gray-500 font-medium shrink-0">{label}</span>
        <span className="text-gray-400 truncate flex-1">{!open && preview}</span>
        <span className="text-gray-300 shrink-0">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 space-y-1.5">
          {argsText && (
            <div>
              <div className="text-[10px] text-indigo-500 font-medium mb-0.5">参数</div>
              <pre className="text-[10px] text-gray-600 bg-indigo-50/50 rounded px-2 py-1 whitespace-pre-wrap break-all max-h-24 overflow-auto">{argsText}</pre>
            </div>
          )}
          <div>
            <div className="text-[10px] text-green-600 font-medium mb-0.5">结果</div>
            <pre className="text-[10px] text-gray-500 bg-green-50/50 rounded px-2 py-1 whitespace-pre-wrap break-all max-h-40 overflow-auto">{resultText}</pre>
          </div>
        </div>
      )}
    </div>
  );
});

const MessageActions = memo(function MessageActions({ messageId, content, onResend }: { messageId: string; content: string; onResend: () => void }) {
  const { t } = useI18n();
  const [voted, setVoted] = useState<'up' | 'down' | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const vote = (rating: 'up' | 'down') => {
    if (voted) return;
    setVoted(rating);
    fetch(`${MAIN_URL}/api/analytics/feedback`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ messageId, rating }),
    }).catch(() => {});
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(content).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const handleShare = () => {
    if (navigator.share) navigator.share({ text: content }).catch(() => {});
    else handleCopy();
  };

  const handleSaveKnowledge = () => {
    if (saving || saved) return;
    setSaving(true);
    fetch(`${MAIN_URL}/api/kb/personal-knowledge`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ content, tags: ['from-chat'] }),
    })
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(() => { setSaved(true); setTimeout(() => setSaved(false), 3000); })
      .catch(() => { setSaved(false); })
      .finally(() => setSaving(false));
  };

  const btnClass = 'p-1 rounded hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600';
  const activeClass = 'p-1 rounded transition-colors';

  return (
    <div className="flex items-center gap-0.5">
      <button onClick={handleCopy} className={btnClass} title={t('chat.copy')}>
        {copied ? (
          <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
        )}
      </button>
      <button onClick={() => vote('up')} disabled={!!voted}
        className={voted === 'up' ? `${activeClass} text-green-500` : `${btnClass} ${voted ? 'opacity-30' : ''}`} title={t('chat.like')}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zM7 22H4a2 2 0 01-2-2v-7a2 2 0 012-2h3" /></svg>
      </button>
      <button onClick={() => vote('down')} disabled={!!voted}
        className={voted === 'down' ? `${activeClass} text-red-500` : `${btnClass} ${voted ? 'opacity-30' : ''}`} title={t('chat.dislike')}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M10 15V19a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10zM17 2h2.67A2.31 2.31 0 0122 4v7a2.31 2.31 0 01-2.33 2H17" /></svg>
      </button>
      <button onClick={handleSaveKnowledge} disabled={saving || saved}
        className={saved ? `${activeClass} text-blue-500` : btnClass} title="保存为个人知识">
        {saved ? (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
        ) : saving ? (
          <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" /></svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" /></svg>
        )}
      </button>
      <button onClick={handleShare} className={btnClass} title={t('chat.share')}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8M16 6l-4-4-4 4M12 2v13" /></svg>
      </button>
      <button onClick={onResend} className={btnClass} title={t('chat.resend')}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M1 4v6h6M23 20v-6h-6" /><path strokeLinecap="round" strokeLinejoin="round" d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" /></svg>
      </button>
    </div>
  );
});

const SaveKbCard = memo(function SaveKbCard({ data }: { data: { title?: string; content?: string; category?: string; tags?: string[] } }) {
  const { title = '', content = '', category = '', tags = [] } = data;
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [expanded, setExpanded] = useState(false);

  const handleSave = async () => {
    if (state === 'saving' || state === 'saved') return;
    setState('saving');
    try {
      const kbs = await apiFetch<any[]>('/v1/knowledge-bases');
      const kb = Array.isArray(kbs) ? kbs[0] : null;
      if (!kb) throw new Error('no kb');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const frontmatter = `---\ntitle: ${title}\n${category ? `category: ${category}\n` : ''}tags:\n  - coworker-saved\n${tags.map(tg => `  - ${tg}`).join('\n')}${tags.length ? '\n' : ''}---\n\n`;
      await apiFetch(`/v1/knowledge-bases/${kb.id}/documents/note`, undefined, {
        method: 'POST',
        body: JSON.stringify({ filename: `${ts}.md`, path: '/wiki/notes/', title, content: frontmatter + content }),
      });
      setState('saved');
    } catch {
      setState('error');
    }
  };

  if (!title) return null;

  return (
    <div className="mb-2 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2.5 text-xs">
      <div className="flex items-center gap-1.5 font-medium text-blue-700 mb-1.5">💡 建议保存到知识库</div>
      <div className="text-gray-700 mb-1"><span className="text-gray-400">标题：</span>{title}</div>
      {(category || tags.length > 0) && (
        <div className="text-gray-500 mb-1.5">
          {category && <span className="mr-3"><span className="text-gray-400">分类：</span>{category}</span>}
          {tags.length > 0 && <span><span className="text-gray-400">标签：</span>{tags.join(', ')}</span>}
        </div>
      )}
      {content && (
        <div className="mb-2">
          <button onClick={() => setExpanded(e => !e)} className="text-blue-500 hover:text-blue-600 text-[11px]">
            {expanded ? '收起内容 ▲' : '预览内容 ▼'}
          </button>
          {expanded && (
            <pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-white border border-gray-100 p-2 text-[11px] text-gray-600">{content}</pre>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button onClick={handleSave} disabled={state === 'saving' || state === 'saved'}
          className={`px-3 py-1 rounded-md text-[11px] font-medium transition-colors ${
            state === 'saved' ? 'bg-green-100 text-green-600 cursor-default'
            : state === 'saving' ? 'bg-blue-100 text-blue-400 cursor-wait'
            : 'bg-blue-500 text-white hover:bg-blue-600'}`}>
          {state === 'saved' ? '✓ 已保存' : state === 'saving' ? '保存中…' : '保存到知识库'}
        </button>
        {state === 'error' && <span className="text-red-500 text-[11px]">保存失败，请重试</span>}
        {state === 'idle' && <span className="text-gray-400 text-[11px]">仅你确认后才会写入</span>}
      </div>
    </div>
  );
});
