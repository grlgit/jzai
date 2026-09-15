'use client';

import { useState, useEffect, useCallback } from 'react';

import { getMainUrl } from '@/lib/env';
import { getSocket } from '@/lib/socket';
const MAIN_URL = getMainUrl();

export interface SidebarPanel {
  id: string;
  name: string;
  icon: string;
  visible: boolean;
  groupName: string;
  sortOrder: number;
  isBuiltin: boolean;
  category?: string;
  agentId?: string | null;
  uninstallable?: boolean;
  nameI18n?: { zh?: string; en?: string } | null;
  sourceAppId?: string | null;
  entryComponent?: string | null;
  appVersion?: string | null;
  keepAlive?: boolean;
  messageSchema?: string | null;
}

export function useSidebar(token?: string | null) {
  const [panels, setPanels] = useState<SidebarPanel[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) { setPanels([]); setLoading(false); return; }
    try {
      const resp = await fetch(`${MAIN_URL}/api/sidebar`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await resp.json();
      if (Array.isArray(data)) setPanels(data);
    } catch {}
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // 面板热重载：安装/升级完成后服务端广播 app:updated，
  // 重拉 sidebar——appVersion 变化使面板 assets URL(?v=) 变化，ESM 自动重 import
  useEffect(() => {
    if (!token) return;
    const s = getSocket(token);
    const onAppUpdated = () => { void load(); };
    s.on('app:updated', onAppUpdated);
    return () => { s.off('app:updated', onAppUpdated); };
  }, [token, load]);

  const save = useCallback(async (items: SidebarPanel[]) => {
    if (!token) return;
    setPanels(items); // optimistic
    await fetch(`${MAIN_URL}/api/sidebar`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: items.map(p => ({
          panelId: p.id,
          visible: p.visible,
          groupName: p.groupName,
          sortOrder: p.sortOrder,
          customIcon: p.icon,
        })),
      }),
    });
  }, [token]);

  const reset = useCallback(async () => {
    if (!token) return;
    await fetch(`${MAIN_URL}/api/sidebar`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    await load();
  }, [token, load]);

  return { panels, loading, save, reset, reload: load };
}
