'use client';

import { useState, useCallback, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

const MAIN_URL = getMainUrl();

async function responseData(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/** 开发 MCP 卡片：dev token 签发/状态/吊销（对应 design-app-dev-mcp §3.2 四道闸） */
export default function DevMcpCard() {
  const { token } = useAuth();
  const [status, setStatus] = useState<{ enabled: boolean; issued?: boolean; issuedBy?: string; issuedAt?: string } | null>(null);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/dev/token`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await responseData(resp);
      if (resp.ok) setStatus(data);
      else setStatus({ enabled: false });
    } catch {
      setStatus({ enabled: false });
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const issue = async () => {
    if (!token) return;
    if (!(await confirmDialog('签发新的 dev token？旧 token 将立即失效。', { danger: true }))) return;
    setBusy(true);
    setError(null);
    try {
      const resp = await fetch(`${MAIN_URL}/api/dev/token`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await responseData(resp);
      if (!resp.ok) throw new Error(data.message || `签发失败: ${resp.status}`);
      setNewToken(data.token);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (!token) return;
    if (!(await confirmDialog('确定吊销 dev token？所有使用它的开发环境将立即断开。', { danger: true }))) return;
    setBusy(true);
    try {
      await fetch(`${MAIN_URL}/api/dev/token`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      setNewToken(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <h3 className="text-sm font-semibold mb-1">开发 MCP</h3>
      <p className="text-xs text-gray-400 mb-3">
        供外部开发环境（Cursor / Claude Code / CodeBuddy）接入本实例开发调试 APP。端点 <code className="text-gray-500">POST /api/dev/mcp</code>
      </p>
      {status && !status.enabled && (
        <p className="text-xs text-amber-600 bg-amber-50 border border-amber-100 rounded px-3 py-2">
          未启用：请在 system.json 中设置 <code>devMcp.enabled: true</code> 后重启服务（默认关闭）。
        </p>
      )}
      {status?.enabled && (
        <div className="space-y-2 text-xs text-gray-600">
          <div>
            状态：{status.issued
              ? <span className="text-emerald-600">已签发（{status.issuedBy} · {status.issuedAt ? new Date(status.issuedAt).toLocaleString() : ''}）</span>
              : <span className="text-gray-400">未签发 token</span>}
          </div>
          {error && <div className="text-red-600">{error}</div>}
          {newToken && (
            <div className="p-2 bg-gray-50 border border-gray-200 rounded">
              <div className="text-gray-400 mb-1">新 token（仅本次完整显示，请立即保存）：</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-[11px] break-all text-gray-700">{newToken}</code>
                <button
                  className="px-2 py-0.5 bg-gray-200 rounded hover:bg-gray-300 shrink-0"
                  onClick={() => { navigator.clipboard?.writeText(newToken); }}
                >
                  复制
                </button>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={issue}
              disabled={busy}
              className="px-3 py-1 font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50"
            >
              {status.issued ? '重新签发' : '签发 token'}
            </button>
            {status.issued && (
              <button
                onClick={revoke}
                disabled={busy}
                className="px-3 py-1 font-medium text-red-600 bg-red-50 rounded hover:bg-red-100 disabled:opacity-50"
              >
                吊销
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
