'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n';
import type { SidebarPanel } from '@/hooks/useSidebar';

interface Props {
  panels: SidebarPanel[];
  onSave: (panels: SidebarPanel[]) => void;
  onReset: () => void;
  onClose: () => void;
  isAdmin?: boolean;
}

type Category = 'system' | 'builtin' | 'third_party';

const CAPS: Record<Category, { rename: boolean; reicon: boolean; regroup: boolean; reorder: boolean; hide: boolean; uninstall: boolean }> = {
  system:      { rename: false, reicon: false, regroup: false, reorder: false, hide: false, uninstall: false },
  builtin:     { rename: true,  reicon: true,  regroup: true,  reorder: true,  hide: true,  uninstall: false },
  third_party: { rename: true,  reicon: true,  regroup: true,  reorder: true,  hide: true,  uninstall: true  },
};

function getCaps(p: SidebarPanel) {
  const cat = (p.category as Category) ?? (p.isBuiltin ? 'system' : 'builtin');
  return CAPS[cat] ?? CAPS['builtin'];
}

export default function SidebarCustomizeModal({ panels, onSave, onReset, onClose, isAdmin }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<SidebarPanel[]>(() =>
    panels.map((p, i) => ({ ...p, sortOrder: i }))
  );
  const [uninstallTarget, setUninstallTarget] = useState<SidebarPanel | null>(null);

  const update = (id: string, patch: Partial<SidebarPanel>) => {
    setItems(prev => prev.map(p => p.id === id ? { ...p, ...patch } : p));
  };

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const caps = getCaps(items[target]);
    if (!caps.reorder) return;
    const next = [...items];
    [next[idx], next[target]] = [next[target], next[idx]];
    setItems(next.map((p, i) => ({ ...p, sortOrder: i })));
  };

  /** Resolve panel display name from i18n */
  const panelName = (p: SidebarPanel) => {
    const key = `nav.panel.${p.id}`;
    const translated = t(key);
    return translated !== key ? translated : p.name;
  };

  const handleSave = () => {
    onSave(items);
    onClose();
  };

  const handleReset = () => {
    onReset();
    onClose();
  };

  const confirmUninstall = async () => {
    if (!uninstallTarget?.sourceAppId) return;
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
      await fetch(`/api/app-store/apps/${uninstallTarget.sourceAppId}`, {
        method: 'DELETE',
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      setItems(prev => prev.filter(p => p.sourceAppId !== uninstallTarget.sourceAppId));
    } catch {}
    setUninstallTarget(null);
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-[400px] max-h-[80vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center">
          <h3 className="text-sm font-semibold flex-1">{t('sidebar.customize')}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          {items.map((p, idx) => {
            const caps = getCaps(p);
            const locked = !caps.rename && !caps.reicon && !caps.regroup && !caps.reorder && !caps.hide;
            return (
              <div key={p.id} className={`flex items-center gap-2 px-2 py-2 rounded-lg border bg-gray-50/50 ${locked ? 'border-gray-200 opacity-60' : 'border-gray-100'}`}>
                {p.icon?.startsWith('img:') ? (
                  <img src={p.icon.slice(4)} alt="" width={28} height={28} className="w-7 h-7 shrink-0 rounded-sm object-cover" />
                ) : (
                  <input
                    value={p.icon}
                    onChange={e => caps.reicon && update(p.id, { icon: e.target.value })}
                    disabled={!caps.reicon}
                    className={`w-8 text-center text-lg shrink-0 px-0 py-0.5 border rounded outline-none ${!caps.reicon ? 'bg-gray-100 border-gray-200 cursor-not-allowed' : 'border-gray-200 focus:border-indigo-400'}`}
                    title={t('sidebar.iconTooltip')}
                  />
                )}

                <span className="text-sm flex-1 truncate text-gray-700">{panelName(p)}</span>

                <input
                  value={p.groupName}
                  onChange={e => caps.regroup && update(p.id, { groupName: e.target.value })}
                  disabled={!caps.regroup}
                  placeholder={t('sidebar.group')}
                  className={`w-14 text-[11px] px-1.5 py-0.5 border border-gray-200 rounded text-center ${!caps.regroup ? 'bg-gray-100 text-gray-300 cursor-not-allowed' : ''}`}
                />

                <div className="flex flex-col gap-0">
                  <button
                    onClick={() => caps.reorder && move(idx, -1)}
                    disabled={!caps.reorder || idx === 0 || !getCaps(items[idx - 1]).reorder}
                    className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-20 leading-none"
                  >▲</button>
                  <button
                    onClick={() => caps.reorder && move(idx, 1)}
                    disabled={!caps.reorder || idx === items.length - 1 || !getCaps(items[idx + 1]).reorder}
                    className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-20 leading-none"
                  >▼</button>
                </div>

                <button
                  onClick={() => caps.hide && update(p.id, { visible: !p.visible })}
                  disabled={!caps.hide}
                  className={`text-xs px-1.5 py-0.5 rounded ${
                    p.visible ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-400'
                  } ${!caps.hide ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:opacity-80'}`}
                >
                  {p.visible ? t('sidebar.show') : t('sidebar.hide')}
                </button>

                {caps.uninstall && isAdmin && (
                  <button
                    onClick={() => setUninstallTarget(p)}
                    className="text-xs px-1.5 py-0.5 rounded bg-red-50 text-red-500 hover:bg-red-100"
                    title="卸载应用"
                  >卸载</button>
                )}
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex gap-2 justify-between">
          <button onClick={handleReset} className="text-xs text-gray-400 hover:text-gray-600">{t('common.reset')}</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 text-xs border border-gray-200 rounded-lg">{t('common.cancel')}</button>
            <button onClick={handleSave} className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">{t('common.save')}</button>
          </div>
        </div>
      </div>

      {uninstallTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-60">
          <div className="bg-white rounded-xl shadow-xl p-6 w-80">
            <h4 className="text-sm font-semibold mb-2">确认卸载</h4>
            <p className="text-sm text-gray-600 mb-4">卸载 <strong>{panelName(uninstallTarget)}</strong>？此操作将移除该应用的所有面板和数据。</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setUninstallTarget(null)} className="px-4 py-1.5 text-xs border border-gray-200 rounded-lg">取消</button>
              <button onClick={confirmUninstall} className="px-4 py-1.5 text-xs bg-red-600 text-white rounded-lg hover:bg-red-700">确认卸载</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
