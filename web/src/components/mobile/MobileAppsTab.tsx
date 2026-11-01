'use client';

/**
 * P4 移动端"应用"TAB。
 * 数据：useAppEntries()（APP 清单入口）× sidebarPanels（P1 可见性过滤结果）——
 * 仅列出 mobile.supported===true 且用户可见的 APP 面板；entryComponent 取
 * mobile.entryComponent ?? PC entryComponent（T4.1 激活链写入）。
 * 挂载复用 DynamicPanelLoader（动态 ESM 与视口无关）；TAB 切换不卸载（keepAlive 语义）。
 */
import { useState, useEffect } from 'react';
import { useI18n } from '@/i18n';
import { useAppEntries, appEntryPanelTitle, appDisplayName, type AppEntry } from '@/hooks/useAppEntries';
import { DynamicPanelLoader, type PanelAgentMessage } from '@/components/DynamicPanelLoader';

interface SidebarPanelLike {
  id: string;
  name: string;
  sourceAppId?: string | null;
  entryComponent?: string | null;
  agentId?: string | null;
  appVersion?: string | null;
  mobile?: { supported: boolean; entryComponent?: string; layout?: 'full' | 'sheet' } | null;
}

interface Props {
  /** 后端 /api/sidebar 返回（P1 已按 grants/visibility 过滤） */
  panels: SidebarPanelLike[];
  /** 面板经 sdk.agent.send() 发出的消息，路由到绑定 Agent 会话（与 PC 同链路） */
  onPanelAgentMessage?: (panel: { id: string; sourceAppId?: string | null; agentId?: string | null }, msg: PanelAgentMessage) => void | Promise<void>;
}

interface OpenTarget {
  app: AppEntry;
  panel: SidebarPanelLike;
  title: string;
}

/** 与 Sidebar PanelIcon 同逻辑的迷你实现（img:/app:/emoji 三分支） */
function PanelIcon({ icon, size = 18 }: { icon?: string; size?: number }) {
  if (!icon) return <span>📦</span>;
  if (icon.startsWith('img:')) {
    return <img src={icon.slice(4)} alt="" width={size} height={size} className="rounded-sm object-cover" />;
  }
  if (icon.startsWith('app:')) {
    const parts = icon.slice(4).split(':');
    const appId = parts[0];
    const assetPath = parts.slice(1).join(':');
    return <img src={`/api/app-store/${appId}/asset/${assetPath}`} alt="" width={size} height={size}
      className="rounded-sm object-cover" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />;
  }
  return <span>{icon}</span>;
}

export default function MobileAppsTab({ panels, onPanelAgentMessage }: Props) {
  const { locale } = useI18n();
  const { apps } = useAppEntries();
  const [open, setOpen] = useState<OpenTarget | null>(null);

  // P4：agent ui_control navigate（page.tsx 路由）→ 自动打开对应移动面板
  useEffect(() => {
    const handler = (e: Event) => {
      const { panelId } = (e as CustomEvent).detail ?? {};
      if (!panelId) return;
      for (const app of apps) {
        const spec = app.entryPanels.find(p => p.id === panelId);
        const sidebar = panels.find(sp => sp.id === panelId);
        if (spec && sidebar?.mobile?.supported) {
          setOpen({ app, panel: sidebar, title: appEntryPanelTitle(spec, locale) });
          return;
        }
      }
    };
    window.addEventListener('jianzhi:mobile-open-panel', handler);
    return () => window.removeEventListener('jianzhi:mobile-open-panel', handler);
  }, [apps, panels, locale]);

  // APP × sidebar 可见面板交集，过滤 mobile.supported
  const groups = apps
    .map(app => ({
      app,
      entries: app.entryPanels
        .map(p => ({ spec: p, sidebar: panels.find(sp => sp.id === p.id) }))
        .filter(x => x.sidebar?.mobile?.supported === true && x.sidebar.sourceAppId),
    }))
    .filter(g => g.entries.length > 0);

  return (
    <div className="flex flex-col h-full bg-gray-50">
      {open ? (
        <div className="flex flex-col h-full bg-white">
          <div className="flex items-center gap-2 px-3 h-11 border-b border-gray-200 shrink-0">
            <button onClick={() => setOpen(null)}
              className="text-gray-500 active:bg-gray-100 rounded p-2 -ml-2 text-base">←</button>
            <span className="text-sm font-medium truncate">{open.title}</span>
          </div>
          <div className="flex-1 min-h-0">
            <DynamicPanelLoader
              panel={{
                id: open.panel.id,
                name: open.title,
                sourceAppId: open.panel.sourceAppId!,
                entryComponent: open.panel.mobile?.entryComponent ?? open.panel.entryComponent!,
                version: open.panel.appVersion ?? '0',
              }}
              onAgentMessage={msg => onPanelAgentMessage?.(
                { id: open.panel.id, sourceAppId: open.panel.sourceAppId, agentId: open.panel.agentId },
                msg,
              )}
            />
          </div>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-3 pb-[env(safe-area-inset-bottom)]">
          {groups.length === 0 ? (
            <div className="text-center text-gray-400 py-16">
              <div className="text-3xl mb-2">📦</div>
              <div className="text-xs">暂无支持移动端的应用功能</div>
              <div className="text-[10px] mt-1">（应用需在 manifest 中显式声明 mobile.supported）</div>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map(({ app, entries }) => (
                <div key={app.appId} className="bg-white border border-gray-200 rounded-lg p-3">
                  <div className="flex items-baseline gap-1.5 mb-2">
                    <span className="text-xs font-semibold text-gray-800 truncate">{appDisplayName(app.name, app.appId)}</span>
                    {app.version && <span className="text-[10px] text-gray-400 shrink-0">v{app.version}</span>}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {entries.map(({ spec, sidebar }) => (
                      <button
                        key={sidebar!.id}
                        onClick={() => setOpen({ app, panel: sidebar!, title: appEntryPanelTitle(spec, locale) })}
                        className="flex items-center gap-2 px-3 py-2.5 rounded-md border border-gray-200 text-sm text-gray-700 active:bg-gray-100 text-left"
                      >
                        <span><PanelIcon icon={spec.icon} /></span>
                        <span className="truncate">{appEntryPanelTitle(spec, locale)}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
