'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import DashboardGrid from './DashboardGrid';
import WidgetEditDialog from './WidgetEditDialog';
import { useDashboard } from '@/hooks/useDashboard';
import { useUIHooks } from '@/hooks/useUIHooks';
import type { DashboardWidget } from '@/hooks/useDashboard';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

const SpreadsheetPanel = dynamic(() => import('./SpreadsheetPanel'), { ssr: false });
const PdfPanel = dynamic(() => import('./PdfPanel'), { ssr: false });

const MAIN_URL = getMainUrl();

interface CustomDashboardPanelProps {
  token: string | null;
  onOpenSession?: (name: string, sessionId: string, agentType: string) => void;
  onActivePdfChange?: (fileId: string) => void;
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export default function CustomDashboardPanel({ token, onOpenSession, onActivePdfChange }: CustomDashboardPanelProps) {
  const {
    dashboards, activeDashboard, widgets, loading,
    loadDashboardDetail, createDashboard, deleteDashboard, updateDashboard,
    saveLayout, deleteWidget, refreshWidget, updateWidget, addWidget,
    listShares, addShare, removeShare, searchUsers,
  } = useDashboard(token);

  // 仪表盘级视觉主题（黑/白），存库随实例分发
  const theme: 'light' | 'dark' = activeDashboard?.theme === 'dark' ? 'dark' : 'light';
  // 分享只读：非创建者仅可查看与手动刷新，全部写入口隐藏（后端同样 403）
  const readonly = !!activeDashboard?.shared;
  const toggleTheme = useCallback(async () => {
    if (!activeDashboard || readonly) return;
    await updateDashboard(activeDashboard.id, { theme: theme === 'dark' ? 'light' : 'dark' });
  }, [activeDashboard, theme, readonly, updateDashboard]);

  // UI Hooks: agent → dashboard panel communication
  useUIHooks('dashboard', {
    'refresh': ({ dashboardId }: { dashboardId?: string }) => {
      if (dashboardId) loadDashboardDetail(dashboardId);
      else if (activeDashboard) loadDashboardDetail(activeDashboard.id);
    },
    'show-file': ({ fileId }: { fileId?: string }) => {
      setPanelTab('sheets');
      if (fileId) setPendingFileId(fileId);
    },
    'show-pdf': ({ fileId }: { fileId?: string }) => {
      setPanelTab('pdf');
      if (fileId) setPendingPdfId(fileId);
    },
  });
  const [pendingFileId, setPendingFileId] = useState<string | undefined>();
  const [pendingPdfId, setPendingPdfId] = useState<string | undefined>();
  const [currentFileId, setCurrentFileId] = useState<string | undefined>();
  const [currentPdfId, setCurrentPdfId] = useState<string | undefined>();
  const [panelTab, setPanelTab] = useState<'grid' | 'sheets' | 'pdf'>('grid');
  const [editing, setEditing] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [newName, setNewName] = useState('');
  const [newTheme, setNewTheme] = useState<'light' | 'dark'>('light');
  const [editingWidget, setEditingWidget] = useState<DashboardWidget | null | undefined>(undefined);

  // Auto-refresh widgets with intervals
  useEffect(() => {
    const timers: ReturnType<typeof setInterval>[] = [];
    for (const w of widgets) {
      if (w.refreshInterval > 0) {
        timers.push(setInterval(() => refreshWidget(w.id), w.refreshInterval * 1000));
      }
    }
    return () => timers.forEach(clearInterval);
  }, [widgets, refreshWidget]);

  const handleCreateDashboard = useCallback(async () => {
    if (!newName.trim()) return;
    await createDashboard(newName.trim(), newTheme);
    setNewName('');
    setNewTheme('light');
    setShowNewDialog(false);
  }, [newName, newTheme, createDashboard]);

  const handleDeleteDashboard = useCallback(async () => {
    if (!activeDashboard) return;
    if (!(await confirmDialog(`确定删除仪表盘"${activeDashboard.name}"？其中的所有仪表也会被删除。`, { danger: true }))) return;
    await deleteDashboard(activeDashboard.id);
  }, [activeDashboard, deleteDashboard]);

  const chatWithWidget = useCallback(async (widget: DashboardWidget) => {
    if (!onOpenSession) return;
    // Try to find existing session bound to this widget
    try {
      const resp = await fetch(`${MAIN_URL}/api/sessions/by-skill/widget:${widget.id}`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({ session: null }));
      if (resp.session) {
        onOpenSession(widget.title, resp.session.id, resp.session.agentType);
        return;
      }
    } catch {}
    // No existing session — just open data_master (no auto message)
    onOpenSession(widget.title, '', 'data_master');
  }, [onOpenSession]);

  if (loading && !activeDashboard) {
    return <div className="jz-dash flex items-center justify-center h-full text-[var(--jz-muted)] text-sm bg-[var(--jz-bg)]">加载中...</div>;
  }

  return (
    <div className="jz-dash flex flex-col h-full bg-[var(--jz-bg)]">
      {/* Tab bar — top level（主题作用域：仪表盘相关区域，工作表/PDF 面板保持原样） */}
      <div className={`jz-dash ${theme === 'dark' ? 'jz-dark' : ''} flex border-b border-[var(--jz-border)] bg-[var(--jz-card)] shrink-0`}>
        {([['grid', '📊 仪表盘'], ['sheets', '📋 工作表'], ['pdf', '📄 PDF文档']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setPanelTab(key)}
            className={`px-5 py-2 text-xs font-medium border-b-2 transition-colors ${panelTab === key ? 'border-[var(--jz-accent)] text-[var(--jz-accent)]' : 'border-transparent text-[var(--jz-muted)] hover:text-[var(--jz-fg)]'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden min-h-0">
        {/* Grid tab - 使用 CSS 显示/隐藏保持组件挂载状态 */}
        <div className={panelTab === 'grid' ? `jz-dash ${theme === 'dark' ? 'jz-dark' : ''} h-full flex flex-col bg-[var(--jz-bg)]` : 'hidden'}>
          {/* Dashboard toolbar — inside grid tab */}
          <div className="flex items-center gap-2 px-4 py-2 bg-[var(--jz-card)] border-b border-[var(--jz-border)] shrink-0">
            <select value={activeDashboard?.id || ''}
              onChange={(e) => { if (e.target.value) loadDashboardDetail(e.target.value); }}
              className="text-sm border border-[var(--jz-border)] rounded-md px-2 py-1 bg-[var(--jz-card)] text-[var(--jz-fg)] min-w-[140px]">
              {dashboards.map(d => (<option key={d.id} value={d.id}>{d.shared ? `🤝 ${d.name}（来自 ${d.ownerName || '他人'}）` : d.name}</option>))}
              {dashboards.length === 0 && <option value="">无仪表盘</option>}
            </select>
            <button onClick={() => setShowNewDialog(true)}
              className="text-xs px-2 py-1 rounded border border-[var(--jz-border)] text-[var(--jz-muted)] hover:text-[var(--jz-accent)] hover:border-[var(--jz-accent)]">+ 新建</button>
            {activeDashboard && (
              <button onClick={() => loadDashboardDetail(activeDashboard.id)}
                className="text-xs px-2 py-1 rounded border border-[var(--jz-border)] text-[var(--jz-muted)] hover:text-[var(--jz-accent)] hover:border-[var(--jz-accent)]" title="刷新仪表盘">⟳</button>
            )}
            {activeDashboard && !readonly && (
              <button onClick={toggleTheme}
                className="text-xs px-2 py-1 rounded border border-[var(--jz-border)] text-[var(--jz-muted)] hover:text-[var(--jz-accent)] hover:border-[var(--jz-accent)]"
                title={theme === 'dark' ? '切换为白风格' : '切换为黑风格（大屏）'}>
                {theme === 'dark' ? '☀️ 白' : '🌙 黑'}
              </button>
            )}
            {activeDashboard && !readonly && (
              <button onClick={() => setShowShareDialog(true)}
                className="text-xs px-2 py-1 rounded border border-[var(--jz-border)] text-[var(--jz-muted)] hover:text-[var(--jz-accent)] hover:border-[var(--jz-accent)]"
                title="分享给其他用户（只读）">
                🤝 分享
              </button>
            )}
            <div className="flex-1" />
            {activeDashboard && !readonly && (
              <>
                <button onClick={() => setEditingWidget(null)}
                  className="text-xs px-2 py-1 rounded border border-[var(--jz-border)] text-[var(--jz-muted)] hover:text-[var(--jz-accent)] hover:border-[var(--jz-accent)]">+ 添加仪表</button>
                <button onClick={() => setEditing(!editing)}
                  className={`text-xs px-2 py-1 rounded border ${editing ? 'border-[var(--jz-accent)] text-[var(--jz-accent)] bg-[var(--jz-accent-soft)]' : 'border-[var(--jz-border)] text-[var(--jz-muted)] hover:text-[var(--jz-accent)]'}`}>
                  {editing ? '完成编辑' : '编辑布局'}</button>
                <button onClick={handleDeleteDashboard}
                  className="text-xs px-2 py-1 rounded border border-[var(--jz-border)] text-[var(--jz-muted)] hover:text-red-500 hover:border-red-300">删除</button>
              </>
            )}
          </div>
          <div className="flex-1 overflow-auto p-3">
          {activeDashboard ? (
            <DashboardGrid
              layout={activeDashboard.layout || []}
              widgets={widgets}
              editing={editing && !readonly}
              theme={theme}
              readonly={readonly}
              onLayoutChange={saveLayout}
              onDeleteWidget={deleteWidget}
              onRefreshWidget={refreshWidget}
              onEditWidget={(w) => setEditingWidget(w)}
              onChatWidget={chatWithWidget}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-[var(--jz-faint)]">
              <div className="text-center">
                <div className="text-4xl mb-3">📊</div>
                <div className="text-sm mb-2">还没有仪表盘</div>
                <button onClick={() => setShowNewDialog(true)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-[var(--jz-accent)] text-white hover:opacity-90">
                  创建第一个仪表盘
                </button>
              </div>
            </div>
          )}
          </div>
        </div>

        {/* Sheets tab - 使用 CSS 显示/隐藏保持组件挂载状态 */}
        <div className={panelTab === 'sheets' ? 'h-full flex flex-col' : 'hidden'}>
          <SpreadsheetPanel
            openFileId={pendingFileId || currentFileId}
            onFileOpened={() => {
              if (pendingFileId) {
                setCurrentFileId(pendingFileId);
                setPendingFileId(undefined);
              }
            }}
          />
        </div>

        {/* PDF tab - 使用 CSS 显示/隐藏保持组件挂载状态 */}
        <div className={panelTab === 'pdf' ? 'h-full flex flex-col' : 'hidden'}>
          <PdfPanel
            openFileId={pendingPdfId || currentPdfId}
            onFileOpened={() => {
              if (pendingPdfId) {
                setCurrentPdfId(pendingPdfId);
                setPendingPdfId(undefined);
              }
            }}
            onSelectedChange={onActivePdfChange}
          />
        </div>
      </div>

      {/* Widget edit/add dialog */}
      {editingWidget !== undefined && (
        <WidgetEditDialog
          widget={editingWidget}
          theme={theme}
          onClose={() => setEditingWidget(undefined)}
          onSave={async (updates) => {
            if (editingWidget === null) {
              await addWidget(updates);
            } else {
              await updateWidget(editingWidget.id, updates);
            }
            setEditingWidget(undefined);
            // Force reload to ensure chart re-renders with new config
            if (activeDashboard) loadDashboardDetail(activeDashboard.id);
          }}
        />
      )}

      {/* Share dialog */}
      {showShareDialog && activeDashboard && (
        <ShareDialog
          dashboard={activeDashboard}
          onClose={() => setShowShareDialog(false)}
          listShares={listShares}
          addShare={addShare}
          removeShare={removeShare}
          searchUsers={searchUsers}
        />
      )}

      {/* New dashboard dialog */}
      {showNewDialog && (
        <div className={`jz-dash ${theme === 'dark' ? 'jz-dark' : ''} fixed inset-0 bg-black/30 flex items-center justify-center z-50`}>          <div className="bg-[var(--jz-card)] text-[var(--jz-fg)] rounded-xl shadow-xl w-80 p-5 border border-[var(--jz-border)]">
            <h3 className="text-sm font-medium mb-3">新建仪表盘</h3>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateDashboard()}
              placeholder="仪表盘名称"
              className="w-full border border-[var(--jz-border)] rounded-lg px-3 py-2 text-sm mb-3 bg-[var(--jz-card)] text-[var(--jz-fg)] focus:outline-none focus:border-[var(--jz-accent)]"
              autoFocus
            />
            <div className="flex gap-1.5 mb-4">
              {([['light', '☀️ 白风格'], ['dark', '🌙 黑风格（大屏）']] as const).map(([v, l]) => (
                <button key={v} onClick={() => setNewTheme(v)}
                  className={`flex-1 text-xs px-2 py-1.5 rounded border ${newTheme === v ? 'border-[var(--jz-accent)] text-[var(--jz-accent)] bg-[var(--jz-accent-soft)]' : 'border-[var(--jz-border)] text-[var(--jz-muted)]'}`}>
                  {l}
                </button>
              ))}
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowNewDialog(false); setNewName(''); setNewTheme('light'); }}
                className="text-xs px-3 py-1.5 text-[var(--jz-muted)] hover:text-[var(--jz-fg)]">取消</button>
              <button onClick={handleCreateDashboard}
                className="text-xs px-3 py-1.5 rounded-lg bg-[var(--jz-accent)] text-white hover:opacity-90">创建</button>
            </div>
          </div>
        </div>
      )}
      </div>
    );
  }

/** 分享弹窗：创建者将仪表盘分享给其他用户（只读） */
function ShareDialog({ dashboard, onClose, listShares, addShare, removeShare, searchUsers }: {
  dashboard: { id: string; name: string };
  onClose: () => void;
  listShares: (id: string) => Promise<any[]>;
  addShare: (id: string, userId: string) => Promise<void>;
  removeShare: (id: string, userId: string) => Promise<void>;
  searchUsers: (q: string) => Promise<any[]>;
}) {
  const [shares, setShares] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);

  const reload = useCallback(async () => {
    setShares(await listShares(dashboard.id));
  }, [dashboard.id, listShares]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    const t = setTimeout(async () => setResults(q.trim() ? await searchUsers(q) : []), 300);
    return () => clearTimeout(t);
  }, [q, searchUsers]);

  const sharedIds = new Set(shares.map(s => s.userId));
  const candidates = results.filter(u => !sharedIds.has(u.id));

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-[var(--jz-card)] text-[var(--jz-fg)] rounded-xl shadow-xl w-96 p-5 border border-[var(--jz-border)]">
        <h3 className="text-sm font-medium mb-1">分享「{dashboard.name}」</h3>
        <p className="text-[11px] text-[var(--jz-muted)] mb-3">被分享的用户可以查看该看板（只读），不能编辑或删除。</p>

        {/* 已分享列表 */}
        <div className="mb-3">
          <div className="text-[11px] text-[var(--jz-muted)] mb-1">已分享（{shares.length}）</div>
          {shares.length === 0 && <div className="text-xs text-[var(--jz-faint)] py-1">暂未分享给任何人</div>}
          {shares.map(s => (
            <div key={s.userId} className="flex items-center gap-2 py-1">
              <span className="text-xs flex-1 truncate">{s.name || s.username || s.userId}</span>
              <button
                onClick={async () => { await removeShare(dashboard.id, s.userId); await reload(); }}
                className="text-[11px] text-[var(--jz-faint)] hover:text-red-500">移除</button>
            </div>
          ))}
        </div>

        {/* 搜索添加 */}
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="搜索用户（姓名/账号/邮箱）"
          className="w-full border border-[var(--jz-border)] rounded-lg px-3 py-1.5 text-sm mb-2 focus:outline-none focus:border-[var(--jz-accent)]"
        />
        <div className="max-h-40 overflow-y-auto">
          {candidates.map(u => (
            <div key={u.id} className="flex items-center gap-2 py-1">
              <span className="text-xs flex-1 truncate">{u.name}{u.username ? `（${u.username}）` : ''}</span>
              <button
                onClick={async () => { await addShare(dashboard.id, u.id); setQ(''); setResults([]); await reload(); }}
                className="text-[11px] text-[var(--jz-accent)] hover:opacity-80">+ 分享</button>
            </div>
          ))}
          {q.trim() && candidates.length === 0 && <div className="text-[11px] text-[var(--jz-faint)] py-1">无匹配用户</div>}
        </div>

        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg bg-[var(--jz-accent)] text-white hover:opacity-90">完成</button>
        </div>
      </div>
    </div>
  );
}
