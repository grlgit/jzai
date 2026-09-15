'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '@/i18n';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface Session {
  id: string;
  title: string | null;
  agentType: string;
  createdAt: string;
  updatedAt: string;
}

interface Props {
  token?: string | null;
  agentType: string;
  currentSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNew: () => void;
  visible: boolean;
  onClose: () => void;
}

export default function SessionList({ token, agentType, currentSessionId, onSelect, onNew, visible, onClose }: Props) {
  const { t } = useI18n();
  const [sessions, setSessions] = useState<Session[]>([]);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    if (!token) return;
    const resp = await fetch(`${MAIN_URL}/api/sessions?agentType=${agentType}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data.data || []);
    setSessions(list);
  }, [token, agentType]);

  useEffect(() => { if (visible) load(); }, [visible, load]);

  // Close on click outside
  useEffect(() => {
    if (!visible) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay to avoid immediate close from the toggle button click
    const timer = setTimeout(() => document.addEventListener('mousedown', handleClick), 100);
    return () => { clearTimeout(timer); document.removeEventListener('mousedown', handleClick); };
  }, [visible, onClose]);

  const handleDelete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await fetch(`${MAIN_URL}/api/sessions/${id}`, { method: 'DELETE', headers: authHeaders() });
    load();
  };

  const formatTime = (s: string) => {
    const d = new Date(s);
    const now = new Date();
    const diff = now.getTime() - d.getTime();
    if (diff < 60000) return t('session.justNow');
    if (diff < 3600000) return t('session.minutesAgo', { n: Math.floor(diff / 60000) });
    if (diff < 86400000) return t('session.hoursAgo', { n: Math.floor(diff / 3600000) });
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  return (
    <div
      ref={panelRef}
      className={`absolute left-0 top-0 bottom-[50%] w-64 bg-white border-r border-gray-200 shadow-xl z-30 flex flex-col rounded-br-lg overflow-hidden transition-all duration-200 ease-out ${
        visible ? 'opacity-100 translate-x-0' : 'opacity-0 -translate-x-full pointer-events-none'
      }`}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-gray-200 shrink-0">
        <span className="text-sm font-medium flex-1">{t('session.title')}</span>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-sm">✕</button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="p-4 text-xs text-gray-400 text-center">{t('session.empty')}</div>
        ) : sessions.map(s => (
          <div key={s.id} onClick={() => { onSelect(s.id); onClose(); }}
            className={`w-full text-left px-3 py-2.5 border-b border-gray-50 hover:bg-gray-50 group cursor-pointer ${currentSessionId === s.id ? 'bg-indigo-50' : ''}`}>
            <div className="flex items-center gap-1">
              <span className="text-sm text-gray-700 truncate flex-1">{s.title || '新对话'}</span>
              <button onClick={(e) => handleDelete(s.id, e)}
                className="text-gray-300 hover:text-red-500 opacity-0 group-hover:opacity-100 text-xs">✕</button>
            </div>
            <div className="text-[10px] text-gray-400 mt-0.5">{formatTime(s.updatedAt)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
