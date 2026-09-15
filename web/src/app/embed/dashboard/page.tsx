'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import DashboardGrid from '@/components/dashboard/DashboardGrid';
import CustomDashboardPanel from '@/components/dashboard/CustomDashboardPanel';
import ChatMessages from '@/components/ChatMessages';
import ChatInput from '@/components/ChatInput';
import { useDashboard } from '@/hooks/useDashboard';
import { useChat } from '@/hooks/useChat';

/**
 * OEM 嵌入页。
 * 第三方系统通过 <iframe src="/embed/dashboard?token=…&view=…"> 加载。
 * token 来自宿主后端的 /api/oem/token 交换（短时 scoped JWT，锁定 data_master）。
 *
 *   view=full（默认，W2）：左侧对话出图 + 右侧数据大师面板（仪表盘/工作表/PDF）
 *   view=dashboard（W1）  ：只读仪表盘
 *
 * 与父窗口通过 postMessage 通信，信封 { source:'jianzhi-oem', type, payload }。
 */

const ENVELOPE = 'jianzhi-oem';
const OEM_AGENT = 'data_master';

function postToParent(type: string, payload: any = {}) {
  if (typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage({ source: ENVELOPE, type, payload }, '*');
}

function applyTheme(primary?: string | null) {
  if (primary) document.documentElement.style.setProperty('--jz-primary', `#${primary.replace(/^#/, '')}`);
}

export default function EmbedDashboardPage() {
  const [token, setToken] = useState<string | null>(null);
  const [view, setView] = useState<'full' | 'dashboard'>('full');
  const [initialDashboardId, setInitialDashboardId] = useState<string | undefined>();
  const [ready, setReady] = useState(false);

  // 1. 读取 URL 参数 + 注入白标 + token 落 iframe 本地（与宿主页同源隔离，宿主脚本读不到）
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const t = q.get('token');
    setView(q.get('view') === 'dashboard' ? 'dashboard' : 'full');
    setInitialDashboardId(q.get('dashboardId') || undefined);
    applyTheme(q.get('primary'));
    if (t) localStorage.setItem('jz_token', t); // 供面板内 sheets/pdf 取数
    setToken(t);
    setReady(true);
  }, []);

  // 2. 父窗口消息：续期 token / 跳转 / 换肤
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const msg = e.data;
      if (!msg || msg.source !== ENVELOPE) return;
      if (msg.type === 'set-token' && msg.payload?.token) {
        localStorage.setItem('jz_token', msg.payload.token);
        setToken(msg.payload.token);
      }
      if (msg.type === 'navigate' && msg.payload?.dashboardId) {
        window.dispatchEvent(new CustomEvent('jianzhi:ui-hook', {
          detail: { panel: 'dashboard', hook: 'refresh', dashboardId: msg.payload.dashboardId },
        }));
      }
      if (msg.type === 'set-theme' && msg.payload?.primary) applyTheme(msg.payload.primary);
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  // 3. ready 信号
  useEffect(() => { if (ready) postToParent('ready'); }, [ready]);

  if (ready && !token) {
    return <div className="p-6 text-sm text-gray-400">缺少访问令牌（token）</div>;
  }
  if (!ready) {
    return <div className="p-6 text-sm text-gray-300">加载中…</div>;
  }

  return view === 'dashboard'
    ? <ReadonlyDashboard token={token} dashboardId={initialDashboardId} />
    : <FullPanel token={token} dashboardId={initialDashboardId} />;
}

/** view=full：对话出图 + 完整数据大师面板 */
function FullPanel({ token, dashboardId }: { token: string | null; dashboardId?: string }) {
  const { messages, isStreaming, errorHint, sendMessage, stopGeneration, pendingConfirm, confirmReply,
          pendingAttachments, uploadFile, removePendingAttachment } = useChat(OEM_AGENT, token, OEM_AGENT);

  // agent → 面板：把 agent-action(ui_hook) 转成面板可消费的 ui-hook
  useEffect(() => {
    const handler = (e: any) => {
      const a = e.detail;
      if (a?.actionType === 'ui_hook' && a.actionData) {
        window.dispatchEvent(new CustomEvent('jianzhi:ui-hook', { detail: a.actionData }));
      }
    };
    window.addEventListener('jianzhi:agent-action', handler);
    return () => window.removeEventListener('jianzhi:agent-action', handler);
  }, []);

  // 进入即定位指定仪表盘
  useEffect(() => {
    if (dashboardId) {
      const t = setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:ui-hook', {
        detail: { panel: 'dashboard', hook: 'refresh', dashboardId },
      })), 400);
      return () => clearTimeout(t);
    }
  }, [dashboardId]);

  return (
    <div className="w-full h-screen flex bg-white overflow-hidden">
      {/* 左：对话 */}
      <div className="flex flex-col border-r border-gray-100" style={{ width: '38%', minWidth: 320 }}>
        <div className="flex-1 overflow-y-auto">
          <ChatMessages messages={messages} compact isStreaming={isStreaming} pendingConfirm={pendingConfirm} onConfirmReply={confirmReply} />
        </div>
        <div className="border-t border-gray-100">
          <ChatInput
            onSend={(m) => sendMessage(m)}
            onFileAttach={uploadFile}
            pendingAttachments={pendingAttachments}
            onRemoveAttachment={removePendingAttachment}
            disabled={isStreaming}
            onStop={stopGeneration}
            errorHint={errorHint}
            compact
          />
        </div>
      </div>
      {/* 右：数据大师面板 */}
      <div className="flex-1 overflow-hidden">
        <CustomDashboardPanel token={token} />
      </div>
    </div>
  );
}

/** view=dashboard：只读仪表盘（W1） */
function ReadonlyDashboard({ token, dashboardId }: { token: string | null; dashboardId?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { activeDashboard, widgets, loading, loadDashboards, loadDashboardDetail, refreshWidget } = useDashboard(token);

  useEffect(() => {
    if (!token) return;
    if (dashboardId) loadDashboardDetail(dashboardId);
    else loadDashboards();
  }, [token, dashboardId, loadDashboards, loadDashboardDetail]);

  // 高度自适应 → 通知父窗口
  useEffect(() => {
    if (!rootRef.current) return;
    const el = rootRef.current;
    const report = () => postToParent('resize', { height: el.scrollHeight });
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, []);

  const noop = useCallback(() => {}, []);

  return (
    <div ref={rootRef} className="w-full min-h-screen bg-white flex flex-col">
      {loading && widgets.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-gray-300 text-sm">加载中…</div>
      ) : (
        <DashboardGrid
          layout={activeDashboard?.layout || []}
          widgets={widgets}
          editing={false}
          onLayoutChange={noop}
          onDeleteWidget={noop}
          onRefreshWidget={refreshWidget}
          onEditWidget={noop}
          onChatWidget={noop}
        />
      )}
    </div>
  );
}
