'use client';

import { useState, useEffect, useRef } from 'react';
import SessionList from '@/components/SessionList';
import { useI18n, LOCALES } from '@/i18n';

interface AgentInfo {
  id: string;
  name: string;
  icon: string;
  description?: string;
}

interface Props {
  user: { username?: string; name: string };
  token: string | null;
  companyName: string;
  agentList: AgentInfo[];
  myCoWorkers: any[];
  activeAgent: string;
  sessionId: string | null;
  onAgentSelect: (agentId: string) => void;
  onLoadSession: (sessionId: string) => void;
  onNewSession: () => void;
  onLogout: () => void;
  children: React.ReactNode;
}

/** 移动端外壳：顶栏（会话抽屉 / 智能体切换 / 用户菜单）+ 全屏聊天区。不渲染任何面板类功能。 */
export default function MobileShell({
  user, token, companyName, agentList, myCoWorkers, activeAgent, sessionId,
  onAgentSelect, onLoadSession, onNewSession, onLogout, children,
}: Props) {
  const { t, locale, setLocale } = useI18n();
  const [showSessions, setShowSessions] = useState(false);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const agentMenuRef = useRef<HTMLDivElement>(null);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | TouchEvent) => {
      if (agentMenuRef.current && !agentMenuRef.current.contains(e.target as Node)) setShowAgentMenu(false);
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) setShowUserMenu(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, []);

  const activeLabel = (() => {
    if (activeAgent === 'main') {
      return <>{agentList.find(a => a.id === 'main')?.icon || '🔮'} {companyName || t('user.companyName')}</>;
    }
    const cw = myCoWorkers.find((item: any) => item.coworker.id === activeAgent);
    if (cw) {
      const online = cw.lastSeen ? (Date.now() - new Date(cw.lastSeen).getTime() < 90000) : false;
      return (
        <>
          🤝 {cw.coworker.name}
          <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-green-400' : 'bg-gray-300'}`} />
        </>
      );
    }
    const agentInfo = agentList.find(a => a.id === activeAgent);
    return <>{agentInfo?.icon || '🔮'} {agentInfo?.name || activeAgent}</>;
  })();

  const pickAgent = (id: string) => {
    onAgentSelect(id);
    setShowAgentMenu(false);
  };

  return (
    <div className="flex flex-col h-full bg-white overflow-x-hidden">
      {/* 顶栏 */}
      <div className="flex items-center px-3 border-b border-gray-200 shrink-0 h-12 pt-[env(safe-area-inset-top)] box-content">
        <button
          onClick={() => setShowSessions(true)}
          className="text-gray-500 active:bg-gray-100 rounded p-2 -ml-1 text-base"
          title={t('user.sessionHistory')}
        >☰</button>
        <button
          onClick={() => { onNewSession(); }}
          className="text-gray-500 active:bg-gray-100 rounded p-2 text-base"
          title={t('user.newChat')}
        >✎</button>

        {/* 智能体切换 */}
        <div className="relative flex-1 min-w-0 flex justify-center" ref={agentMenuRef}>
          <button
            onClick={() => setShowAgentMenu(!showAgentMenu)}
            className="flex items-center gap-1.5 text-sm font-medium text-gray-900 truncate max-w-full px-2 py-1"
          >
            <span className="truncate">{activeLabel}</span>
            <span className="text-[10px] text-gray-400 shrink-0">▼</span>
          </button>
          {showAgentMenu && (
            <div className="absolute left-1/2 -translate-x-1/2 top-10 bg-white border border-gray-200 rounded-lg shadow-xl py-1 min-w-[200px] max-w-[80vw] z-50">
              <button
                onClick={() => pickAgent('main')}
                className={`w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 ${activeAgent === 'main' ? 'text-indigo-600 bg-indigo-50 font-medium' : 'text-gray-700'}`}
              >
                {agentList.find(a => a.id === 'main')?.icon || '🔮'} {companyName || t('user.companyName')}
              </button>
              {myCoWorkers.map((item: any) => {
                const online = item.lastSeen ? (Date.now() - new Date(item.lastSeen).getTime() < 90000) : false;
                return (
                  <button
                    key={item.id}
                    onClick={() => pickAgent(item.coworker.id)}
                    className={`w-full text-left px-3 py-2.5 text-sm flex items-center gap-2 ${activeAgent === item.coworker.id ? 'text-indigo-600 bg-indigo-50 font-medium' : 'text-gray-700'}`}
                  >
                    🤝 {item.coworker.name}
                    <span className={`ml-auto flex items-center gap-1 text-[11px] ${online ? 'text-green-600' : 'text-gray-400'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-green-400' : 'bg-gray-300'}`} />
                      {online ? '在线' : '离线'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 用户菜单 */}
        <div className="relative shrink-0" ref={userMenuRef}>
          <button
            onClick={() => setShowUserMenu(!showUserMenu)}
            className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-semibold"
          >
            {(user.username || user.name).charAt(0)}
          </button>
          {showUserMenu && (
            <div className="absolute right-0 top-10 bg-white border border-gray-200 rounded-lg p-2 min-w-[160px] shadow-lg z-50">
              <div className="px-2 py-1.5 text-sm font-medium">{user.username || user.name}</div>
              <div className="border-t border-gray-100 my-1" />
              <div className="px-2 py-1 text-xs text-gray-400">🌐 {t('user.language')}</div>
              {LOCALES.map(l => (
                <button key={l.value} onClick={() => setLocale(l.value)}
                  className={`w-full text-left px-3 py-2 text-xs rounded ${locale === l.value ? 'text-indigo-600 font-medium bg-indigo-50' : 'text-gray-500'}`}>
                  {locale === l.value && <span className="mr-1">✓</span>}{l.label}
                </button>
              ))}
              <div className="border-t border-gray-100 my-1" />
              <button onClick={onLogout} className="w-full text-left px-2 py-2 text-xs text-gray-500 active:text-red-500 rounded">{t('user.logout')}</button>
            </div>
          )}
        </div>
      </div>

      {/* 聊天区 */}
      <div className="flex-1 flex flex-col relative min-h-0 min-w-0">
        {children}
      </div>

      {/* 历史会话全屏抽屉 */}
      <SessionList
        token={token}
        agentType={activeAgent}
        currentSessionId={sessionId}
        onSelect={onLoadSession}
        onNew={() => { onNewSession(); setShowSessions(false); }}
        visible={showSessions}
        onClose={() => setShowSessions(false)}
        mobile
      />
    </div>
  );
}
