'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownWysiwygProps {
  value: string;
  onChange: (markdown: string) => void;
  className?: string;
}

const previewClass = "prose prose-sm max-w-none px-5 py-4 cursor-text min-h-[300px] " +
  "[&_table]:text-xs [&_table]:w-full [&_table]:border-collapse [&_table]:border [&_table]:border-gray-200 " +
  "[&_th]:bg-gray-50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:border [&_th]:border-gray-200 [&_th]:text-left [&_th]:font-semibold " +
  "[&_td]:px-3 [&_td]:py-1.5 [&_td]:border [&_td]:border-gray-200 " +
  "[&_pre]:bg-gray-900 [&_pre]:text-green-300 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:overflow-x-auto " +
  "[&_code]:text-indigo-600 [&_code]:bg-indigo-50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[12px] " +
  "[&_pre_code]:text-green-300 [&_pre_code]:bg-transparent [&_pre_code]:p-0 " +
  "[&_h1]:text-lg [&_h2]:text-base [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-sm [&_h3]:mt-4 [&_h3]:mb-1 " +
  "[&_p]:text-xs [&_p]:my-2 [&_li]:text-xs [&_li]:my-0.5 [&_ul]:pl-5 [&_ol]:pl-5 " +
  "[&_a]:text-indigo-600 [&_a]:underline [&_blockquote]:border-indigo-300 [&_blockquote]:text-gray-500 [&_blockquote]:pl-3 [&_hr]:my-4";

export default function MarkdownWysiwyg({ value, onChange, className }: MarkdownWysiwygProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync external value changes
  useEffect(() => { setDraft(value); }, [value]);

  const enterEdit = useCallback(() => {
    setDraft(value);
    setEditing(true);
  }, [value]);

  const exitEdit = useCallback(() => {
    setEditing(false);
    if (draft !== value) onChange(draft);
  }, [draft, value, onChange]);

  // Auto-focus textarea and place cursor when entering edit mode
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [editing]);

  // Handle tab key for indentation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newVal = draft.substring(0, start) + '  ' + draft.substring(end);
      setDraft(newVal);
      requestAnimationFrame(() => { ta.selectionStart = ta.selectionEnd = start + 2; });
    }
    if (e.key === 'Escape') {
      exitEdit();
    }
  }, [draft, exitEdit]);

  return (
    <div ref={containerRef} className={className || 'h-full flex flex-col'}>
      {/* Toolbar — always visible */}
      <div className="flex items-center gap-1 px-3 py-1 border-b border-gray-200 bg-gray-50 shrink-0 text-[11px] text-gray-400">
        {editing ? (
          <>
            <span className="text-indigo-500 font-medium">编辑中</span>
            <span className="mx-1">—</span>
            <span>Esc 退出编辑</span>
            <span className="flex-1" />
            <span className="text-[10px] tabular-nums">{draft.length} 字符</span>
          </>
        ) : (
          <>
            <span>点击内容进入编辑</span>
            <span className="flex-1" />
            <span className="text-[10px] tabular-nums">{value.length} 字符</span>
          </>
        )}
      </div>

      {/* Editor / Preview */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={exitEdit}
            onKeyDown={handleKeyDown}
            className="w-full h-full resize-none border-none outline-none px-5 py-4 font-mono text-[13px] leading-relaxed text-gray-800 bg-white"
            spellCheck={false}
          />
        ) : (
          <div onClick={enterEdit} className={previewClass}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {value || '*点击此处开始编辑...*'}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
