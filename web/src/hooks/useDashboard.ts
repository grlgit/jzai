'use client';

import { useState, useCallback, useEffect } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

export interface Dashboard {
  id: string;
  userId: string;
  name: string;
  description: string;
  layout: any[];
  isDefault: boolean;
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

  const loadDashboards = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards`, { headers: headers() });
      const data = await resp.json();
      if (Array.isArray(data)) {
        setDashboards(data);
        // Auto-select default or first
        if (data.length > 0 && !activeDashboard) {
          const def = data.find((d: Dashboard) => d.isDefault) || data[0];
          await loadDashboardDetail(def.id);
        }
      }
    } catch {}
    setLoading(false);
  }, [token]);

  const loadDashboardDetail = useCallback(async (id: string) => {
    if (!token) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards/${id}`, { headers: headers() });
      const data = await resp.json();
      if (data.dashboard) {
        setActiveDashboard(data.dashboard);
        setWidgets(data.widgets || []);
      }
    } catch {}
  }, [token]);

  const createDashboard = useCallback(async (name: string) => {
    if (!token) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dashboards`, {
        method: 'POST', headers: headers(), body: JSON.stringify({ name }),
      });
      const data = await resp.json();
      if (data.id) {
        await loadDashboards();
        await loadDashboardDetail(data.id);
      }
    } catch {}
  }, [token, loadDashboards, loadDashboardDetail]);

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

  useEffect(() => {
    loadDashboards();
  }, [loadDashboards]);

  return {
    dashboards, activeDashboard, widgets, loading,
    loadDashboards, loadDashboardDetail, createDashboard, deleteDashboard,
    saveLayout, deleteWidget, refreshWidget, updateWidget, addWidget,
    setActiveDashboard,
  };
}
