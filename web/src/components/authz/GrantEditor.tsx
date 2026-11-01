'use client';

/**
 * P1 通用授权编辑器（后端 /api/authz/* 的前端）。
 * - global 资源：授权行编辑（targetType/targetId/level，可选 subId per-tool），PUT 整体替换
 * - user 资源：owner 分享（多选用户，POST share）
 * 403 时展示无权提示（调用方按需决定是否渲染入口按钮）。
 */
import { useEffect, useState } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export interface AuthzGrantRow {
  subId?: string;
  targetType: 'user' | 'role' | 'department';
  targetId: string;
  level: 'none' | 'user' | 'admin';
}

interface Props {
  resourceType: 'agent' | 'skill' | 'connector' | 'tool';
  resourceId: string;
  /** per-tool 授权模式：可选子项列表（如连接的工具名）；缺省仅整资源授权 */
  subIdOptions?: string[];
  onClose: () => void;
  onSaved?: () => void;
  /** 嵌入模式：不渲染全屏遮罩弹窗，直接内联渲染（用于详情页签） */
  inline?: boolean;
}

export default function GrantEditor({ resourceType, resourceId, subIdOptions, onClose, onSaved, inline }: Props) {
  const [meta, setMeta] = useState<any>(null);
  const [rows, setRows] = useState<AuthzGrantRow[]>([]);
  const [shareIds, setShareIds] = useState<string[]>([]);
  const [subjects, setSubjects] = useState<{ users: any[]; roles: any[]; departments: any[] }>({ users: [], roles: [], departments: [] });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      const g = await fetch(
        `${MAIN_URL}/api/authz/${resourceType}/${encodeURIComponent(resourceId)}/grants`,
        { headers: authHeaders() },
      );
      if (!g.ok) { setError(g.status === 403 ? '无权授权该资源' : `加载失败（${g.status}）`); return; }
      const gd = await g.json();
      setMeta(gd.meta);
      setRows((gd.grants ?? []).map((x: any) => ({
        subId: x.subId ?? '', targetType: x.targetType, targetId: x.targetId, level: x.level,
      })));
      const s = await fetch(
        `${MAIN_URL}/api/authz/${resourceType}/${encodeURIComponent(resourceId)}/subjects`,
        { headers: authHeaders() },
      ).then(r => (r.ok ? r.json() : null)).catch(() => null);
      if (s) setSubjects({ users: s.users ?? [], roles: s.roles ?? [], departments: s.departments ?? [] });
      setLoaded(true);
    })();
  }, [resourceType, resourceId]);

  const targetOptions = (type: string) =>
    type === 'user' ? subjects.users : type === 'role' ? subjects.roles : subjects.departments;

  const updateRow = (i: number, patch: Partial<AuthzGrantRow>) =>
    setRows(prev => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const saveGrants = async () => {
    setSaving(true);
    try {
      const resp = await fetch(
        `${MAIN_URL}/api/authz/${resourceType}/${encodeURIComponent(resourceId)}/grants`,
        {
          method: 'PUT', headers: authHeaders(),
          body: JSON.stringify({ grants: rows.filter(r => r.targetId) }),
        },
      );
      if (!resp.ok) { setError(`保存失败（${resp.status}）`); return; }
      onSaved?.();
      onClose();
    } finally { setSaving(false); }
  };

  const share = async () => {
    setSaving(true);
    try {
      const resp = await fetch(
        `${MAIN_URL}/api/authz/${resourceType}/${encodeURIComponent(resourceId)}/share`,
        { method: 'POST', headers: authHeaders(), body: JSON.stringify({ userIds: shareIds }) },
      );
      if (!resp.ok) { setError(`分享失败（${resp.status}）`); return; }
      onSaved?.();
      onClose();
    } finally { setSaving(false); }
  };

  const isShare = meta?.scope === 'user';

  const card = (
      <div
        className="bg-white rounded-lg shadow-xl w-[520px] max-w-full max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-medium">
            {isShare ? '分享资源' : '资源授权'} <span className="text-gray-400 font-normal">{resourceId}</span>
          </span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          {error && <div className="text-xs text-red-500 mb-3">{error}</div>}
          {!error && !loaded && <div className="text-xs text-gray-400">加载中…</div>}

          {!error && loaded && isShare && (
            <div>
              <div className="text-xs text-gray-500 mb-2">选择要分享的用户（仅查看，不可编辑）：</div>
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {subjects.users.filter((u: any) => u.id !== meta?.ownerUserId).map((u: any) => (
                  <label key={u.id} className="flex items-center gap-2 text-xs text-gray-700">
                    <input
                      type="checkbox"
                      checked={shareIds.includes(u.id)}
                      onChange={e =>
                        setShareIds(prev =>
                          e.target.checked ? [...prev, u.id] : prev.filter(id => id !== u.id),
                        )
                      }
                    />
                    {u.name || u.username || u.id}
                  </label>
                ))}
                {subjects.users.length === 0 && <div className="text-xs text-gray-400">暂无可选用户</div>}
              </div>
            </div>
          )}

          {!error && loaded && !isShare && (
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  {subIdOptions && subIdOptions.length > 0 && (
                    <select
                      value={r.subId ?? ''}
                      onChange={e => updateRow(i, { subId: e.target.value })}
                      className="text-xs border border-gray-300 rounded px-1.5 py-1"
                      title="授权范围"
                    >
                      <option value="">全部</option>
                      {subIdOptions.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  )}
                  <select
                    value={r.targetType}
                    onChange={e => updateRow(i, { targetType: e.target.value as any, targetId: '' })}
                    className="text-xs border border-gray-300 rounded px-1.5 py-1"
                  >
                    <option value="user">用户</option>
                    <option value="role">角色</option>
                    <option value="department">部门</option>
                  </select>
                  <select
                    value={r.targetId}
                    onChange={e => updateRow(i, { targetId: e.target.value })}
                    className="flex-1 text-xs border border-gray-300 rounded px-1.5 py-1 min-w-0"
                  >
                    <option value="">选择对象…</option>
                    {targetOptions(r.targetType).map((o: any) => (
                      <option key={o.id} value={o.id}>{o.name || o.id}</option>
                    ))}
                  </select>
                  <select
                    value={r.level}
                    onChange={e => updateRow(i, { level: e.target.value as any })}
                    className="text-xs border border-gray-300 rounded px-1.5 py-1"
                  >
                    <option value="user">可用</option>
                    <option value="admin">管理</option>
                  </select>
                  <button
                    onClick={() => setRows(prev => prev.filter((_, j) => j !== i))}
                    className="text-xs text-red-400 hover:text-red-600 px-1"
                  >×</button>
                </div>
              ))}
              <button
                onClick={() => setRows(prev => [...prev, { subId: '', targetType: 'user', targetId: '', level: 'user' }])}
                className="text-xs px-2 py-1 border border-dashed border-gray-300 rounded text-gray-500 hover:border-indigo-300 hover:text-indigo-500"
              >
                + 添加授权
              </button>
              <div className="text-[10px] text-gray-400 pt-1">保存将整体替换该资源的全部授权。</div>
            </div>
          )}
        </div>

        {!error && loaded && (
          <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
            <button onClick={onClose} className="text-xs px-3 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50">取消</button>
            <button
              onClick={isShare ? share : saveGrants}
              disabled={saving}
              className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      </div>
  );

  if (inline) {
    return (
      <div className="inline-block align-top">
        {card}
      </div>
    );
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      {card}
    </div>
  );
}
