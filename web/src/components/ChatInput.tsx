'use client';

import { useState, useRef, useEffect, KeyboardEvent, DragEvent } from 'react';
import { useI18n } from '@/i18n';
import { Attachment } from '@/hooks/useChat';

interface AgentInfo {
  id: string;
  name: string;
  icon: string;
}

interface ChatInputProps {
  onSend: (message: string) => void;
  onFileAttach?: (file: File) => void;
  onAgentSelect?: (agentId: string) => void;
  activeAgent?: string;
  agentList?: AgentInfo[];
  onClearAgent?: () => void;
  pendingAttachments?: Attachment[];
  onRemoveAttachment?: (idx: number) => void;
  disabled?: boolean;
  onStop?: () => void;
  errorHint?: string;
  suggestions?: { text: string; removable?: boolean }[];
  onRemoveSuggestion?: (index: number) => void;
  onClearSuggestions?: () => void;
  compact?: boolean;
  menuUp?: boolean;
  offlineHint?: string;
}

const ACCEPT_EXTS = '.pdf,.xlsx,.xls,.csv,.txt,.doc,.docx,.har,.json,.html,.htm,.dxf';

export default function ChatInput({ onSend, onFileAttach, onAgentSelect, activeAgent, agentList, onClearAgent, pendingAttachments, onRemoveAttachment, disabled, onStop, errorHint, suggestions, onRemoveSuggestion, onClearSuggestions, compact, menuUp, offlineHint }: ChatInputProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const mentionMenuRef = useRef<HTMLDivElement>(null);

  const mentionOpen = mentionStart >= 0;
  const mentionFiltered = (agentList || []).filter((a: any) => {
    if (a.id === 'main') return false;
    if (a.isCoWorker && !a.online) return false;
    const q = mentionQuery.toLowerCase();
    return !q || a.name.toLowerCase().includes(q);
  });

  const closeMention = () => { setMentionStart(-1); setMentionQuery(''); setMentionHighlight(0); };

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    autoGrow();
    const pos = e.target.selectionStart ?? val.length;
    let start = -1;
    for (let i = pos - 1; i >= 0; i--) {
      const ch = val[i];
      if (ch === '@') {
        if (i === 0 || /\s/.test(val[i - 1])) start = i;
        break;
      }
      if (/\s/.test(ch)) break;
    }
    if (start >= 0) {
      setMentionStart(start);
      setMentionQuery(val.slice(start + 1, pos));
      setMentionHighlight(0);
    } else if (mentionOpen) {
      closeMention();
    }
  };

  const selectMention = (agentId: string) => {
    const prefix = text.slice(0, mentionStart);
    const suffix = text.slice(mentionStart + 1 + mentionQuery.length);
    setText((prefix + suffix).trim());
    onAgentSelect?.(agentId);
    closeMention();
    setTimeout(() => textareaRef.current?.focus(), 0);
  };

  // Close agent picker + mention on outside click
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) {
        setShowAgentMenu(false);
      }
      if (mentionMenuRef.current && !mentionMenuRef.current.contains(e.target as Node) && e.target !== textareaRef.current) {
        closeMention();
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [mentionOpen, mentionQuery, text]);

  // Task elapsed timer (millisecond precision)
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);

  useEffect(() => {
    if (disabled) {
      startTimeRef.current = Date.now();
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed(Date.now() - startTimeRef.current);
      }, 50);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [disabled]);

  const handleSend = () => {
    const trimmed = text.trim();
    if (!trimmed || disabled || offlineHint) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (mentionOpen && mentionFiltered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionHighlight((h) => (h + 1) % mentionFiltered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionHighlight((h) => (h - 1 + mentionFiltered.length) % mentionFiltered.length);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        selectMention(mentionFiltered[mentionHighlight].id);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !offlineHint) handleSend();
    }
  };

  const autoGrow = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, compact ? 100 : 140) + 'px';
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) onFileAttach?.(file);
  };

  const handleDragOver = (e: DragEvent) => { e.preventDefault(); setDragOver(true); };
  const handleDragLeave = () => setDragOver(false);

  return (
    <div className="flex flex-col">
      {disabled && (
        <div className="flex items-center justify-center gap-1.5 py-1 text-xs text-indigo-400 tabular-nums">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
          {(() => { const t = elapsed / 1000; const m = Math.floor(t / 60); return `${m}:${(t - m * 60).toFixed(1).padStart(4, '0')}`; })()}
        </div>
      )}
      {!disabled && offlineHint && (
        <div className="flex items-center justify-center gap-1.5 py-1.5 text-xs text-amber-600">
          <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="1" y1="1" x2="23" y2="23" />
            <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55" />
            <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39" />
            <path d="M10.71 5.05A16 16 0 0 1 22.58 9" />
            <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88" />
            <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
            <line x1="12" y1="20" x2="12.01" y2="20" />
          </svg>
          {offlineHint}
        </div>
      )}
      {!disabled && !offlineHint && errorHint && (
        <div className="flex items-center justify-center gap-1.5 py-1.5 text-xs text-amber-600">
          <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          {errorHint}
        </div>
      )}
    <div
      className={`bg-white rounded-2xl transition-shadow ${
        offlineHint && !disabled
          ? 'grayscale opacity-80'
          : ''
      } ${
        dragOver
          ? 'shadow-[0_4px_20px_rgba(79,70,229,0.25),0_0_0_2px_#4f46e5] bg-indigo-50/30'
          : `shadow-[0_2px_12px_rgba(79,70,229,0.10),0_0_0_1px_#e8e5f0] focus-within:shadow-[0_4px_20px_rgba(79,70,229,0.18),0_0_0_2px_#4f46e5] ${compact ? 'shadow-sm' : ''}`
      }`}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
      {dragOver && (
        <div className="px-4 py-2 text-center text-xs text-indigo-500">{t('chat.dropHint')}</div>
      )}

      {pendingAttachments && pendingAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pt-2">
          {pendingAttachments.map((a, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-50 text-xs text-indigo-600 border border-indigo-100">
              📎 {a.fileName}
              <button onClick={() => onRemoveAttachment?.(i)} className="text-indigo-300 hover:text-indigo-500 ml-0.5">✕</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex items-end gap-1 px-4 py-1.5 relative">
        {mentionOpen && mentionFiltered.length > 0 && (
          <div
            ref={mentionMenuRef}
            className={`absolute left-4 right-4 bg-white border border-gray-200 rounded-lg shadow-xl py-1 max-h-[220px] overflow-y-auto ${menuUp ? 'bottom-[60px]' : 'top-[60px]'}`}
            style={{ zIndex: 9998 }}
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="px-3 py-1 text-[10px] text-gray-400 uppercase tracking-wide">
              {t('chat.mentionSwitch') || 'Switch to…'}
            </div>
            {mentionFiltered.map((a: any, i: number) => (
              <button
                key={a.id}
                type="button"
                onMouseDown={(e) => { e.preventDefault(); selectMention(a.id); }}
                onMouseEnter={() => setMentionHighlight(i)}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${i === mentionHighlight ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <span>{a.icon}</span>
                <span className="truncate">{a.name}</span>
                {a.isCoWorker && (
                  <span className={`ml-auto w-1.5 h-1.5 rounded-full ${a.online ? 'bg-green-400' : 'bg-gray-300'}`} />
                )}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onBlur={() => { setTimeout(closeMention, 150); }}
          placeholder={offlineHint ? '' : t('chat.placeholder')}
          disabled={!!offlineHint}
          rows={compact ? 2 : 2}
          className={`flex-1 border-none outline-none resize-none bg-transparent text-sm leading-relaxed py-2 text-gray-900 placeholder:text-gray-400 disabled:cursor-not-allowed disabled:text-gray-400 ${compact ? 'min-h-[52px] max-h-[120px]' : 'min-h-[40px] max-h-[140px]'}`}
        />
      </div>
      <div className="flex items-center gap-1.5 px-3 pb-2">
        {/* Agent selector + menu inline */}
        <div className="relative" ref={agentMenuRef}>
          <button
            onClick={() => onAgentSelect ? setShowAgentMenu(!showAgentMenu) : undefined}
            className="w-7 h-7 rounded-full border border-dashed border-gray-300 flex items-center justify-center text-sm text-gray-400 hover:border-indigo-500 hover:text-indigo-500 hover:bg-indigo-50 transition-all"
          >
            ＋
          </button>
          {showAgentMenu && onAgentSelect && agentList && (
            <div className={`absolute left-0 bg-white border border-gray-200 rounded-lg shadow-xl py-1 min-w-[160px] ${menuUp ? 'bottom-9' : 'top-9'}`}
              style={{ zIndex: 9999 }}>
              {agentList.filter(a => a.id !== 'main' && !(a as any).isCoWorker).map(a => (
                <button key={a.id}
                  onClick={() => { onAgentSelect(a.id); setShowAgentMenu(false); }}
                  className="w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 hover:text-indigo-600 flex items-center gap-2"
                >
                  <span>{a.icon}</span> {a.name}
                </button>
              ))}
              {agentList.filter(a => a.id !== 'main' && !(a as any).isCoWorker).length === 0 && agentList.filter(a => (a as any).isCoWorker).length === 0 && (
                <div className="px-3 py-2 text-[11px] text-gray-400">{t('chat.noAgents')}</div>
              )}
              {agentList.filter(a => (a as any).isCoWorker).length > 0 && (
                <>
                  <div className="px-3 py-1 text-[10px] text-gray-400 uppercase tracking-wide border-t border-gray-100 mt-1 pt-1.5">CoWorkers</div>
                  {agentList.filter(a => (a as any).isCoWorker).map(a => (
                    <button key={a.id}
                      onClick={() => { onAgentSelect(a.id); setShowAgentMenu(false); }}
                      className="w-full text-left px-3 py-2 text-xs text-gray-700 hover:bg-gray-50 hover:text-indigo-600 flex items-center gap-2"
                    >
                      <span>{a.icon}</span> {a.name}
                      <span className={`ml-auto w-1.5 h-1.5 rounded-full ${(a as any).online ? 'bg-green-400' : 'bg-gray-300'}`} />
                    </button>
                  ))}
                </>
              )}
            </div>
          )}
        </div>

        {/* Active agent tag */}
        {activeAgent && activeAgent !== 'main' && (() => {
          const info = agentList?.find(a => a.id === activeAgent);
          return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-xs text-indigo-600 border border-indigo-200">
              {info?.icon || '🔮'} {info?.name || activeAgent}
              <button onClick={onClearAgent} className="text-indigo-300 hover:text-indigo-600 ml-0.5 leading-none">✕</button>
            </span>
          );
        })()}

        {/* Suggestions */}
        {suggestions?.map((s, i) => (
          <span key={i} className="inline-flex items-center gap-0.5 rounded-full border border-gray-200 hover:border-indigo-500 hover:bg-indigo-50 transition-all whitespace-nowrap group">
            <button onClick={() => onSend(s.text)} className="pl-2 pr-0.5 py-0.5 text-[11px] text-gray-500 hover:text-indigo-500">
              {s.text}
            </button>
            {onRemoveSuggestion && (
              <button onClick={(e) => { e.stopPropagation(); onRemoveSuggestion(i); }}
                className="pr-1.5 text-[9px] text-gray-300 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
            )}
          </span>
        ))}
        {suggestions && suggestions.length > 0 && onClearSuggestions && (
          <button onClick={onClearSuggestions} className="text-[9px] text-gray-300 hover:text-gray-500 ml-1" title={t('chat.clear')}>{t('chat.clear')}</button>
        )}

        <div className="flex-1" />

        {/* File attach */}
        <input type="file" ref={fileRef} className="hidden" accept={ACCEPT_EXTS}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onFileAttach?.(f); if (fileRef.current) fileRef.current.value = ''; }} />
        <button onClick={() => fileRef.current?.click()}
          className="w-8 h-8 rounded-lg flex items-center justify-center text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-all" title={t('chat.upload')}>📎</button>

        {/* Send / Stop */}
        {disabled ? (
          <button onClick={onStop} className="w-8 h-8 rounded-lg flex items-center justify-center bg-gray-500 text-white hover:bg-red-500 transition-colors" title="停止生成">
            <span className="w-3 h-3 rounded-sm bg-white" />
          </button>
        ) : (
          <button onClick={handleSend} disabled={!text.trim() || !!offlineHint}
            className="w-8 h-8 rounded-lg flex items-center justify-center bg-indigo-600 text-white hover:bg-indigo-700 transition-all disabled:opacity-40" title={offlineHint || t('chat.send')}>➤</button>
        )}
      </div>
    </div>
    </div>
  );
}
