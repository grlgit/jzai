'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

export interface Dashboard {
  id: string;
  userId: string;
  name: string;
  description: string;
  layout: any[];
  theme: 'light' | 'dark';
  isDefault: boolean;
  shared?: boolean;      // true = 他人分享给我（只读）
  ownerName?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardWidget {
  id: string;
  dashboardId: string;
  userId: string;
  widgetType: string;
  title: string;
  config: any;
  dataSource: any;
  refreshInterval: number;
  cachedData: any;
  cachedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function useDashboard(token: string | null) {
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [activeDashboard, setActiveDashboard] = useState<Dashboard | null>(null);
  const [widgets, setWidgets] = useState<DashboardWidget[]>([]);
  const [loading, setLoading] = useState(false);

  const headers = useCallback(() => ({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
  }), [token]);

  // 显式选择时间戳：ui_hook/用户切换等显式选择后，阻止 loadDashboards 的默认自动选择
  // 回写覆盖目标仪表盘（闭包中的 activeDashboard 是旧值，不能用它判断）
  const explicitSelectAt = useRef(0);

  const loadDashboards = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards`, { headers: headers() });
      const data = await resp.json();
      if (Array.isArray(data)) {
        setDashboards(data);
        // Auto-select default or first — 仅当近期没有显式选择（如 agent ui_hook 切换到新建看板）
        if (data.length > 0 && !activeDashboard && Date.now() - explicitSelectAt.current > 10_000) {
          const def = data.find((d: Dashboard) => d.isDefault) || data[0];
          await loadDashboardDetail(def.id, { auto: true });
        }
      }
    } catch {}
    setLoading(false);
  }, [token]);

  const loadDashboardDetail = useCallback(async (id: string, opts?: { auto?: boolean }) => {
    if (!token) return;
    if (!opts?.auto) explicitSelectAt.current = Date.now();
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards/${id}`, { headers: headers() });
      const data = await resp.json();
      if (data.dashboard) {
        setActiveDashboard(data.dashboard);
        // 同步进列表：agent 新建的仪表盘可能不在已加载的列表中，
        // 否则 <select value={id}> 无匹配项会回显第一个仪表盘，造成"标题与内容错位"；
        // 新项插入最上方（列表按创建时间倒排）
        setDashboards(prev => {
          const d = data.dashboard;
          return prev.some(x => x.id === d.id)
            ? prev.map(x => (x.id === d.id ? { ...x, ...d } : x))
            : [d, ...prev];
        });
        const ws: DashboardWidget[] = data.widgets || [];
        setWidgets(ws);
        // 过期即刷：缓存超过 refresh_interval（或从未缓存）的 widget 打开面板时立即后台刷新
        const now = Date.now();
        const stale = ws.filter(w => w.refreshInterval > 0 &&
          (!w.cachedAt || now - new Date(w.cachedAt).getTime() > w.refreshInterval * 1000));
        if (stale.length > 0) {
          const results = await Promise.all(stale.map(w =>
            fetch(`${MAIN_URL}/api/dashboards/${id}/widgets/${w.id}/refresh`, { method: 'POST', headers: headers() })
              .then(r => r.json()).catch(() => null),
          ));
          setWidgets(prev => prev.map(w => results.find(u => u?.id === w.id) || w));
        }
      }
    } catch {}
  }, [token]);

  const createDashboard = useCallback(async (name: string, theme: 'light' | 'dark' = 'light') => {
    if (!token) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ name, theme }),
      });
      const data = await resp.json();
      if (data.id) {
        await loadDashboards();
        await loadDashboardDetail(data.id);
      }
    } catch {}
  }, [token, loadDashboards, loadDashboardDetail]);

  const updateDashboard = useCallback(async (id: string, updates: { name?: string; description?: string; theme?: 'light' | 'dark' }) => {
    if (!token) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards/${id}`, {
        method: 'PUT', headers: headers(), body: JSON.stringify(updates),
      });
      const data = await resp.json();
      if (data.id) {
        setActiveDashboard(prev => (prev?.id === id ? data : prev));
        setDashboards(prev => prev.map(d => (d.id === id ? { ...d, ...data } : d)));
      }
      return data;
    } catch {}
  }, [token]);

  const deleteDashboard = useCallback(async (id: string) => {
    if (!token) return;
    try {
      await fetch(`${MAIN_URL}/api/dashboards/${id}`, { method: 'DELETE', headers: headers() });
      await loadDashboards();
      if (activeDashboard?.id === id) {
        setActiveDashboard(null);
        setWidgets([]);
      }
    } catch {}
  }, [token, activeDashboard, loadDashboards]);

  const saveLayout = useCallback(async (layout: any[]) => {
    if (!token || !activeDashboard) return;
    try {
      await fetch(`${MAIN_URL}/api/dashboards/${activeDashboard.id}/layout`, {
        method: 'PUT', headers: headers(), body: JSON.stringify({ layout }),
      });
      // 同步本地状态：避免退出编辑后布局仍是旧值（重进编辑态时新旧布局跳变）
      setActiveDashboard(prev => (prev ? { ...prev, layout } : prev));
      setDashboards(prev => prev.map(d => (d.id === activeDashboard.id ? { ...d, layout } : d)));
    } catch {}
  }, [token, activeDashboard]);

  const deleteWidget = useCallback(async (widgetId: string) => {
    if (!token || !activeDashboard) return;
    try {
      await fetch(`${MAIN_URL}/api/dashboards/${activeDashboard.id}/widgets/${widgetId}`, {
        method: 'DELETE', headers: headers(),
      });
      await loadDashboardDetail(activeDashboard.id);
    } catch {}
  }, [token, activeDashboard, loadDashboardDetail]);

  const refreshWidget = useCallback(async (widgetId: string) => {
    if (!token || !activeDashboard) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards/${activeDashboard.id}/widgets/${widgetId}/refresh`, {
        method: 'POST', headers: headers(),
      });
      const updated = await resp.json();
      if (updated.id) {
        setWidgets(prev => prev.map(w => w.id === updated.id ? updated : w));
      }
    } catch {}
  }, [token, activeDashboard]);

  const updateWidget = useCallback(async (widgetId: string, updates: { title?: string; config?: any; dataSource?: any; refreshInterval?: number }) => {
    if (!token || !activeDashboard) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards/${activeDashboard.id}/widgets/${widgetId}`, {
        method: 'PUT', headers: headers(), body: JSON.stringify(updates),
      });
      const updated = await resp.json();
      if (updated.id) {
        setWidgets(prev => prev.map(w => w.id === updated.id ? updated : w));
      }
      return updated;
    } catch {}
  }, [token, activeDashboard]);

  const addWidget = useCallback(async (widget: { widgetType: string; title: string; config?: any; dataSource?: any; refreshInterval?: number }) => {
    if (!token || !activeDashboard) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards/${activeDashboard.id}/widgets`, {
        method: 'POST', headers: headers(), body: JSON.stringify(widget),
      });
      const data = await resp.json();
      if (data.id) await loadDashboardDetail(activeDashboard.id);
      return data;
    } catch {}
  }, [token, activeDashboard, loadDashboardDetail]);

  // ===== 分享管理（仅创建者） =====
  const listShares = useCallback(async (dashboardId: string) => {
    if (!token) return [];
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards/${dashboardId}/shares`, { headers: headers() });
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }, [token]);

  const addShare = useCallback(async (dashboardId: string, userId: string) => {
    if (!token) return;
    await fetch(`${MAIN_URL}/api/dashboards/${dashboardId}/shares`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ userId }),
    });
  }, [token]);

  const removeShare = useCallback(async (dashboardId: string, userId: string) => {
    if (!token) return;
    await fetch(`${MAIN_URL}/api/dashboards/${dashboardId}/shares/${userId}`, {
      method: 'DELETE', headers: headers(),
    });
  }, [token]);

  const searchUsers = useCallback(async (q: string) => {
    if (!token || !q.trim()) return [];
    try {
      const resp = await fetch(`${MAIN_URL}/api/users/search?q=${encodeURIComponent(q.trim())}`, { headers: headers() });
      const data = await resp.json();
      return Array.isArray(data) ? data : [];
    } catch { return []; }
  }, [token]);

  useEffect(() => {
    loadDashboards();
  }, [loadDashboards]);

  return {
    dashboards, activeDashboard, widgets, loading,
    loadDashboards, loadDashboardDetail, createDashboard, deleteDashboard, updateDashboard,
    saveLayout, deleteWidget, refreshWidget, updateWidget, addWidget,
    listShares, addShare, removeShare, searchUsers,
    setActiveDashboard,
  };
}
