'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { useAuth } from '@/hooks/useAuth';
import { getMainUrl } from '@/lib/env';
import type { SidebarPanel } from '@/hooks/useSidebar';

const MAIN_URL = getMainUrl();

interface InstalledApp {
  appId: string;
  name: string;
  version: string;
  status: string;
  description?: string;
  manifest?: {
    panels?: { id: string; name: { zh?: string; en?: string }; icon?: string; description?: string }[];
  };
}

function PanelIcon({ icon, size = 28 }: { icon: string; size?: number }) {
  if (icon.startsWith('img:')) {
    const src = icon.slice(4);
    return <img src={src} alt="" width={size} height={size} className="rounded-sm object-cover" />;
  }
  if (icon.startsWith('app:')) {
    const parts = icon.slice(4).split(':');
    const appId = parts[0];
    const assetPath = parts.slice(1).join(':');
    return <img src={`/api/app-store/${appId}/asset/${assetPath}`} alt="" width={size} height={size} className="rounded-sm object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />;
  }
  return <>{icon}</>;
}

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
  panels: SidebarPanel[];
  onCustomize?: () => void;
}

export default function Sidebar({ active, onNavigate, panels, onCustomize }: SidebarProps) {
  const { t, locale } = useI18n();
  const { token } = useAuth();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [appMenuPos, setAppMenuPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const popoverRef = useRef<HTMLDivElement>(null);
  const appMenuRef = useRef<HTMLDivElement>(null);

  const handleGroupClick = useCallback((groupName: string, e: React.MouseEvent) => {
    if (openGroup === groupName) { setOpenGroup(null); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setPopoverPos({ top: rect.top, left: rect.right + 4 });
    setOpenGroup(groupName);
  }, [openGroup]);

  // Load installed apps for the apps menu
  useEffect(() => {
    if (!token) return;
    fetch(`${MAIN_URL}/api/app-store/apps`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setInstalledApps(data); })
      .catch(() => {});
  }, [token]);

  // Close popover on outside click
  useEffect(() => {
    if (!openGroup && !appMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpenGroup(null);
      }
      if (appMenuRef.current && !appMenuRef.current.contains(e.target as Node)) {
        setAppMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openGroup, appMenuOpen]);

  const visiblePanels = panels.filter(p => p.visible && p.id !== 'cfg');
  const cfgPanel = panels.find(p => p.id === 'cfg');
  const appsPanel = visiblePanels.find(p => p.id === 'apps');

  // Split into groups and ungrouped (apps is rendered separately as a launcher menu)
  const groups: { name: string; items: SidebarPanel[] }[] = [];
  const ungrouped: SidebarPanel[] = [];

  for (const p of visiblePanels) {
    if (p.id === 'apps') continue;
    // APP 面板只允许从「应用」菜单进入，不占用一级导航位（数据仍保留在 panels 中供 agentId 查找与自定义弹窗卸载）
    if (p.sourceAppId) continue;
    if (p.groupName) {
      let g = groups.find(g => g.name === p.groupName);
      if (!g) { g = { name: p.groupName, items: [] }; groups.push(g); }
      g.items.push(p);
    } else {
      ungrouped.push(p);
    }
  }

  const btnClass = (isActive: boolean) =>
    `flex flex-col items-center gap-0.5 py-2.5 rounded-lg text-[10px] transition-all w-full ${
      isActive
        ? 'bg-indigo-50 text-indigo-600 font-medium'
        : 'text-gray-700 hover:bg-gray-100 hover:text-gray-900'
    }`;

  /** Three-tier name resolution: platform i18n key → nameI18n[locale] → panel.name */
  const panelName = (p: SidebarPanel) => {
    const key = `nav.panel.${p.id}`;
    const translated = t(key);
    if (translated !== key) return translated;
    if (p.nameI18n) {
      const lang = locale.startsWith('zh') ? 'zh' : 'en';
      return p.nameI18n[lang] ?? p.nameI18n['zh'] ?? p.nameI18n['en'] ?? p.name;
    }
    return p.name;
  };

  const renderButton = (item: SidebarPanel) => (
    <button key={item.id} onClick={() => { onNavigate(item.id); setOpenGroup(null); }} className={btnClass(active === item.id)}>
      <span className="text-xl leading-none"><PanelIcon icon={item.icon} /></span>
      {panelName(item)}
    </button>
  );

  const groupHasActive = (g: { items: SidebarPanel[] }) => g.items.some(p => active === p.id);

  return (
    <div className="w-[68px] bg-white border-r border-gray-200 flex flex-col shrink-0 select-none relative z-40">
      {/* Logo → chat */}
      <div className="py-3 flex justify-center border-b border-gray-200 cursor-pointer" onClick={() => onNavigate('chat')}>
        <img src="/logo.png" alt={t('nav.brand')} className="w-9 h-9 object-contain" />
      </div>

      <nav className="flex-1 flex flex-col gap-1 p-1.5 pt-3 overflow-y-auto">
        {/* Chat — always first */}
        <button onClick={() => onNavigate('chat')} className={btnClass(active === 'chat')}>
          <span className="text-xl leading-none"><PanelIcon icon="img:/icons/chat.svg" /></span>
          {t('nav.chat')}
        </button>

        {/* Groups — rendered as a single icon button with popover */}
        {groups.map(g => (
          <div key={g.name}>
            <button
              onClick={(e) => handleGroupClick(g.name, e)}
              className={btnClass(groupHasActive(g) || openGroup === g.name)}
            >
              <span className="relative text-xl leading-none">
                <PanelIcon icon={g.items[0].icon} />
                <span className="absolute -bottom-0.5 -right-1.5 text-[7px] bg-gray-400 text-white rounded-sm px-0.5 leading-tight">
                  {g.items.length}
                </span>
              </span>
              {g.name}
            </button>
          </div>
        ))}

        {/* Group popover — fixed position, rendered outside nav flow */}
        {openGroup && (() => {
          const g = groups.find(g => g.name === openGroup);
          if (!g) return null;
          return (
            <div ref={popoverRef} className="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-1 z-50 min-w-[120px]"
              style={{ top: popoverPos.top, left: popoverPos.left }}>
              <div className="text-[10px] text-gray-400 px-3 py-1">{g.name}</div>
              {g.items.map(item => (
                <button
                  key={item.id}
                  onClick={() => { onNavigate(item.id); setOpenGroup(null); }}
                  className={`w-full text-left px-3 py-2 flex items-center gap-2 text-sm hover:bg-gray-50 ${
                    active === item.id ? 'text-indigo-600 bg-indigo-50' : 'text-gray-600'
                  }`}
                >
                  <span><PanelIcon icon={item.icon} size={16} /></span>
                  {panelName(item)}
                </button>
              ))}
            </div>
          );
        })()}

        {/* Ungrouped panels */}
        {ungrouped.map(renderButton)}

        {/* Apps launcher menu */}
        {appsPanel && (
          <div>
            <button
              onClick={(e) => {
                if (appMenuOpen) { setAppMenuOpen(false); return; }
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setAppMenuPos({ top: rect.top, left: rect.right + 4 });
                setAppMenuOpen(true);
              }}
              className={btnClass(appMenuOpen)}
            >
              <span className="text-xl leading-none"><PanelIcon icon={appsPanel.icon} /></span>
              {panelName(appsPanel)}
            </button>
          </div>
        )}

        {appMenuOpen && (
          <div ref={appMenuRef} className="fixed bg-white border border-gray-200 rounded-lg shadow-lg py-2 z-50 min-w-[180px] max-w-[260px]"
            style={{ top: appMenuPos.top, left: appMenuPos.left }}>
            <div className="text-[10px] text-gray-400 px-3 py-1">{panelName(appsPanel!)}</div>
            {installedApps.filter(a => a.status === 'active').length === 0 ? (
              <div className="px-3 py-2 text-xs text-gray-400">暂无已安装应用</div>
            ) : (
              installedApps.filter(a => a.status === 'active').flatMap(app =>
                (app.manifest?.panels ?? []).map(panel => (
                  <button
                    key={`${app.appId}-${panel.id}`}
                    onClick={() => { onNavigate(panel.id); setAppMenuOpen(false); }}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 text-sm hover:bg-gray-50 ${active === panel.id ? 'text-indigo-600 bg-indigo-50' : 'text-gray-600'}`}
                    title={app.description}
                  >
                    <span className="shrink-0"><PanelIcon icon={panel.icon || '📦'} size={18} /></span>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{panelName({ ...panel, id: panel.id, name: panel.name?.zh || panel.name?.en || panel.id, nameI18n: panel.name } as any)}</div>
                      <div className="text-[10px] text-gray-400 truncate">{app.description || app.appId}</div>
                    </div>
                  </button>
                ))
              )
            )}
          </div>
        )}

        <div className="flex-1" />

        {/* Settings — always at bottom */}
        {cfgPanel && renderButton(cfgPanel)}

        {/* Customize button */}
        {onCustomize && (
          <button onClick={onCustomize} className="flex flex-col items-center gap-0.5 py-2 rounded-lg text-[10px] text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-all" title={t('nav.customizeSidebar')}>
            <span className="text-sm leading-none">⋯</span>
          </button>
        )}
      </nav>
    </div>
  );
}
