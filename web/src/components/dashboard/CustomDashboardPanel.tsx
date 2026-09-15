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
    loadDashboardDetail, createDashboard, deleteDashboard,
    saveLayout, deleteWidget, refreshWidget, updateWidget, addWidget,
  } = useDashboard(token);

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
  const [newName, setNewName] = useState('');
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
    await createDashboard(newName.trim());
    setNewName('');
    setShowNewDialog(false);
  }, [newName, createDashboard]);

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
    return <div className="flex items-center justify-center h-full text-gray-400 text-sm">加载中...</div>;
  }

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {/* Tab bar — top level */}
      <div className="flex border-b border-gray-200 bg-white shrink-0">
        {([['grid', '📊 仪表盘'], ['sheets', '📋 工作表'], ['pdf', '📄 PDF文档']] as const).map(([key, label]) => (
          <button key={key} onClick={() => setPanelTab(key)}
            className={`px-5 py-2 text-xs font-medium border-b-2 transition-colors ${panelTab === key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden min-h-0">
        {/* Grid tab - 使用 CSS 显示/隐藏保持组件挂载状态 */}
        <div className={panelTab === 'grid' ? 'h-full flex flex-col' : 'hidden'}>
          {/* Dashboard toolbar — inside grid tab */}
          <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
            <select value={activeDashboard?.id || ''}
              onChange={(e) => { if (e.target.value) loadDashboardDetail(e.target.value); }}
              className="text-sm border border-gray-200 rounded-md px-2 py-1 bg-white min-w-[140px]">
              {dashboards.map(d => (<option key={d.id} value={d.id}>{d.name}</option>))}
              {dashboards.length === 0 && <option value="">无仪表盘</option>}
            </select>
            <button onClick={() => setShowNewDialog(true)}
              className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-500 hover:text-indigo-600 hover:border-indigo-300">+ 新建</button>
            {activeDashboard && (
              <button onClick={() => loadDashboardDetail(activeDashboard.id)}
                className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-indigo-600 hover:border-indigo-300" title="刷新仪表盘">⟳</button>
            )}
            <div className="flex-1" />
            {activeDashboard && (
              <>
                <button onClick={() => setEditingWidget(null)}
                  className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-500 hover:text-indigo-600 hover:border-indigo-300">+ 添加仪表</button>
                <button onClick={() => setEditing(!editing)}
                  className={`text-xs px-2 py-1 rounded border ${editing ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-200 text-gray-500 hover:text-indigo-600'}`}>
                  {editing ? '完成编辑' : '编辑布局'}</button>
                <button onClick={handleDeleteDashboard}
                  className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-300">删除</button>
              </>
            )}
          </div>
          <div className="flex-1 overflow-auto p-3">
          {activeDashboard ? (
            <DashboardGrid
              layout={activeDashboard.layout || []}
              widgets={widgets}
              editing={editing}
              onLayoutChange={saveLayout}
              onDeleteWidget={deleteWidget}
              onRefreshWidget={refreshWidget}
              onEditWidget={(w) => setEditingWidget(w)}
              onChatWidget={chatWithWidget}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-gray-300">
              <div className="text-center">
                <div className="text-4xl mb-3">📊</div>
                <div className="text-sm mb-2">还没有仪表盘</div>
                <button onClick={() => setShowNewDialog(true)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">
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

      {/* New dashboard dialog */}
      {showNewDialog && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-80 p-5">
            <h3 className="text-sm font-medium mb-3">新建仪表盘</h3>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleCreateDashboard()}
              placeholder="仪表盘名称"
              className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm mb-3 focus:outline-none focus:border-indigo-400"
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setShowNewDialog(false); setNewName(''); }}
                className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700">取消</button>
              <button onClick={handleCreateDashboard}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700">创建</button>
            </div>
          </div>
        </div>
      )}
      </div>
    );
  }
