'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n';
import type { Shortcut } from '@/hooks/useShortcuts';
import type { SidebarPanel } from '@/hooks/useSidebar';

interface Props {
  shortcuts: Shortcut[];
  panels: SidebarPanel[];  // available panels for "add panel" dropdown
  onSave: (items: Shortcut[]) => void;
  onReset: () => void;
  onClose: () => void;
}

export default function ShortcutCustomizeModal({ shortcuts, panels, onSave, onReset, onClose }: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<Shortcut[]>(() =>
    shortcuts.map((s, i) => ({ ...s, sortOrder: i }))
  );
  const [addType, setAddType] = useState<'panel' | 'url' | null>(null);
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('🔗');
  const [newTarget, setNewTarget] = useState('');

  const remove = (id: string) => setItems(prev => prev.filter(s => s.id !== id));

  const move = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[idx], next[target]] = [next[target], next[idx]];
    setItems(next.map((s, i) => ({ ...s, sortOrder: i })));
  };

  const addPanel = (panelId: string) => {
    const panel = panels.find(p => p.id === panelId);
    if (!panel || items.some(s => s.id === panelId)) return;
    setItems(prev => [...prev, { id: panelId, name: panel.name, icon: panel.icon, type: 'panel', target: panelId, sortOrder: prev.length }]);
    setAddType(null);
  };

  const addUrl = () => {
    if (!newName || !newTarget) return;
    const id = `url_${Date.now()}`;
    setItems(prev => [...prev, { id, name: newName, icon: newIcon, type: 'url', target: newTarget, sortOrder: prev.length }]);
    setNewName(''); setNewIcon('🔗'); setNewTarget('');
    setAddType(null);
  };

  const handleSave = () => { onSave(items); onClose(); };
  const handleReset = () => { onReset(); onClose(); };

  // Panels not yet added
  const availablePanels = panels.filter(p => !p.isBuiltin && !items.some(s => s.id === p.id));

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-xl w-[420px] max-h-[80vh] flex flex-col">
        <div className="px-5 py-3 border-b border-gray-200 flex items-center">
          <h3 className="text-sm font-semibold flex-1">{t('shortcut.title')}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-1">
          {items.map((s, idx) => (
            <div key={s.id} className="flex items-center gap-2 px-2 py-2 rounded-lg border border-gray-100 bg-gray-50/50">
              <span className="text-lg w-7 text-center shrink-0">{s.icon?.startsWith('img:') ? <img src={s.icon.slice(4)} alt="" width={24} height={24} className="inline rounded-sm object-cover" /> : s.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="text-sm truncate">{s.name}</div>
                <div className="text-[10px] text-gray-400 truncate">
                  {s.type === 'panel' ? t('shortcut.panel', { target: s.target }) : s.target}
                </div>
              </div>
              <span className={`text-[9px] px-1.5 py-0.5 rounded ${s.type === 'panel' ? 'bg-indigo-50 text-indigo-500' : 'bg-green-50 text-green-600'}`}>
                {s.type === 'panel' ? t('shortcut.internal') : t('shortcut.external')}
              </span>
              <div className="flex flex-col gap-0">
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-20 leading-none">▲</button>
                <button onClick={() => move(idx, 1)} disabled={idx === items.length - 1} className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-20 leading-none">▼</button>
              </div>
              <button onClick={() => remove(s.id)} className="text-xs text-red-400 hover:text-red-600">✕</button>
            </div>
          ))}

          {items.length === 0 && (
            <div className="text-center text-gray-400 text-sm py-4">{t('shortcut.empty')}</div>
          )}
        </div>

        {/* Add section */}
        <div className="px-4 pb-3">
          {!addType ? (
            <div className="flex gap-2">
              <button onClick={() => setAddType('panel')} disabled={availablePanels.length === 0}
                className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-40">{t('shortcut.addPanel')}</button>
              <button onClick={() => setAddType('url')}
                className="flex-1 px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50">{t('shortcut.addLink')}</button>
            </div>
          ) : addType === 'panel' ? (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="text-xs text-gray-500">{t('shortcut.selectPanel')}</div>
              <div className="flex flex-wrap gap-1">
                {availablePanels.map(p => (
                  <button key={p.id} onClick={() => addPanel(p.id)}
                    className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-200 rounded hover:bg-indigo-50 hover:border-indigo-300">
                    <span>{p.icon?.startsWith('img:') ? <img src={p.icon.slice(4)} alt="" width={16} height={16} className="inline rounded-sm object-cover" /> : p.icon}</span> {p.name}
                  </button>
                ))}
              </div>
              <button onClick={() => setAddType(null)} className="text-xs text-gray-400 hover:text-gray-600">{t('common.cancel')}</button>
            </div>
          ) : (
            <div className="border border-gray-200 rounded-lg p-3 space-y-2">
              <div className="text-xs text-gray-500">{t('shortcut.addExternal')}</div>
              <div className="flex gap-2">
                <input value={newIcon} onChange={e => setNewIcon(e.target.value)} className="w-10 text-center border border-gray-200 rounded px-1 py-1 text-sm" placeholder="🔗" />
                <input value={newName} onChange={e => setNewName(e.target.value)} className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm" placeholder={t('common.name')} />
              </div>
              <input value={newTarget} onChange={e => setNewTarget(e.target.value)} className="w-full border border-gray-200 rounded px-2 py-1 text-sm" placeholder={t('shortcut.urlPlaceholder')} />
              <div className="flex gap-2">
                <button onClick={() => setAddType(null)} className="text-xs text-gray-400 hover:text-gray-600">{t('common.cancel')}</button>
                <button onClick={addUrl} disabled={!newName || !newTarget} className="text-xs px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">{t('shortcut.add')}</button>
              </div>
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-gray-200 flex gap-2 justify-between">
          <button onClick={handleReset} className="text-xs text-gray-400 hover:text-gray-600">{t('common.reset')}</button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-1.5 text-xs border border-gray-200 rounded-lg">{t('common.cancel')}</button>
            <button onClick={handleSave} className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">{t('common.save')}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
