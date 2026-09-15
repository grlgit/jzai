'use client';

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n';
import { useMessageDisplay } from '@/hooks/useMessageDisplay';
import dynamic from 'next/dynamic';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

// Tool catalog is fetched dynamically from backend
interface ToolCatalogItem { id: string; label: string; group: string; }

// These will be populated with t() calls inside the component
const MODEL_LEVEL_KEYS = [
  { id: 'default', key: 'agents.levelDefault' },
  { id: 'coding', key: 'agents.levelCoding' },
  { id: 'reasoning', key: 'agents.levelReasoning' },
  { id: 'summary', key: 'agents.levelSummary' },
];

const PANEL_OPTION_KEYS = [
  { id: '', key: 'agents.panelNone' },
  { id: 'kb', key: 'agents.panelKb' },
  { id: 'skills', key: 'agents.panelSkills' },
  { id: 'connectors', key: 'agents.panelConnectors' },
  { id: 'dash', key: 'agents.panelDash' },
  { id: 'agents', key: 'agents.panelAgents' },
  { id: 'apps', key: 'agents.panelApps' },
  { id: 'users', key: 'agents.panelUsers' },
  { id: 'cfg', key: 'agents.panelCfg' },
  { id: 'dimensionTuner', key: 'agents.panelDimensionTuner' },
];

interface AgentDef {
  id: string; name: string; icon: string; description: string;
  modelLevel: string; builtin: boolean; soul: string; tools: string[];
  defaultPanel?: string;
  messageDisplay?: { toolProcess?: boolean; toolResult?: boolean; sourceRef?: boolean };
  resolvedTools?: string[];
  sourceApp?: { appId: string; name: string } | null;
}

export default function AgentManagerPanel() {
  const { t } = useI18n();
  const { global: msgGlobal, reload: reloadMsgDisplay } = useMessageDisplay();
  const [agents, setAgents] = useState<AgentDef[]>([]);
  const [availableTools, setAvailableTools] = useState<ToolCatalogItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<AgentDef | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [tab, setTab] = useState<'config' | 'tools' | 'soul'>('config');
  const [msg, setMsg] = useState('');

  const loadAgents = useCallback(async () => {
    const list = await fetch(`${MAIN_URL}/api/agents`).then(r => r.json()).catch(() => []);
    if (Array.isArray(list)) setAgents(list);
  }, []);

  const loadTools = useCallback(async () => {
    const tools = await fetch(`${MAIN_URL}/api/agents/available-tools`).then(r => r.json()).catch(() => []);
    if (Array.isArray(tools)) setAvailableTools(tools);
  }, []);

  const load = useCallback(async () => {
    await Promise.all([loadAgents(), loadTools()]);
  }, [loadAgents, loadTools]);

  useEffect(() => { load(); }, [load]);

  const selectAgent = async (id: string) => {
    const data = await fetch(`${MAIN_URL}/api/agents/${id}`, { headers: authHeaders() }).then(r => r.json());
    setSelected(id);
    setForm(data);
    setIsNew(false);
    setTab('config');
  };

  const startNew = () => {
    setSelected(null);
    setIsNew(true);
    setForm({
      id: '', name: '', icon: '🤖', description: '',
      modelLevel: 'default', builtin: false, soul: '', tools: [], defaultPanel: '',
    });
    setTab('config');
  };

  const handleSave = async () => {
    if (!form || !form.id || !form.name) { setMsg(t('agents.idNameRequired')); return; }
    const method = isNew ? 'POST' : 'PUT';
    const url = isNew ? `${MAIN_URL}/api/agents` : `${MAIN_URL}/api/agents/${form.id}`;
    const resp = await fetch(url, {
      method, headers: authHeaders(),
      body: JSON.stringify(form),
    }).then(r => r.json());
    if (resp.success) { setMsg(t('common.saved')); setIsNew(false); load(); reloadMsgDisplay(); }
    else setMsg(resp.error || t('common.saveFailed'));
  };

  const handleDelete = async (id: string) => {
    await fetch(`${MAIN_URL}/api/agents/${id}`, { method: 'DELETE', headers: authHeaders() });
    setSelected(null); setForm(null); load(); setMsg(t('agents.deleted'));
  };

  const resolveTools = useCallback(async (tools: string[]) => {
    try {
      const resp = await fetch(`${MAIN_URL}/api/agents/resolve-tools`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ tools }),
      }).then(r => r.json());
      return resp.resolvedTools || [];
    } catch { return []; }
  }, []);

  const toggleTool = async (toolId: string) => {
    if (!form) return;
    const tools = form.tools.includes(toolId) ? form.tools.filter(t => t !== toolId) : [...form.tools, toolId];
    const resolved = await resolveTools(tools);
    setForm({ ...form, tools, resolvedTools: resolved });
  };

  return (
    <div className="flex h-full">
      {/* Left: agent list */}
      <div className="w-60 border-r border-gray-200 flex flex-col shrink-0">
        <div className="p-3 border-b border-gray-200 flex items-center gap-2">
          <span className="text-sm font-medium flex-1">{t('agents.title')}</span>
          <button onClick={startNew} className="text-xs px-2 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700">{t('agents.new')}</button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {agents.map(a => (
            <button key={a.id} onClick={() => selectAgent(a.id)}
              className={`w-full text-left px-3 py-3 border-b border-gray-100 hover:bg-gray-50 ${selected === a.id ? 'bg-indigo-50 border-l-2 border-l-indigo-500' : ''}`}>
              <div className="flex items-center gap-2">
                <span className="text-lg">{a.icon}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1">
                    <span className="text-sm font-medium text-gray-800 truncate">{a.name}</span>
                    {a.sourceApp && (
                      <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-indigo-50 text-indigo-600 truncate max-w-[72px] shrink-0" title={a.sourceApp.name}>
                        {a.sourceApp.name}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-gray-400">{a.description?.substring(0, 30)}</div>
                </div>
              </div>
              {a.builtin && <span className="text-[10px] text-gray-400 ml-7">{t('common.builtin')}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Right */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {form ? (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 shrink-0">
              <span className="text-lg">{form.icon}</span>
              <h3 className="text-base font-semibold">{form.name || t('agents.newAgent')}</h3>
              {form.builtin && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-400">{t('common.builtin')}</span>}
              <div className="flex-1" />
              <button onClick={handleSave} className="text-xs px-3 py-1 bg-indigo-600 text-white rounded hover:bg-indigo-700">{t('common.save')}</button>
              {!form.builtin && selected && (
                <button onClick={() => handleDelete(form.id)} className="text-xs px-3 py-1 border border-red-200 text-red-500 rounded hover:bg-red-50">{t('common.delete')}</button>
              )}
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 shrink-0">
              <button onClick={() => setTab('config')}
                className={`px-5 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'config' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                {t('agents.basicConfig')}
              </button>
              <button onClick={() => { setTab('tools'); loadTools(); }}
                className={`px-5 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'tools' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                {t('agents.tools')} ({form.tools.length})
              </button>
              <button onClick={() => setTab('soul')}
                className={`px-5 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'soul' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                {t('agents.soulPrompt')}
              </button>
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-hidden">
              {tab === 'config' ? (
                <div className="h-full overflow-y-auto p-5 space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('agents.id')}</label>
                      <input value={form.id} onChange={e => setForm({ ...form, id: e.target.value })}
                        disabled={!isNew} className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm disabled:bg-gray-50" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('agents.name')}</label>
                      <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
                        className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm" />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('agents.icon')}</label>
                      <input value={form.icon} onChange={e => setForm({ ...form, icon: e.target.value })}
                        className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t('agents.desc')}</label>
                    <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                      className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t('agents.modelLevel')}</label>
                    <select value={form.modelLevel} onChange={e => setForm({ ...form, modelLevel: e.target.value })}
                      className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm">
                      {MODEL_LEVEL_KEYS.map(l => <option key={l.id} value={l.id}>{t(l.key)}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t('agents.defaultPanel')}</label>
                    <select value={form.defaultPanel || ''} onChange={e => setForm({ ...form, defaultPanel: e.target.value || undefined })}
                      className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm">
                      {PANEL_OPTION_KEYS.map(p => <option key={p.id} value={p.id}>{t(p.key)}</option>)}
                    </select>
                    <p className="text-[10px] text-gray-400 mt-0.5">{t('agents.defaultPanelHint')}</p>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-2">{t('msgDisplay.title')}</label>
                    <p className="text-[10px] text-gray-400 mb-2">{t('msgDisplay.agentHint')}</p>
                    <div className="space-y-1">
                      {(['toolProcess', 'toolResult', 'sourceRef'] as const).map(key => {
                        const globalOff = !(msgGlobal[key] ?? true);
                        const checked = form.messageDisplay?.[key] ?? true;
                        return (
                          <label key={key} className={`flex items-center gap-2 text-sm px-2 py-1 rounded hover:bg-gray-50 ${globalOff ? 'opacity-40' : 'cursor-pointer'}`}>
                            <input type="checkbox" checked={checked && !globalOff} disabled={globalOff}
                              onChange={() => setForm({ ...form, messageDisplay: { ...form.messageDisplay, [key]: !checked } })}
                              className="rounded border-gray-300 text-indigo-600" />
                            <span>{t(`msgDisplay.${key}`)}</span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : tab === 'tools' ? (
                <div className="h-full overflow-y-auto p-5 space-y-4">
                  {/* Tool authorization checkboxes */}
                  {(() => {
                    const groups = new Map<string, ToolCatalogItem[]>();
                    for (const t of availableTools) {
                      if (!groups.has(t.group)) groups.set(t.group, []);
                      groups.get(t.group)!.push(t);
                    }
                    return Array.from(groups.entries()).map(([group, items]) => (
                      <div key={group}>
                        <div className="text-[11px] text-gray-400 font-medium mb-1.5 px-1">{group}</div>
                        <div className="grid grid-cols-3 gap-1">
                          {items.map(t => (
                            <label key={t.id} className="flex items-center gap-1.5 text-sm cursor-pointer hover:bg-gray-50 rounded px-2 py-1">
                              <input type="checkbox" checked={form.tools.includes(t.id)} onChange={() => toggleTool(t.id)}
                                className="rounded border-gray-300 text-indigo-600" />
                              <span className="truncate" title={t.label}>{t.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    ));
                  })()}

                  {/* Resolved runtime tools */}
                  {form.resolvedTools && form.resolvedTools.length > 0 && (
                    <div className="border border-gray-100 rounded-lg p-3 bg-gray-50/50">
                      <div className="text-[11px] text-gray-400 font-medium mb-1.5">运行时实际工具 ({form.resolvedTools.length})</div>
                      <div className="flex flex-wrap gap-1">
                        {form.resolvedTools.map((name: string) => (
                          <span key={name} className="px-1.5 py-0.5 text-[10px] bg-white border border-gray-200 rounded text-gray-600 font-mono">{name}</span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="h-full">
                  <MonacoEditor
                    height="100%"
                    language="markdown"
                    theme="vs-light"
                    value={form.soul}
                    onChange={val => setForm({ ...form, soul: val || '' })}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      lineNumbers: 'off',
                      wordWrap: 'on',
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                    }}
                  />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <div className="text-4xl mb-2">🤖</div>
              <div className="text-sm">{t('agents.selectHint')}</div>
              <div className="text-xs mt-1">{t('agents.createHint')}</div>
            </div>
          </div>
        )}

        {msg && (
          <div className="fixed bottom-4 right-4 bg-gray-800 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
            {msg}
            <button onClick={() => setMsg('')} className="ml-3 text-gray-300 hover:text-white">✕</button>
          </div>
        )}
      </div>
    </div>
  );
}
