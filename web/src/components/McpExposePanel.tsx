'use client';

/**
 * P3 APP MCP 暴露审批列表（admin）：声明了 mcpExposed 的 active APP + 审批开关。
 * 数据源 GET /api/app-store/mcp-expose/declared；审批 PUT /api/app-store/apps/:appId/mcp-expose。
 */
import { useState, useEffect, useCallback } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

interface DeclaredExpose {
  appId: string;
  appName?: string;
  toolIds: string[];
  firstParty: boolean;
  allowed: boolean;
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
}

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export default function McpExposePanel() {
  const [items, setItems] = useState<DeclaredExpose[]>([]);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const list = await fetch(`${MAIN_URL}/api/app-store/mcp-expose/declared`, { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : [])).catch(() => []);
    if (Array.isArray(list)) setItems(list);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (item: DeclaredExpose) => {
    const resp = await fetch(`${MAIN_URL}/api/app-store/apps/${encodeURIComponent(item.appId)}/mcp-expose`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ allowed: !item.allowed }),
    });
    if (resp.ok) {
      setMsg(`已${item.allowed ? '关闭' : '开启'}「${item.appName ?? item.appId}」的 MCP 暴露`);
      setTimeout(() => setMsg(''), 4000);
      load();
    } else {
      setMsg(`操作失败（${resp.status}）`);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4 mt-4">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold">APP MCP 暴露审批</h3>
      </div>
      <p className="text-[11px] text-gray-400 mb-3">
        声明了 mcpExposed 的应用须经审批后工具才进入 MCP facade（/api/dev/mcp）。首方应用恒视为已审批。
      </p>
      {msg && <div className="text-xs text-indigo-600 mb-2">{msg}</div>}
      {items.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-6 border border-dashed border-gray-200 rounded-lg">
          暂无声明 mcpExposed 的应用
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(item => (
            <div key={item.appId} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${item.allowed ? 'border-gray-200' : 'border-gray-100 opacity-75'}`}>
              <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${item.firstParty ? 'bg-purple-50 text-purple-600' : 'bg-blue-50 text-blue-600'}`}>
                {item.firstParty ? '首方' : '三方'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{item.appName ?? item.appId}</div>
                <div className="text-xs text-gray-400 truncate">
                  {item.appId} · {item.toolIds.length} 个工具（{item.toolIds.slice(0, 4).join(', ')}{item.toolIds.length > 4 ? '…' : ''}）
                  {item.allowed && item.approvedBy && !item.firstParty && (
                    <> · {item.approvedBy} 审批于 {item.approvedAt ? new Date(item.approvedAt).toLocaleString('zh-CN') : '—'}</>
                  )}
                </div>
              </div>
              {item.firstParty ? (
                <span className="text-[11px] text-gray-400 shrink-0">恒已审批</span>
              ) : (
                <button onClick={() => toggle(item)}
                  className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${item.allowed ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${item.allowed ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
