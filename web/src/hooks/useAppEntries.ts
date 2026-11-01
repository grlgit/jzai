'use client';

/**
 * P4 共享 hook：应用入口列表（PC "应用"浮层与移动"应用"TAB 共用，避免两套过滤漂移）。
 * 过滤语义（与改造前 Sidebar 浮层一致）：status==='active' && entryPanels.length>0。
 * 可见性授权由后端 P1 sidebar/app-store 过滤保证，这里不再重复判定。
 */
import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useI18n } from '@/i18n';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

export interface AppEntryPanel {
  id: string;
  name?: { zh?: string; en?: string };
  icon?: string;
  description?: string;
  entryComponent?: string;
  agentId?: string;
  /** P4 移动端声明（/api/sidebar 的 panel.mobile；APP 清单经激活链写入） */
  mobile?: { supported: boolean; entryComponent?: string; layout?: 'full' | 'sheet' };
}

export interface AppEntry {
  appId: string;
  name?: { zh?: string; en?: string };
  version?: string;
  description?: string;
  entryPanels: AppEntryPanel[];
}

export function appEntryPanelTitle(p: AppEntryPanel, locale: string): string {
  const lang = locale.startsWith('zh') ? 'zh' : 'en';
  return p.name?.[lang] || p.name?.zh || p.name?.en || p.id;
}

export function appDisplayName(name: AppEntry['name'], appId: string): string {
  return name?.zh || name?.en || appId;
}

export function useAppEntries(): { apps: AppEntry[]; reload: () => void } {
  const { token } = useAuth();
  const { locale } = useI18n();
  const [apps, setApps] = useState<AppEntry[]>([]);

  const load = useCallback(() => {
    if (!token) return;
    fetch(`${MAIN_URL}/api/app-store/apps`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((data: any[]) => {
        if (!Array.isArray(data)) return;
        setApps(data
          .filter(a => a.status === 'active')
          .map(a => ({ ...a, entryPanels: a.manifest?.panels ?? [] }))
          .filter(a => a.entryPanels.length > 0));
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // locale 参与 panel 标题计算（appEntryPanelTitle），此处仅保证 hook 签名完整
  void locale;

  return { apps, reload: load };
}
