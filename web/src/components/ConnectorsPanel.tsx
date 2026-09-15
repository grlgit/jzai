'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useI18n } from '@/i18n';
import { useAuth } from '@/hooks/useAuth';
import CredentialForm from './CredentialForm';
import dynamic from 'next/dynamic';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

import { getMainUrl } from '@/lib/env';
import { confirmDialog, alertError } from '@/components/AppDialog';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface ConnectorsPanelProps {
  onOpenSession?: (name: string, sessionId: string, agentType: string) => void;
}

export default function ConnectorsPanel({ onOpenSession }: ConnectorsPanelProps) {
  const { t } = useI18n();
  const { user } = useAuth();
  const userId = user?.id || '';
  const [tools, setTools] = useState<any[]>([]);
  const [mcps, setMcps] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [sideWidth, setSideWidth] = useState(288);
  const draggingRef = useRef(false);
  const [selected, setSelected] = useState<{ type: 'tool' | 'mcp'; name: string } | null>(null);
  const [manifest, setManifest] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [detailTab, setDetailTab] = useState<'config' | 'code' | 'credentials' | 'llmHint' | 'schema'>('config');
  const [handlerCode, setHandlerCode] = useState('');
  const [handlerDraft, setHandlerDraft] = useState('');
  const [handlerSaving, setHandlerSaving] = useState(false);
  const [llmHintDraft, setLlmHintDraft] = useState('');
  const [llmHintSaving, setLlmHintSaving] = useState(false);
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [t, m] = await Promise.all([
      fetch(`${MAIN_URL}/api/tools`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${MAIN_URL}/api/mcp`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
    ]);
    setTools((Array.isArray(t) ? t : []).filter((c: any) => !c.sourceApp));
    setMcps(Array.isArray(m) ? m : []);
    setLoading(false);
  }, []);

  const loadCredentials = useCallback(async () => {
    if (!userId) return;
    const data = await fetch(`${MAIN_URL}/api/skills/credentials/list?userId=${userId}`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({}));
    if (data && !data.error) setCredentials(data);
  }, [userId]);

  const [globalCredentials, setGlobalCredentials] = useState<Record<string, Record<string, string>>>({});

  const loadGlobalCredentials = useCallback(async () => {
    const data = await fetch(`${MAIN_URL}/api/skills/credentials/global/list`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({}));
    if (data && !data.error) setGlobalCredentials(data);
  }, []);

  useEffect(() => { load(); loadCredentials(); loadGlobalCredentials(); }, [load, loadCredentials, loadGlobalCredentials]);

  const selectItem = async (type: 'tool' | 'mcp', name: string) => {
    setSelected({ type, name });
    setEditing(false);
    const apiBase = type === 'mcp' ? `${MAIN_URL}/api/mcp/${name}` : `${MAIN_URL}/api/tools/${name}`;
    const [manifestResp, handlerResp] = await Promise.all([
      fetch(`${apiBase}/manifest`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({})),
      fetch(`${apiBase}/handler`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({})),
    ]);
    setManifest(manifestResp.manifest || '');
    setEditDraft(manifestResp.manifest || '');
    setHandlerCode(handlerResp.handler || '');
    setHandlerDraft(handlerResp.handler || '');
  };

  const toggleTool = async (name: string, enabled: boolean) => {
    await fetch(`${MAIN_URL}/api/tools/${name}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ enabled }) });
    setTools(prev => prev.map(c => c.name === name ? { ...c, enabled } : c));
  };

  const toggleMcp = async (name: string, enabled: boolean) => {
    await fetch(`${MAIN_URL}/api/mcp/${name}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ enabled }) });
    setMcps(prev => prev.map(c => c.name === name ? { ...c, enabled } : c));
  };

  const chatWithAgent = async (type: string, name: string) => {
    if (!onOpenSession) return;
    // Try to resume the existing session that created this connector
    try {
      const resp = await fetch(`${MAIN_URL}/api/sessions/by-skill/${name}`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({ session: null }));
      if (resp.session) { onOpenSession(name, resp.session.id, resp.session.agentType); return; }
    } catch {}
    onOpenSession(name, '', 'connector_master');
  };

  const createNew = () => {
    if (!onOpenSession) return;
    onOpenSession('', '', 'connector_master');
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
        detail: { content: '我想创建一个新的系统连接，请引导我完成。' },
      }));
    }, 600);
  };

  const connectDatabase = () => {
    if (!onOpenSession) return;
    onOpenSession('', '', 'connector_master');
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
        detail: { content: '我想连接一个数据库，请引导我完成。' },
      }));
    }, 600);
  };

  const deleteMcp = async (name: string) => {
    if (!(await confirmDialog(`确认删除 MCP "${name}"？文件将移入回收站。`, { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/mcp/${name}`, { method: 'DELETE', headers: authHeaders() });
    if (selected?.name === name) { setSelected(null); setManifest(''); }
    load();
  };

  const deleteTool = async (name: string) => {
    if (!(await confirmDialog(`确认删除工具 "${name}"？文件将移入回收站。`, { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/tools/${name}`, { method: 'DELETE', headers: authHeaders() });
    if (selected?.name === name) { setSelected(null); setManifest(''); }
    load();
  };

  const saveManifest = async () => {
    if (!selected || selected.type !== 'mcp') return;
    await fetch(`${MAIN_URL}/api/mcp/register`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ manifest: editDraft }),
    });
    setManifest(editDraft);
    setEditing(false);
    load();
  };

  const isEmpty = tools.length === 0 && mcps.length === 0;

  const selectedDetail = selected
    ? (selected.type === 'mcp' ? mcps.find(m => m.name === selected.name) : tools.find(t => t.name === selected.name))
    : null;

  return (
    <div className="flex h-full min-h-0">
      {/* Left: grid list */}
      <div className="flex flex-col shrink-0 min-h-0" style={{ width: sideWidth }}>
        <div className="p-3 border-b border-gray-200 overflow-x-auto">
          <div className="flex items-center gap-1.5 min-w-max">
            <span className="text-sm font-medium shrink-0">{t('connectors.title')}</span>
            <div className="flex-1" />
            <button onClick={connectDatabase} className="px-2 py-1 text-[11px] border border-purple-300 text-purple-600 rounded hover:bg-purple-50 shrink-0 whitespace-nowrap">
              + 数据库
            </button>
            <button onClick={createNew} className="px-2 py-1 text-[11px] bg-indigo-600 text-white rounded hover:bg-indigo-700 shrink-0 whitespace-nowrap">
              {t('connectors.new')}
            </button>
            <button onClick={async () => {
              await Promise.all([
                fetch(`${MAIN_URL}/api/mcp/reload`, { method: 'POST', headers: authHeaders() }),
                fetch(`${MAIN_URL}/api/tools/reload`, { method: 'POST', headers: authHeaders() }),
              ]);
              load();
            }} disabled={loading} className="px-2 py-1 text-[11px] border border-gray-200 rounded hover:bg-gray-50 disabled:opacity-50 shrink-0 whitespace-nowrap">
              ⟳ 重载
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-3">
          {isEmpty && !loading && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <div className="text-3xl mb-2">🔗</div>
              <div className="text-xs mb-1">{t('connectors.empty')}</div>
              <button onClick={createNew} className="mt-2 px-3 py-1.5 text-xs bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">
                {t('connectors.startCreate')}
              </button>
            </div>
          )}

          {/* MCP grid */}
          {mcps.length > 0 && (
            <div className="mb-4">
              <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-2">MCP</div>
              <div className="flex flex-wrap gap-2">
                {mcps.map(c => (
                  <button key={c.name} onClick={() => selectItem('mcp', c.name)}
                    className={`text-left p-3 rounded-lg border transition-all hover:shadow-sm w-[130px] shrink-0 ${
                      selected?.type === 'mcp' && selected.name === c.name
                        ? 'border-indigo-400 bg-indigo-50 shadow-sm'
                        : c.enabled !== false ? 'border-gray-200 bg-white hover:border-indigo-200' : 'border-gray-100 bg-gray-50 opacity-60'
                    }`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      {c.name.startsWith('db-') ? (
                        <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-purple-50 text-purple-600">DB</span>
                      ) : (
                        <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-emerald-50 text-emerald-600">MCP</span>
                      )}
                      <McpPhase phase={c.status?.phase} />
                    </div>
                    <div className="text-xs font-medium text-gray-800 truncate">{c.name}</div>
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      {(c.tools || []).map((t: any) => typeof t === 'string' ? t : t.name).join(', ') || `${c.toolCount || 0} tools`}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Tools grid */}
          {tools.length > 0 && (
            <div>
              <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mb-2">TOOLS</div>
              <div className="flex flex-wrap gap-2">
                {tools.map(c => (
                  <button key={c.name} onClick={() => selectItem('tool', c.name)}
                    className={`text-left p-3 rounded-lg border transition-all hover:shadow-sm w-[130px] shrink-0 ${
                      selected?.type === 'tool' && selected.name === c.name
                        ? 'border-indigo-400 bg-indigo-50 shadow-sm'
                        : c.enabled !== false ? 'border-gray-200 bg-white hover:border-indigo-200' : 'border-gray-100 bg-gray-50 opacity-60'
                    }`}>
                    <div className="flex items-center gap-1.5 mb-1">
                      <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-blue-50 text-blue-600">Tool</span>
                    </div>
                    <div className="text-xs font-medium text-gray-800 truncate">{c.name}</div>
                    <div className="text-[10px] text-gray-400 truncate mt-0.5">{c.paramCount || 0} params</div>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Recycle Bin */}
          <ConnectorRecycleBin onRestore={load} />
        </div>
      </div>

      {/* Draggable divider */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          const startX = e.clientX;
          const startW = sideWidth;
          const onMove = (ev: MouseEvent) => { if (draggingRef.current) setSideWidth(Math.max(200, Math.min(500, startW + ev.clientX - startX))); };
          const onUp = () => { draggingRef.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        className="w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-indigo-400 active:bg-indigo-500 transition-colors"
      />

      {/* Right: detail / config */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {selectedDetail ? (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 shrink-0">
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                selected!.type === 'mcp' && selectedDetail.name?.startsWith('db-') ? 'bg-purple-50 text-purple-600'
                : selected!.type === 'mcp' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'
              }`}>{selected!.type === 'mcp' && selectedDetail.name?.startsWith('db-') ? 'DB' : selected!.type === 'mcp' ? 'MCP' : 'Tool'}</span>
              <h3 className="text-base font-semibold">{selectedDetail.name}</h3>
              <McpPhase phase={selectedDetail.status?.phase} />
              <div className="flex-1" />
              <button onClick={() => chatWithAgent(selected!.type, selectedDetail.name)}
                className="text-xs px-3 py-1 border border-indigo-200 text-indigo-600 rounded hover:bg-indigo-50 flex items-center gap-1" title="与连接大师对话编辑">
                <img src="/icons/对话.svg" alt="" className="w-3.5 h-3.5" /> 对话
              </button>
              <button onClick={() => {
                if (selected!.type === 'mcp') toggleMcp(selectedDetail.name, !selectedDetail.enabled);
                else toggleTool(selectedDetail.name, !selectedDetail.enabled);
              }}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${selectedDetail.enabled !== false ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${selectedDetail.enabled !== false ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
              <button onClick={() => selected!.type === 'mcp' ? deleteMcp(selectedDetail.name) : deleteTool(selectedDetail.name)}
                className="text-xs text-gray-400 hover:text-red-500" title="删除">🗑️</button>
            </div>

            {/* DB Schema Cache bar — only for db- MCPs */}
            {selected!.type === 'mcp' && selectedDetail.name?.startsWith('db-') && (
              <DbSchemaCacheBar name={selectedDetail.name} />
            )}

            {/* Description bar */}
            <div className="px-5 py-2 bg-gray-50 border-b border-gray-200 shrink-0">
              <div className="text-xs text-gray-600">{selectedDetail.description || '无描述'}</div>
              {selected!.type === 'mcp' && selectedDetail.tools?.length > 0 && (
                <div className="mt-1.5">
                  <div className="text-[10px] text-gray-400 mb-1">工具 ({selectedDetail.tools.length})</div>
                  <div className="flex flex-wrap gap-1">
                    {selectedDetail.tools.map((t: any) => {
                      const name = typeof t === 'string' ? t : t.name;
                      const desc = typeof t === 'object' ? t.description : '';
                      return (
                        <span key={name} className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white border border-gray-200 text-[10px] text-gray-600" title={desc}>
                          <span className="font-medium">{name}</span>
                          {desc && <span className="text-gray-300 hidden sm:inline">— {desc.length > 30 ? desc.slice(0, 30) + '…' : desc}</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 shrink-0">
              {([['config', '配置'], ['code', '代码'], ['credentials', '凭证'],
                ...(selected!.type === 'mcp' && selectedDetail.name?.startsWith('db-') ? [['schema', '表结构']] : [])
              ] as [string, string][]).map(([key, label]) => (
                <button key={key} onClick={() => {
                  setDetailTab(key as any);
                  if (key === 'code') setHandlerDraft(handlerCode);
                }}
                  className={`px-5 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                  {label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-hidden min-h-0">
              {detailTab === 'config' ? (
                <div className="h-full flex flex-col pb-[5px]">
                  <div className="flex items-center gap-2 px-4 py-1.5 bg-gray-800 shrink-0">
                    <span className="text-xs text-gray-400 flex-1">{selected!.type === 'mcp' ? 'manifest.yaml' : 'tool.yaml'}</span>
                    {editDraft !== manifest && (
                      <button onClick={async () => {
                        const apiPath = selected!.type === 'mcp'
                          ? `${MAIN_URL}/api/mcp/register`
                          : `${MAIN_URL}/api/tools/${selected!.name}/manifest`;
                        const body = selected!.type === 'mcp' ? { manifest: editDraft } : { manifest: editDraft };
                        await fetch(apiPath, { method: selected!.type === 'mcp' ? 'POST' : 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
                        const reloadPath = selected!.type === 'mcp' ? `${MAIN_URL}/api/mcp/reload` : `${MAIN_URL}/api/tools/reload`;
                        await fetch(reloadPath, { method: 'POST', headers: authHeaders() });
                        setManifest(editDraft);
                        load();
                      }} className="text-xs px-3 py-0.5 bg-indigo-500 text-white rounded hover:bg-indigo-600">保存</button>
                    )}
                  </div>
                  <div className="flex-1 min-h-0">
                    <MonacoEditor
                      height="100%"
                      language="yaml"
                      theme="vs-dark"
                      value={editDraft}
                      onChange={(val) => setEditDraft(val || '')}
                      options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, automaticLayout: true }}
                    />
                  </div>
                </div>
              ) : detailTab === 'code' ? (
                <div className="h-full flex flex-col pb-[5px]">
                  <div className="flex items-center gap-2 px-4 py-1.5 bg-gray-800 shrink-0">
                    <span className="text-xs text-gray-400 flex-1">{selected!.type === 'mcp' ? 'mcp-server.ts' : 'handler.ts'}</span>
                    {handlerDraft !== handlerCode && (
                      <button onClick={async () => {
                        setHandlerSaving(true);
                        const apiPath = selected!.type === 'mcp'
                          ? `${MAIN_URL}/api/mcp/${selected!.name}/handler`
                          : `${MAIN_URL}/api/tools/${selected!.name}/handler`;
                        await fetch(apiPath, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ handler: handlerDraft }) });
                        const reloadPath = selected!.type === 'mcp' ? `${MAIN_URL}/api/mcp/reload` : `${MAIN_URL}/api/tools/reload`;
                        await fetch(reloadPath, { method: 'POST', headers: authHeaders() });
                        setHandlerCode(handlerDraft);
                        setHandlerSaving(false);
                      }} disabled={handlerSaving}
                        className="text-xs px-3 py-0.5 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-50">
                        {handlerSaving ? '保存中...' : '保存'}
                      </button>
                    )}
                  </div>
                  <div className="flex-1 min-h-0">
                    {handlerCode ? (
                      <MonacoEditor
                        height="100%"
                        language="javascript"
                        theme="vs-dark"
                        value={handlerDraft}
                        onChange={(val) => setHandlerDraft(val || '')}
                        options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, automaticLayout: true }}
                      />
                    ) : (
                      <div className="flex items-center justify-center h-full text-xs text-gray-400">无 handler 代码</div>
                    )}
                  </div>
                </div>
              ) : detailTab === 'credentials' ? (
                <CredentialForm
                  name={selectedDetail.name}
                  credSystem={selectedDetail.authSystem || selectedDetail.system || selectedDetail.name}
                  authFields={selectedDetail.authFields}
                  userId={userId}
                  credentials={selectedDetail.authScope === 'global' ? globalCredentials : credentials}
                  onSaved={selectedDetail.authScope === 'global' ? loadGlobalCredentials : loadCredentials}
                  scope={selectedDetail.authScope || 'user'}
                  isAdmin={typeof user?.role === 'object' && user?.role?.permissions?.includes('sys:admin') || false}
                />
              ) : detailTab === 'schema' ? (
                <DbSchemaViewer name={selectedDetail.name} />
              ) : null}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <div className="text-4xl mb-2">🔗</div>
              <div className="text-sm">{t('connectors.empty')}</div>
              <div className="text-xs mt-1">{t('connectors.emptyDesc')}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectorRecycleBin({ onRestore }: { onRestore: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);

  const load = useCallback(async () => {
    const [toolDel, mcpDel] = await Promise.all([
      fetch(`${MAIN_URL}/api/tools/deleted`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${MAIN_URL}/api/mcp/deleted`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
    ]);
    const all = [
      ...(Array.isArray(toolDel) ? toolDel : []).map((d: any) => ({ ...d, _type: 'tool' })),
      ...(Array.isArray(mcpDel) ? mcpDel : []).map((d: any) => ({ ...d, _type: 'mcp' })),
    ].sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));
    setItems(all);
  }, []);

  useEffect(() => { if (open) load(); }, [open, load]);

  const restore = async (item: any) => {
    const url = item._type === 'tool'
      ? `${MAIN_URL}/api/tools/deleted/${item.dirName}/restore`
      : `${MAIN_URL}/api/mcp/deleted/${item.dirName}/restore`;
    const resp = await fetch(url, { method: 'POST', headers: authHeaders() }).then(r => r.json());
    if (resp.success) { load(); onRestore(); } else { alertError(resp.error || '恢复失败'); }
  };

  const purge = async (item: any) => {
    if (!(await confirmDialog(`确认永久删除 "${item.originalName || item.name}"？此操作不可恢复。`, { danger: true }))) return;
    const url = item._type === 'tool'
      ? `${MAIN_URL}/api/tools/deleted/${item.dirName}`
      : `${MAIN_URL}/api/mcp/deleted/${item.dirName}`;
    await fetch(url, { method: 'DELETE', headers: authHeaders() });
    load();
  };

  if (!open) {
    return (
      <div className="p-3 pt-6">
        <button onClick={() => { setOpen(true); load(); }}
          className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
          🗑️ 回收站 ▸
        </button>
      </div>
    );
  }

  return (
    <div className="p-3 pt-6">
      <button onClick={() => setOpen(false)}
        className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
        🗑️ 回收站 ▾
      </button>
      <div className="mt-2 border border-dashed border-gray-200 rounded-lg p-2 space-y-1">
        {items.length === 0 && <div className="text-xs text-gray-400 text-center py-2">回收站为空</div>}
        {items.map(item => (
          <div key={item.dirName} className="flex items-center gap-2 py-1.5 border-b border-gray-100 last:border-0">
            <span className={`text-[9px] px-1 py-0.5 rounded font-medium shrink-0 ${item._type === 'mcp' ? 'bg-emerald-50 text-emerald-600' : 'bg-blue-50 text-blue-600'}`}>
              {item._type === 'mcp' ? 'MCP' : 'Tool'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium text-gray-600 truncate">{item.name || item.originalName}</div>
              {item.deletedAt && <div className="text-[10px] text-gray-400">{new Date(item.deletedAt).toLocaleString('zh-CN')}</div>}
            </div>
            <button onClick={() => restore(item)} className="px-1.5 py-0.5 text-[10px] text-emerald-600 border border-emerald-200 rounded hover:bg-emerald-50">恢复</button>
            <button onClick={() => purge(item)} className="px-1.5 py-0.5 text-[10px] text-red-400 border border-red-200 rounded hover:bg-red-50">删除</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function DbSchemaCacheBar({ name }: { name: string }) {
  const [status, setStatus] = useState<{ cached: boolean; total?: number; updated?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(() => {
    fetch(`${MAIN_URL}/api/mcp/${name}/schema-status`, { headers: authHeaders() })
      .then(r => r.json()).then(setStatus).catch(() => {});
  }, [name]);

  useEffect(() => {
    load();
    // Poll every 5s while uncached (backend may be generating asynchronously)
    const timer = setInterval(() => {
      setStatus(prev => {
        if (prev && !prev.cached) load();
        return prev;
      });
    }, 5000);
    return () => clearInterval(timer);
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`${MAIN_URL}/api/mcp/${name}/refresh-schema`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (data.success) setStatus({ cached: true, total: data.total, updated: new Date().toISOString() });
    } catch {}
    setRefreshing(false);
  };

  if (!status) return null;

  return (
    <div className="px-5 py-2 bg-purple-50/50 border-b border-gray-200 shrink-0 flex items-center gap-3">
      <span className="text-[10px] text-purple-600 font-medium">结构缓存</span>
      {status.cached ? (
        <span className="text-[10px] text-gray-500">
          {status.total} 张表 · {status.updated ? new Date(status.updated).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
        </span>
      ) : (
        <span className="text-[10px] text-orange-500">未生成</span>
      )}
      <div className="flex-1" />
      <button onClick={refresh} disabled={refreshing}
        className="text-[10px] px-2 py-0.5 border border-purple-200 text-purple-600 rounded hover:bg-purple-100 disabled:opacity-50 flex items-center gap-1">
        {refreshing ? '生成中...' : '🔄 刷新结构'}
      </button>
    </div>
  );
}

function DbSchemaViewer({ name }: { name: string }) {
  const [files, setFiles] = useState<{ name: string; file: string; comment: string }[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    fetch(`${MAIN_URL}/api/mcp/${name}/schema-files`, { headers: authHeaders() })
      .then(r => r.json()).then(d => { if (d.files) setFiles(d.files); }).catch(() => {});
  }, [name]);

  const selectFile = useCallback(async (fileName: string) => {
    setSelected(fileName);
    setEditing(false);
    const res = await fetch(`${MAIN_URL}/api/mcp/${name}/schema-files/${fileName}`, { headers: authHeaders() });
    const data = await res.json();
    if (data.content) { setContent(data.content); setDraft(data.content); }
  }, [name]);

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    await fetch(`${MAIN_URL}/api/mcp/${name}/schema-files/${selected}`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ content: draft }),
    });
    setContent(draft);
    setSaving(false);
  };

  // Strip YAML frontmatter for display
  const displayContent = (content || '').replace(/^---[\s\S]*?---\n/, '');

  const filterLower = filter.toLowerCase();
  const filtered = filter
    ? files.filter(f => f.name.toLowerCase().includes(filterLower) || (f.comment || '').toLowerCase().includes(filterLower))
    : files;

  if (files.length === 0) {
    return <div className="flex items-center justify-center h-full text-xs text-gray-400">暂无结构缓存，请先点击「刷新结构」生成</div>;
  }

  return (
    <div className="flex h-full">
      {/* Left: table list */}
      <div className="w-52 border-r border-gray-200 flex flex-col shrink-0">
        <div className="px-2 py-1.5 border-b border-gray-100">
          <input type="text" value={filter} onChange={e => setFilter(e.target.value)}
            placeholder="搜索表名或说明..." className="w-full text-[11px] px-2 py-1 border border-gray-200 rounded outline-none focus:border-indigo-300" />
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.map(f => (
            <button key={f.name} onClick={() => selectFile(f.name)}
              className={`w-full text-left px-3 py-1.5 hover:bg-gray-50 ${selected === f.name ? 'bg-indigo-50' : ''}`}
              title={f.name}>
              <div className={`text-[11px] truncate ${selected === f.name ? 'text-indigo-700 font-medium' : 'text-gray-700'}`}>
                {f.comment || f.name}
              </div>
              {f.comment && (
                <div className="text-[9px] text-gray-400 truncate">{f.name}</div>
              )}
            </button>
          ))}
        </div>
        <div className="px-3 py-1.5 border-t border-gray-100 text-[10px] text-gray-400">{files.length} 张表</div>
      </div>
      {/* Right: preview / editor */}
      <div className="flex-1 flex flex-col min-w-0">
        {selected ? (
          <>
            <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 shrink-0">
              <span className="text-xs text-gray-600 font-medium flex-1">{selected}.md</span>
              {editing ? (
                <>
                  {draft !== content && (
                    <button onClick={save} disabled={saving}
                      className="text-[11px] px-3 py-0.5 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-50">
                      {saving ? '保存中...' : '保存'}
                    </button>
                  )}
                  <button onClick={() => { setEditing(false); setDraft(content); }}
                    className="text-[11px] px-2 py-0.5 border border-gray-300 text-gray-500 rounded hover:bg-gray-100">
                    取消
                  </button>
                </>
              ) : (
                <button onClick={() => setEditing(true)}
                  className="text-[11px] px-2 py-0.5 border border-gray-300 text-gray-500 rounded hover:bg-gray-100">
                  ✏️ 编辑
                </button>
              )}
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {editing ? (
                <MonacoEditor height="100%" language="markdown" theme="vs-dark" value={draft}
                  onChange={val => setDraft(val || '')}
                  options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, automaticLayout: true }} />
              ) : (
                <div className="h-full overflow-y-auto px-5 py-3">
                  <SchemaMdPreview content={displayContent} />
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex items-center justify-center h-full text-xs text-gray-400">← 选择一张表查看结构</div>
        )}
      </div>
    </div>
  );
}

const schemaMdProseClass = "prose prose-sm prose-gray max-w-none leading-relaxed [&_table]:text-xs [&_table]:w-full [&_table]:border-collapse [&_table]:border [&_table]:border-gray-200 [&_th]:bg-gray-50 [&_th]:px-3 [&_th]:py-1.5 [&_th]:border [&_th]:border-gray-200 [&_th]:text-left [&_th]:font-semibold [&_td]:px-3 [&_td]:py-1 [&_td]:border [&_td]:border-gray-200 [&_h2]:text-sm [&_h2]:mt-0 [&_h2]:mb-2 [&_h3]:text-xs [&_h3]:mt-4 [&_h3]:mb-1 [&_p]:text-xs [&_p]:my-1 [&_li]:text-xs [&_li]:my-0.5 [&_ul]:pl-5 [&_code]:text-indigo-600 [&_code]:bg-indigo-50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[11px]";

function SchemaMdPreview({ content }: { content: string }) {
  const ReactMarkdown = require('react-markdown').default;
  const remarkGfm = require('remark-gfm').default;
  return (
    <div className={schemaMdProseClass}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>
        {content || '*无内容*'}
      </ReactMarkdown>
    </div>
  );
}

function McpPhase({ phase }: { phase?: string }) {
  if (phase === 'building') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200">构建中</span>;
  if (phase === 'unconfigured') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-500 border border-orange-200">未配置</span>;
  if (phase === 'available') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-600 border border-green-200">可用</span>;
  return null;
}
