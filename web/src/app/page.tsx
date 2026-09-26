'use client';

import { useState, useCallback, useEffect, useRef, startTransition } from 'react';
import Sidebar from '@/components/Sidebar';
import KBPanel from '@/modules/kb/KBPanel';
import ChatInput from '@/components/ChatInput';
import ChatMessages from '@/components/ChatMessages';
import ContextIndicator from '@/components/ContextIndicator';
import SettingsPanel from '@/components/SettingsPanel';
// DashboardPanel moved to SettingsPanel as "运营分析" tab
import LoginPage from '@/components/LoginPage';
import InitWizard from '@/components/init/InitWizard';
import ForcePasswordChange from '@/components/ForcePasswordChange';
import ConfigGuideBanner from '@/components/ConfigGuideBanner';
import SkillsManagePanel from '@/components/SkillsManagePanel';
import ConnectorsPanel from '@/components/ConnectorsPanel';
import AgentManagerPanel from '@/components/AgentManagerPanel';
import CoWorkerPanel from '@/modules/coworker/CoWorkerPanel';
import CustomDashboardPanel from '@/components/dashboard/CustomDashboardPanel';
import FloatingPanel from '@/components/FloatingPanel';
import MyEmailPanel from '@/components/MyEmailPanel';
import { DynamicPanelLoader } from '@/components/DynamicPanelLoader';
import MobileShell from '@/components/mobile/MobileShell';
import MobileAccessQr from '@/components/MobileAccessQr';
import SessionList from '@/components/SessionList';
import SidebarCustomizeModal from '@/components/SidebarCustomizeModal';
import ShortcutCustomizeModal from '@/components/ShortcutCustomizeModal';
import { useChat } from '@/hooks/useChat';
import { useAuth } from '@/hooks/useAuth';
import { useSidebar } from '@/hooks/useSidebar';
import { useShortcuts } from '@/hooks/useShortcuts';
import { processPanelMessages } from '@/lib/panel-message-registry';
import { disconnectSocket } from '@/lib/socket';
import { useI18n, LOCALES } from '@/i18n';
import { useMessageDisplay } from '@/hooks/useMessageDisplay';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useMobileAccess } from '@/hooks/useMobileAccess';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

export default function Home() {
  const { user, token, loading: authLoading, login, logout, isAdmin, getRoleName } = useAuth();
  const [setupPhase, setSetupPhase] = useState<'loading' | 'pending' | 'registered' | 'complete'>('loading');
  const [needsGuidedConfig, setNeedsGuidedConfig] = useState(false);
  const [companyName, setCompanyName] = useState('');
  const [licenseIssue, setLicenseIssue] = useState<string | null>(null);
  const [showReRegister, setShowReRegister] = useState(false);
  const [reRegisterState, setReRegisterState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [reRegisterError, setReRegisterError] = useState('');
  const [forcePwDone, setForcePwDone] = useState(false);
  const [activeNav, setActiveNav] = useState('chat');
  const [contentPanel, setContentPanel] = useState<{ title: string; type: string; icon?: string } | null>(null);
  const [visitedPanels, setVisitedPanels] = useState<Set<string>>(new Set());
  const [activePdfFileId, setActivePdfFileId] = useState<string>('');
  const [chatStarted, setChatStarted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showFloating, setShowFloating] = useState(false);
  const [showEmailPanel, setShowEmailPanel] = useState(false);
  const [activeAgent, setActiveAgent] = useState('main');
  const [showSessionList, setShowSessionList] = useState(false);
  // 存储智能体传递给面板的数据
  const [agentPanelData, setAgentPanelData] = useState<Record<string, any>>({});
  const [agentList, setAgentList] = useState<{ id: string; name: string; icon: string; description: string; defaultPanel?: string }[]>([]);
  const [showShortcutCustomize, setShowShortcutCustomize] = useState(false);
  const [chatWidth, setChatWidth] = useState(304);
  const [showCustomize, setShowCustomize] = useState(false);
  const [myCoWorkers, setMyCoWorkers] = useState<any[]>([]);
  const [showHeaderAgentMenu, setShowHeaderAgentMenu] = useState(false);
  const headerAgentMenuRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const { t, locale, setLocale } = useI18n();
  const { url: mobileAccessUrl, forceMobile } = useMobileAccess(token);
  // 从移动地址登录时始终手机模式；其他地址按视口宽度自动感知
  const isMobile = useIsMobile() || forceMobile;
  const msgDisplay = useMessageDisplay(activeAgent);
  const { panels: sidebarPanels, save: saveSidebar, reset: resetSidebar } = useSidebar(token);
  const { shortcuts, save: saveShortcuts, reset: resetShortcuts } = useShortcuts(token);

  // Single global chat — agentId determines which backend agent to use
  const conversationId = activeAgent === 'main' ? 'default' : activeAgent;
  const { messages, isStreaming, errorHint, sendMessage, stopGeneration, uploadFile, pendingAttachments, removePendingAttachment, sessionId, loadSession, newSession, pendingConfirm, confirmReply, contextStatus, thinkingText, thinkingHead } = useChat(conversationId, token, activeAgent);

  // Process panel messages via registry — no panel-specific hardcoding here.
  // startTransition：面板重渲染（react-pdf 等）降为低优先级，不阻塞聊天文本流的渲染
  useEffect(() => {
    if (isMobile) return; // 移动模式不渲染任何面板，跳过面板数据处理
    let cancelled = false;
    processPanelMessages(messages, sidebarPanels).then(patch => {
      if (!cancelled && patch) {
        startTransition(() => {
          setAgentPanelData(prev => ({ ...prev, ...patch }));
        });
      }
    });
    return () => { cancelled = true; };
  }, [messages, sidebarPanels, isMobile]);

  // pendingInput: set by switch_agent action / panel agent.send, consumed after agent switch completes
  const [pendingInput, setPendingInput] = useState<{ text: string; extraContext?: Record<string, any> } | null>(null);

  const [suggestions, setSuggestions] = useState<{ text: string }[]>([]);

  // Global 401 interceptor: auto-logout on expired token
  useEffect(() => {
    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args: Parameters<typeof fetch>) => {
      const resp = await origFetch(...args);
      if (resp.status === 401) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
        // Skip login/refresh endpoints to avoid infinite loop
        if (url && !url.includes('/api/auth/')) {
          // Try refresh token first
          const refreshToken = localStorage.getItem('jz_refresh_token');
          if (refreshToken) {
            try {
              const refreshResp = await origFetch(`${MAIN_URL}/api/auth/refresh`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ refreshToken }),
              });
              if (refreshResp.ok) {
                const data = await refreshResp.json();
                localStorage.setItem('jz_token', data.accessToken);
                if (data.refreshToken) localStorage.setItem('jz_refresh_token', data.refreshToken);
                // Retry original request with new token
                const retryInit = args[1] ? { ...args[1] } : {};
                const headers = new Headers(retryInit.headers || {});
                headers.set('Authorization', `Bearer ${data.accessToken}`);
                retryInit.headers = headers;
                return origFetch(args[0], retryInit);
              }
            } catch {}
          }
          // Refresh failed — force logout
          localStorage.removeItem('jz_token');
          localStorage.removeItem('jz_user');
          localStorage.removeItem('jz_refresh_token');
          window.location.reload();
        }
      }
      return resp;
    };
    return () => { window.fetch = origFetch; };
  }, []);

  // Navigation trace: catch unexpected redirects (no user interaction)
  useEffect(() => {
    // Intercept window.open
    const origOpen = window.open.bind(window);
    window.open = function (...args: any[]) {
      console.warn('[NAV-TRACE] window.open:', args[0], new Error().stack);
      return origOpen(...args);
    } as typeof window.open;

    // Catch page unload during streaming
    const onBeforeUnload = () => {
      const trace = {
        ts: new Date().toISOString(),
        url: window.location.href,
        activeElement: document.activeElement?.tagName + (document.activeElement instanceof HTMLAnchorElement ? ' href=' + document.activeElement.href : ''),
      };
      console.error('[NAV-TRACE] beforeunload!', JSON.stringify(trace));
      try { navigator.sendBeacon(`${MAIN_URL}/api/setup/nav-trace`, JSON.stringify(trace)); } catch {}
    };
    window.addEventListener('beforeunload', onBeforeUnload);

    // Watch for injected meta-refresh or suspicious anchors
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of Array.from(m.addedNodes)) {
          if (node instanceof HTMLMetaElement && node.httpEquiv?.toLowerCase() === 'refresh') {
            console.error('[NAV-TRACE] meta refresh injected!', node.content);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Intercept all click events on <a> tags to log programmatic clicks
    const onClick = (e: MouseEvent) => {
      const a = (e.target as Element)?.closest?.('a');
      if (a?.href && !e.isTrusted) {
        console.error('[NAV-TRACE] programmatic <a> click!', a.href, new Error().stack);
      }
    };
    document.addEventListener('click', onClick, true);

    return () => {
      window.open = origOpen;
      window.removeEventListener('beforeunload', onBeforeUnload);
      observer.disconnect();
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  // Check setup phase on mount
  useEffect(() => {
    fetch(`${MAIN_URL}/api/setup/status`)
      .then(r => r.json())
      .then(data => {
        setSetupPhase(data.phase || 'pending');
        setNeedsGuidedConfig(data.needsGuidedConfig ?? false);
        if (data.companyName) setCompanyName(data.companyName);
        if (data.licenseIssue) { setLicenseIssue(data.licenseIssue); setShowReRegister(true); }
        else if (data.tokenInvalid) { setLicenseIssue('企业授权令牌已失效，请前往「设置 → 版本授权」重新注册以恢复服务。'); }
      })
      .catch(() => setSetupPhase('complete'));
  }, []);

  // Load agents + suggestions + my CoWorkers
  useEffect(() => {
    if (!token) return;
    fetch(`${MAIN_URL}/api/agents`).then(r => r.json())
      .then(agents => { if (Array.isArray(agents)) setAgentList(agents); })
      .catch(() => {});
    fetch(`${MAIN_URL}/api/suggestions`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setSuggestions(data); })
      .catch(() => {});
    fetch(`${MAIN_URL}/api/my/coworkers`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setMyCoWorkers(data); })
      .catch(() => {});
  }, [token]);

  // Close header agent menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (headerAgentMenuRef.current && !headerAgentMenuRef.current.contains(e.target as Node)) {
        setShowHeaderAgentMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Merge CoWorkers into agent list for ChatInput picker
  const mergedAgentList = [...agentList, ...myCoWorkers.map((item: any) => ({
    id: item.coworker.id,
    name: item.coworker.name,
    icon: '🤝',
    description: item.coworker.description || '',
    isCoWorker: true,
    online: item.lastSeen ? (Date.now() - new Date(item.lastSeen).getTime() < 90000) : false,
  }))];
  const activeCwOffline = (() => {
    const a = mergedAgentList.find((x: any) => x.id === activeAgent && (x as any).isCoWorker) as any;
    return a && !a.online ? a.name : null;
  })();

  const removeSuggestion = useCallback((index: number) => {
    const next = suggestions.filter((_, i) => i !== index);
    setSuggestions(next);
    if (token) {
      fetch(`${MAIN_URL}/api/suggestions`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: next }),
      }).catch(() => {});
    }
  }, [token, suggestions]);

  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    if (token) {
      fetch(`${MAIN_URL}/api/suggestions`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}` },
      }).catch(() => {});
    }
  }, [token]);

  const handleNavigate = useCallback((id: string) => {
    setActiveNav(id);
    if (id === 'chat') {
      setContentPanel(null);
      setExpanded(false);
      setShowFloating(false);
      setActiveAgent('main');
      newSession();  // 从主页进入聊天即开新会话：清空内存里残留的 sessionId/messages，避免接上上次历史
      setChatStarted(false);
    } else {
      const panel = sidebarPanels.find(p => p.id === id);
      const iconStr = panel?.icon?.startsWith('img:') ? '' : (panel?.icon || '');
      const title = panel ? `${iconStr} ${panel.name}`.trim() : id;
      setContentPanel({ title, type: id, icon: panel?.icon });
      setVisitedPanels(prev => new Set(prev).add(id));
      // Auto-switch to paired agent (driven by DB agent_id column)
      const agentId = panel?.agentId;
      if (agentId) {
        setActiveAgent(agentId);
        setChatStarted(true);
      }
    }
  }, [sidebarPanels, newSession]);

  const collectPageContext = useCallback(() => {
    const ctx: Record<string, any> = {
      panel: contentPanel?.type,
      title: contentPanel?.title,
      nav: activeNav,
      url: window.location.href,
      pdfFileId: activePdfFileId || undefined,
    };
    // Scan visible DOM elements for labels
    const selectors = 'button, a, h1, h2, h3, [role=tab], [role=menuitem], nav span, .sidebar span';
    const seen = new Set<string>();
    const labels: string[] = [];
    document.querySelectorAll(selectors).forEach(el => {
      const htmlEl = el as HTMLElement;
      if (htmlEl.offsetParent === null && htmlEl.style.display !== 'contents') return; // hidden
      const text = (htmlEl.textContent || '').trim().replace(/\s+/g, ' ');
      if (text && text.length >= 2 && text.length <= 30 && !seen.has(text)) {
        seen.add(text);
        labels.push(text);
      }
    });
    ctx.labels = labels;
    return ctx;
  }, [contentPanel, activeNav, activePdfFileId]);

  const handleSend = useCallback((text: string, extraContext?: Record<string, any>) => {
    if (!chatStarted) setChatStarted(true);
    sendMessage(text, { ...collectPageContext(), ...extraContext });
  }, [chatStarted, sendMessage, collectPageContext]);

  // Forward message after agent switch — state-driven to ensure React has finished
  // re-rendering with new activeAgent before sendMessage is called.
  // newSession() 置 forceNewSession：后端忽略任何旧 sessionId 强制开新会话，
  // 杜绝陈旧闭包把上一个 agent 的 sessionId 带过来（曾致转发延迟数分钟后串会话）。
  useEffect(() => {
    if (!pendingInput) return;
    const msg = pendingInput;
    setPendingInput(null);
    newSession();
    handleSend(msg.text, msg.extraContext);
  }, [pendingInput, handleSend, newSession]);

  // Listen for programmatic send-message events (e.g. from test button)
  useEffect(() => {
    const handler = (e: Event) => {
      const content = (e as CustomEvent).detail?.content;
      if (content) handleSend(content);
    };
    window.addEventListener('jianzhi:send-message', handler);
    return () => window.removeEventListener('jianzhi:send-message', handler);
  }, [handleSend]);

  // Generic DOM form filler — no panel modifications needed
  const fillForm = useCallback((click: string, fields: Record<string, string>) => {
    // Step 1: Find and click the button matching the text
    const btns = document.querySelectorAll('button');
    for (const btn of btns) {
      if ((btn as HTMLElement).offsetParent === null) continue; // skip hidden
      if (btn.textContent?.trim().includes(click)) {
        btn.click();
        break;
      }
    }

    // Step 2: Wait for dialog/form to render, then fill fields by label text
    setTimeout(() => {
      const allLabels = document.querySelectorAll('label');
      for (const [fieldLabel, value] of Object.entries(fields)) {
        for (const label of allLabels) {
          if (!label.textContent?.includes(fieldLabel)) continue;
          const container = label.closest('div');
          if (!container) continue;

          // Try input
          const input = container.querySelector('input');
          if (input) {
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
            setter?.call(input, value);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }

          // Try select — match option by visible text
          const select = container.querySelector('select');
          if (select) {
            for (const opt of select.options) {
              if (opt.textContent?.includes(value)) {
                select.value = opt.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                break;
              }
            }
            break;
          }

          // Try textarea
          const textarea = container.querySelector('textarea');
          if (textarea) {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            setter?.call(textarea, value);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }
    }, 400);
  }, []);

  const handleAgentSelect = useCallback((agentId: string) => {
    if (agentId === 'main') {
      setActiveAgent('main');
      setContentPanel(null);
      newSession();  // 切回主智能体即开新会话，避免内存残留的旧 sessionId/messages 接上上次历史
      setChatStarted(false);
    } else {
      setActiveAgent(agentId);
      setChatStarted(true);
      const agentInfo = agentList.find(a => a.id === agentId);
      if (agentInfo?.defaultPanel && !isMobile) {
        handleNavigate(agentInfo.defaultPanel);
      } else {
        setActiveNav('chat');
      }
    }
  }, [agentList, handleNavigate, newSession, isMobile]);

  /**
   * Panel → Agent 结构化通道（PLAT-012）：面板 sdk.agent.send() 的宿主侧路由。
   * 目标 Agent 由面板绑定关系（sidebar 的 agentId，来自 manifest）决定，面板自身
   * 不能指定目标；用户身份取自会话 JWT。绑定 Agent 与当前会话不一致时先切换再发送。
   */
  const handlePanelAgentMessage = useCallback((panel: { id: string; sourceAppId?: string | null; agentId?: string | null }, msg: { text: string; context?: Record<string, any> }) => {
    const extraContext = {
      panelContext: {
        panelId: panel.id,
        appId: panel.sourceAppId ?? undefined,
        ...(msg.context ?? {}),
      },
    };
    const boundAgent = panel.agentId ?? undefined;
    if (boundAgent && boundAgent !== activeAgent) {
      handleAgentSelect(boundAgent);
      setPendingInput({ text: msg.text, extraContext });
      return;
    }
    handleSend(msg.text, extraContext);
  }, [activeAgent, handleAgentSelect, handleSend]);

  // Navigate panel only (no agent switch) — used by agent actions to avoid hijacking conversation
  const handleNavigateOnly = useCallback((id: string) => {
    if (id === 'chat') {
      setContentPanel(null);
      setExpanded(false);
      setShowFloating(false);
    } else {
      setActiveNav(id);
      const panel = sidebarPanels.find(p => p.id === id);
      const iconStr = panel?.icon?.startsWith('img:') ? '' : (panel?.icon || '');
      const title = panel ? `${iconStr} ${panel.name}`.trim() : id;
      setContentPanel({ title, type: id, icon: panel?.icon });
      setVisitedPanels(prev => new Set(prev).add(id));
      // NOTE: no panelAgentMap agent switch — agent stays unchanged
    }
  }, [sidebarPanels]);

  // Listen for agent UI control actions (ABC framework)
  useEffect(() => {
    const handler = (e: Event) => {
      const { actionType, actionData } = (e as CustomEvent).detail;
      // 移动模式：面板类动作静默忽略（navigate/form_fill/ui_hook 均无面板可承载）
      if (isMobile && (actionType === 'navigate' || actionType === 'form_fill' || actionType === 'ui_hook')) return;
      switch (actionType) {
        case 'navigate':
          // Agent-triggered navigate: open panel but do NOT switch agent
          handleNavigateOnly(actionData.target);
          break;
        case 'switch_agent':
          handleAgentSelect(actionData.target);
          if (actionData.forwardMessage) {
            setPendingInput({ text: actionData.forwardMessage });
          }
          break;
        case 'open_url':
          window.open(actionData.target, '_blank');
          break;
        case 'form_fill':
          handleNavigateOnly(actionData.target);
          setTimeout(() => {
            if (actionData.click && actionData.fields) {
              fillForm(actionData.click, actionData.fields);
            }
          }, 500);
          break;
        case 'ui_hook':
          // Agent → Panel directed communication: navigate to panel, then dispatch hook
          if (actionData.panel) handleNavigateOnly(actionData.panel);
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('jianzhi:ui-hook', { detail: actionData }));
          }, 300);
          break;
      }
    };
    window.addEventListener('jianzhi:agent-action', handler);
    return () => window.removeEventListener('jianzhi:agent-action', handler);
  }, [handleNavigateOnly, handleAgentSelect, isMobile]);

  // Draggable divider between content panel and chat panel
  const handleDividerMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
    const startX = e.clientX;
    const startWidth = chatWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!draggingRef.current) return;
      const delta = startX - ev.clientX;
      const newWidth = Math.max(280, Math.min(800, startWidth + delta));
      setChatWidth(newWidth);
    };

    const onMouseUp = () => {
      draggingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [chatWidth]);

  const handleClearAgent = useCallback(() => {
    setActiveAgent('main');
    setContentPanel(null);
  }, []);


  const handleQuickLink = useCallback((shortcut: { type: string; target: string }) => {
    if (shortcut.type === 'url') {
      window.open(shortcut.target, '_blank');
    } else {
      handleNavigate(shortcut.target);
    }
  }, [handleNavigate]);

  const handleLogout = useCallback(() => {
    disconnectSocket();
    logout();
  }, [logout]);

  if (authLoading || setupPhase === 'loading') return <div className="h-full flex items-center justify-center text-gray-400">{t('user.loading')}</div>;
  if (setupPhase !== 'complete' && !user) return <InitWizard onComplete={() => {
    setSetupPhase('complete');
    fetch(`${MAIN_URL}/api/setup/status`).then(r => r.json()).then(data => {
      if (data.companyName) setCompanyName(data.companyName);
    }).catch(() => {});
  }} />;
  if (!user) return <LoginPage onLogin={login} />;
  if (!forcePwDone && user.passwordChanged === false) return <ForcePasswordChange userId={user.id} token={token!} onComplete={() => setForcePwDone(true)} />;

  const isAside = contentPanel !== null && !expanded;
  const isFloating = contentPanel !== null && expanded;

  // License overlays shared by desktop & mobile shells
  const licenseOverlays = (
    <>
      {/* License re-register dialog */}
      {showReRegister && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[100]">
          <div className="bg-white rounded-xl shadow-2xl w-96 max-w-[92vw] p-6">
            <div className="flex items-center gap-2 mb-3">
              <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" /></svg>
              <h3 className="text-sm font-bold text-gray-800">授权需要重新验证</h3>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              授权验证失效（许可证过期、实例信息变更或服务端数据更新），需要重新验证授权才能使用 AI 服务。
              {companyName && <><br />公司：<b>{companyName}</b></>}
            </p>

            {reRegisterState === 'success' ? (
              <div className="text-sm text-green-600 bg-green-50 rounded-lg p-3 mb-4">验证成功，AI 服务已恢复。</div>
            ) : reRegisterState === 'error' ? (
              <div className="text-xs text-red-600 bg-red-50 rounded-lg p-3 mb-4">验证失败：{reRegisterError}<br />请检查网络连接或联系管理员。</div>
            ) : null}

            <div className="flex justify-end gap-2">
              {reRegisterState === 'success' ? (
                <button onClick={() => { setShowReRegister(false); setLicenseIssue(null); window.location.reload(); }}
                  className="px-4 py-2 text-sm font-medium text-white bg-green-600 rounded-lg hover:bg-green-700">确定</button>
              ) : (
                <>
                  <button onClick={() => setShowReRegister(false)} disabled={reRegisterState === 'loading'}
                    className="px-4 py-2 text-sm text-gray-500 hover:text-gray-700 disabled:opacity-50">稍后</button>
                  <button disabled={reRegisterState === 'loading'} onClick={async () => {
                    setReRegisterState('loading'); setReRegisterError('');
                    try {
                      const resp = await fetch(`${MAIN_URL}/api/edition/re-register`, { method: 'POST' });
                      const data = await resp.json();
                      if (data.success) { setReRegisterState('success'); }
                      else { setReRegisterState('error'); setReRegisterError(data.error || '未知错误'); }
                    } catch (e: any) { setReRegisterState('error'); setReRegisterError(e.message); }
                  }} className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                    {reRegisterState === 'loading' ? '验证中...' : '重新验证'}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* License issue banner (shown after dialog dismissed) */}
      {licenseIssue && !showReRegister && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-amber-50 border-b border-amber-200 px-4 py-2 flex items-center justify-center gap-3">
          <span className="text-xs text-amber-700">授权待验证，AI 服务受限</span>
          <button onClick={() => { setShowReRegister(true); setReRegisterState('idle'); }}
            className="text-xs font-medium text-amber-700 underline hover:text-amber-900">立即验证</button>
        </div>
      )}
    </>
  );

  const renderChatContent = (compact: boolean) => (
    <>
      {!chatStarted ? (
        <div className={`flex-1 flex flex-col items-center overflow-y-auto ${compact ? 'justify-end pb-0' : 'pt-[18vh]'} px-6`}>
          {!compact && (
            <>
              <h1 className="text-2xl font-semibold bg-gradient-to-br from-gray-900 to-indigo-600 bg-clip-text text-transparent mb-3">
                {t('welcome.title')}
              </h1>
              <p className="text-sm text-gray-400 mb-7">{t('welcome.subtitle')}</p>
              <div className="flex gap-2 mb-8 flex-wrap justify-center">
                {shortcuts.map((s) => {
                  // Sync icon from sidebar panel; name from i18n
                  const panel = s.type === 'panel' ? sidebarPanels.find(p => p.id === s.target) : null;
                  const icon = panel?.icon ?? s.icon;
                  const i18nKey = s.type === 'panel' ? `nav.panel.${s.target}` : '';
                  const translated = i18nKey ? t(i18nKey) : '';
                  const name = (translated && translated !== i18nKey) ? translated : s.name;
                  return (
                    <button key={s.id} onClick={() => handleQuickLink(s)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500 hover:border-indigo-500 hover:text-indigo-500 hover:bg-indigo-50 transition-all">
                      <span className="text-sm">{icon?.startsWith('img:') ? <img src={icon.slice(4)} alt="" width={16} height={16} className="inline rounded-sm object-cover" /> : icon}</span> {name}
                    </button>
                  );
                })}
                <button onClick={() => setShowShortcutCustomize(true)}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-dashed border-gray-200 text-xs text-gray-400 hover:border-gray-400 hover:text-gray-600 transition-all">
                  ⋯
                </button>
              </div>
            </>
          )}
          <div className={`w-full ${compact ? 'max-w-full' : 'max-w-[55%]'} mb-1`}>
            <ChatInput onSend={handleSend} onFileAttach={uploadFile} onAgentSelect={handleAgentSelect} activeAgent={activeAgent} agentList={mergedAgentList} onClearAgent={handleClearAgent} pendingAttachments={pendingAttachments} onRemoveAttachment={removePendingAttachment} disabled={isStreaming} onStop={stopGeneration} errorHint={errorHint} suggestions={compact ? undefined : suggestions} onRemoveSuggestion={compact ? undefined : removeSuggestion} onClearSuggestions={compact ? undefined : clearSuggestions} compact={compact} menuUp={compact} offlineHint={activeCwOffline ? `${activeCwOffline} 当前不在线，请稍后再试` : undefined} />
          </div>
          {!compact && <p className="text-[11px] text-gray-400 mt-1.5">{t('chat.disclaimer')}</p>}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0 relative">
          <ChatMessages messages={messages} compact={compact} isStreaming={isStreaming} thinkingText={thinkingText} thinkingHead={thinkingHead} onResend={handleSend} onButtonClick={(text) => text === '新建会话' ? newSession() : handleSend(text)} activeAgent={activeAgent} pendingConfirm={pendingConfirm} onConfirmReply={confirmReply} />
          <div className={compact ? 'px-2.5 pb-2 shrink-0 relative z-30' : 'px-[15%] pb-3 shrink-0 relative z-30'}>
            <ContextIndicator status={contextStatus} />
            <ChatInput onSend={handleSend} onFileAttach={uploadFile} onAgentSelect={handleAgentSelect} activeAgent={activeAgent} agentList={mergedAgentList} onClearAgent={handleClearAgent} pendingAttachments={pendingAttachments} onRemoveAttachment={removePendingAttachment} disabled={isStreaming} onStop={stopGeneration} errorHint={errorHint} compact={compact} menuUp offlineHint={activeCwOffline ? `${activeCwOffline} 当前不在线，请稍后再试` : undefined} />
            <p className="text-[11px] text-gray-400 text-center mt-1">{t('chat.disclaimer')}</p>
          </div>
        </div>
      )}
    </>
  );

  // 移动模式：单列聊天外壳，不渲染任何面板类功能
  if (isMobile) {
    return (
      <div className="flex flex-col h-full">
        <MobileShell
          user={user}
          token={token}
          companyName={companyName}
          agentList={agentList}
          myCoWorkers={myCoWorkers}
          activeAgent={activeAgent}
          sessionId={sessionId}
          onAgentSelect={handleAgentSelect}
          onLoadSession={(sid) => { loadSession(sid); setChatStarted(true); }}
          onNewSession={() => { newSession(); setChatStarted(false); }}
          onLogout={handleLogout}
        >
          {renderChatContent(true)}
        </MobileShell>
        {licenseOverlays}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {isAdmin && needsGuidedConfig && (
        <ConfigGuideBanner token={token!} onNavigate={(panel) => { handleNavigate(panel); setNeedsGuidedConfig(false); }} />
      )}
      <div className="flex flex-1 min-h-0">
      <Sidebar active={activeNav} onNavigate={handleNavigate} panels={sidebarPanels} onCustomize={() => setShowCustomize(true)} />

      <div className="flex flex-1 overflow-hidden relative">
        {/* Content area — keep-alive: visited panels stay mounted, hidden via CSS */}
        {contentPanel && (
          <div className="flex-1 flex flex-col bg-white min-w-0">
            <div className="h-11 bg-white border-b border-gray-200 flex items-center px-4 gap-2 shrink-0">
              <button onClick={() => { setContentPanel(null); setExpanded(false); setShowFloating(false); if (activeAgent === 'skill_builder') handleClearAgent(); }} className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-1.5 py-0.5">✕</button>
              {contentPanel.icon?.startsWith('img:') && <img src={contentPanel.icon.slice(4)} alt="" width={18} height={18} className="rounded-sm object-cover" />}
              <span className="text-sm font-medium">{contentPanel.title}</span>
              <div className="flex-1" />
              <button
                onClick={() => { setExpanded(!expanded); setShowFloating(false); }}
                className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-1.5 py-0.5 text-sm"
                title={expanded ? t('user.showChat') : t('user.expandFull')}
              >{expanded ? '◧' : '⛶'}</button>
            </div>
            <div className="flex-1 overflow-hidden relative min-h-0">
              {visitedPanels.has('cfg') && <div className={contentPanel.type === 'cfg' ? 'h-full' : 'hidden'}><SettingsPanel /></div>}
              {visitedPanels.has('kb') && <div className={contentPanel.type === 'kb' ? 'h-full' : 'hidden'}><KBPanel /></div>}
              {visitedPanels.has('cw') && <div className={contentPanel.type === 'cw' ? 'h-full' : 'hidden'}><CoWorkerPanel /></div>}
              {visitedPanels.has('skills') && <div className={contentPanel.type === 'skills' ? 'h-full' : 'hidden'}><SkillsManagePanel messages={messages} onOpenSession={(_skillName, sid, agentType) => {
                setActiveAgent(agentType);
                setChatStarted(true);
                if (sid) loadSession(sid);
              }} /></div>}
              {visitedPanels.has('connectors') && <div className={contentPanel.type === 'connectors' ? 'h-full' : 'hidden'}><ConnectorsPanel onOpenSession={(_name, sid, agentType) => {
                setActiveAgent(agentType);
                setChatStarted(true);
                if (sid) loadSession(sid);
              }} /></div>}
              {visitedPanels.has('dashboard') && <div className={contentPanel.type === 'dashboard' ? 'h-full' : 'hidden'}><CustomDashboardPanel token={token} onOpenSession={(_name, sid, agentType) => {
                setActiveAgent(agentType);
                setChatStarted(true);
                if (sid) loadSession(sid);
              }} onActivePdfChange={setActivePdfFileId} /></div>}
              {visitedPanels.has('agents') && <div className={contentPanel.type === 'agents' ? 'h-full' : 'hidden'}><AgentManagerPanel /></div>}
              {/* Third-party extension panels — on-demand mount (keepAlive=false) */}
              {sidebarPanels
                .filter(p => p.category === 'third_party' && p.sourceAppId && p.entryComponent &&
                  (contentPanel?.type === p.id || (p as any).keepAlive && visitedPanels.has(p.id)))
                .map(p => (
                  <div key={p.id} className={contentPanel?.type === p.id ? 'h-full' : 'hidden'}>
                    <DynamicPanelLoader
                      panel={{
                        id: p.id,
                        name: p.name,
                        sourceAppId: p.sourceAppId!,
                        entryComponent: p.entryComponent!,
                        version: p.appVersion ?? '0',
                        keepAlive: (p as any).keepAlive,
                      }}
                      initialData={agentPanelData[p.id]}
                      onMessage={msg => setAgentPanelData(prev => ({ ...prev, [p.id]: msg }))}
                      onAgentMessage={msg => handlePanelAgentMessage(
                        { id: p.id, sourceAppId: p.sourceAppId, agentId: p.agentId },
                        msg,
                      )}
                    />
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Draggable divider */}
        {isAside && (
          <div
            onMouseDown={handleDividerMouseDown}
            className="w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-indigo-400 active:bg-indigo-500 transition-colors"
          />
        )}

        {/* Floating chat bubble */}
        {isFloating && !showFloating && (
          <button onClick={() => setShowFloating(true)}
            className="absolute right-5 bottom-5 w-12 h-12 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xl shadow-lg hover:scale-105 transition-transform z-40"
            title="打开对话">💬</button>
        )}

        <FloatingPanel visible={isFloating && showFloating} onClose={() => setShowFloating(false)} onDock={() => { setExpanded(false); setShowFloating(false); }}>
          {renderChatContent(true)}
        </FloatingPanel>

        {showEmailPanel && <MyEmailPanel onClose={() => setShowEmailPanel(false)} />}

        {/* Chat panel */}
        <div className={`flex flex-col bg-white relative ${
          isFloating ? 'hidden' : isAside ? 'shrink-0' : 'flex-1'
        }`} style={isAside ? { width: chatWidth } : { width: 'auto' }}>
          <div className="h-11 flex items-center px-4 border-b border-gray-200 shrink-0">
            <button onClick={() => setShowSessionList(!showSessionList)} className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-1.5 py-0.5 mr-2 text-sm" title={t('user.sessionHistory')}>☰</button>
            <button onClick={() => { newSession(); setChatStarted(false); }} className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-1.5 py-0.5 mr-2 text-sm" title={t('user.newChat')}>✎</button>
            {/* CoWorker / Agent selector */}
            <div className="relative" ref={headerAgentMenuRef}>
              <button
                onClick={() => myCoWorkers.length > 0 && setShowHeaderAgentMenu(!showHeaderAgentMenu)}
                className={`flex items-center gap-1.5 text-sm font-medium truncate ${myCoWorkers.length > 0 ? 'text-gray-900 hover:text-indigo-600 cursor-pointer' : 'text-gray-900 cursor-default'}`}
              >
                {activeAgent === 'main' ? (
                  <>{agentList.find(a => a.id === 'main')?.icon || '🔮'} {companyName || t('user.companyName')}</>
                ) : (() => {
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
                })()}
                {myCoWorkers.length > 0 && <span className="text-[10px] text-gray-400">▼</span>}
              </button>
              {showHeaderAgentMenu && (
                <div className="absolute left-0 top-8 bg-white border border-gray-200 rounded-lg shadow-xl py-1 min-w-[180px] z-50">
                  <button
                    onClick={() => { handleAgentSelect('main'); setShowHeaderAgentMenu(false); }}
                    className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${activeAgent === 'main' ? 'text-indigo-600 bg-indigo-50 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
                  >
                    {agentList.find(a => a.id === 'main')?.icon || '🔮'} {companyName || t('user.companyName')}
                  </button>
                  {myCoWorkers.map((item: any) => {
                    const online = item.lastSeen ? (Date.now() - new Date(item.lastSeen).getTime() < 90000) : false;
                    return (
                      <button
                        key={item.id}
                        onClick={() => { handleAgentSelect(item.coworker.id); setShowHeaderAgentMenu(false); }}
                        className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 ${activeAgent === item.coworker.id ? 'text-indigo-600 bg-indigo-50 font-medium' : 'text-gray-700 hover:bg-gray-50'}`}
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
            <div className="flex-1" />
            {isAside && (
              <button onClick={() => { setExpanded(true); setShowFloating(true); }}
                className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded px-1.5 py-0.5 mr-2 text-sm" title={t('user.floatingMode')}>⬡</button>
            )}
            <div className="mr-2">
              <MobileAccessQr url={mobileAccessUrl} />
            </div>
            <div className="relative group">
              <div className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-semibold cursor-pointer">
                {(user.username || user.name).charAt(0)}
              </div>
              <div className="hidden group-hover:block absolute right-0 top-9 bg-white border border-gray-200 rounded-lg p-2 min-w-[140px] shadow-lg z-50">
                <div className="px-2 py-1 text-sm font-medium">{user.username || user.name}</div>
                {/* <div className="px-2 py-0.5 text-xs text-gray-400">{getRoleName(user.role)}</div>
                <div className="px-2 py-0.5 text-xs text-gray-400">{user.name} · {user.email}</div> */}
                <div className="border-t border-gray-100 my-1"></div>
                <div className="relative group/lang">
                  <button className="w-full text-left px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded flex items-center justify-between">
                    <span>🌐 {t('user.language')}</span>
                    <span className="text-[10px] text-gray-300 ml-2">{LOCALES.find(l => l.value === locale)?.label} ▸</span>
                  </button>
                  <div className="hidden group-hover/lang:block absolute right-full top-0 mr-1 bg-white border border-gray-200 rounded-lg py-1 shadow-lg min-w-[120px] z-50">
                    {LOCALES.map(l => (
                      <button key={l.value} onClick={() => setLocale(l.value)}
                        className={`w-full text-left px-3 py-1.5 text-xs hover:bg-gray-50 ${locale === l.value ? 'text-indigo-600 font-medium' : 'text-gray-500'}`}>
                        {locale === l.value && <span className="mr-1">✓</span>}{l.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="relative group/msg">
                  <button className="w-full text-left px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded flex items-center justify-between">
                    <span>🔔 {t('msgDisplay.title')}</span>
                    <span className="text-[10px] text-gray-300">▸</span>
                  </button>
                  <div className="hidden group-hover/msg:block absolute right-full top-0 mr-1 bg-white border border-gray-200 rounded-lg py-1 shadow-lg min-w-[160px] z-50">
                    {(['toolProcess', 'toolResult', 'sourceRef'] as const).map(key => {
                      const globalOff = msgDisplay.isDisabledByGlobal(key);
                      const agentOff = msgDisplay.isDisabledByAgent(key);
                      const disabled = globalOff || agentOff;
                      const checked = msgDisplay.shouldShow(key);
                      return (
                        <label key={key} className={`flex items-center gap-2 px-3 py-1.5 text-xs ${disabled ? 'opacity-40' : 'hover:bg-gray-50 cursor-pointer'}`}>
                          <input type="checkbox" checked={checked} disabled={disabled}
                            onChange={() => msgDisplay.saveUser('_all', { [key]: !checked })}
                            className="rounded border-gray-300 text-indigo-600" />
                          {t(`msgDisplay.${key}`)}
                        </label>
                      );
                    })}
                  </div>
                </div>
                <button onClick={() => setShowEmailPanel(true)} className="w-full text-left px-2 py-1 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 rounded">
                  ✉️ 我的邮箱
                </button>
                <div className="border-t border-gray-100 my-1"></div>
                <button onClick={handleLogout} className="w-full text-left px-2 py-1 text-xs text-gray-500 hover:text-red-500 hover:bg-gray-50 rounded">{t('user.logout')}</button>
              </div>
            </div>
          </div>

          {/* Chat content + session list overlay */}
          <div className="flex-1 flex flex-col relative min-h-0">
            <SessionList
              token={token}
              agentType={activeAgent}
              currentSessionId={sessionId}
              onSelect={(sid) => { loadSession(sid); setChatStarted(true); }}
              onNew={() => { newSession(); setChatStarted(false); }}
              visible={showSessionList}
              onClose={() => setShowSessionList(false)}
            />
            {renderChatContent(isAside)}
          </div>
        </div>
      </div>

      {showCustomize && (
        <SidebarCustomizeModal
          panels={sidebarPanels}
          onSave={saveSidebar}
          onReset={resetSidebar}
          onClose={() => setShowCustomize(false)}
          isAdmin={isAdmin}
        />
      )}

      {showShortcutCustomize && (
        <ShortcutCustomizeModal
          shortcuts={shortcuts}
          panels={sidebarPanels}
          onSave={saveShortcuts}
          onReset={resetShortcuts}
          onClose={() => setShowShortcutCustomize(false)}
        />
      )}

      {licenseOverlays}
    </div>
    </div>
  );
}
