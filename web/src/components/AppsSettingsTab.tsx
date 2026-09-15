'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAuth } from '@/hooks/useAuth';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

const MAIN_URL = getMainUrl();

type LocalizedName = string | Record<string, string>;
type InstallPhase =
  | 'unpacking'
  | 'validating'
  | 'ready'
  | 'installing'
  | 'provisioning'
  | 'migrating'
  | 'activating'
  | 'succeeded'
  | 'failed'
  | 'expired'
  | 'unavailable';

interface AppCapabilities {
  tools: Array<{ id: string; group?: string }>;
  skills: Array<{ name: string }>;
  agents: Array<{ id: string }>;
}

interface InstalledApp {
  appId: string;
  name: LocalizedName;
  version: string;
  status: string;
  description?: string;
  author?: string;
  installedAt?: string;
  capabilities?: AppCapabilities;
  usage?: string | null;
}

interface InstallOperation {
  stageId: string;
  phase: InstallPhase;
  percent: number;
  message: string;
  recovery?: 'purge-orphaned-data';
  appId?: string;
  version?: string;
  manifest?: {
    appId: string;
    name: LocalizedName;
    version: string;
  };
  warnings: string[];
  errors: string[];
}

const phaseLabels: Record<InstallPhase, string> = {
  unpacking: '正在解包',
  validating: '正在校验',
  ready: '校验完成',
  installing: '正在安装',
  provisioning: '正在准备环境',
  migrating: '正在执行迁移',
  activating: '正在激活',
  succeeded: '安装完成',
  failed: '安装失败',
  expired: '已过期',
  unavailable: '状态不可用',
};

function displayName(name: LocalizedName | undefined, fallback: string): string {
  if (typeof name === 'string') return name || fallback;
  return name?.zh || name?.en || fallback;
}

/** 使用说明的 Markdown 排版样式（与技能面板 SKILL.md 预览同款约定） */
const usageProseClass = "prose prose-sm prose-gray max-w-none leading-relaxed [&_table]:text-xs [&_table]:w-full [&_table]:border-collapse [&_th]:bg-gray-50 [&_th]:px-2 [&_th]:py-1 [&_th]:border [&_th]:border-gray-200 [&_td]:px-2 [&_td]:py-1 [&_td]:border [&_td]:border-gray-200 [&_pre]:bg-gray-900 [&_pre]:text-green-300 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:text-[11px] [&_pre]:overflow-x-auto [&_code]:text-indigo-600 [&_code]:bg-indigo-50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[11px] [&_pre_code]:text-green-300 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_h1]:text-sm [&_h1]:mt-3 [&_h1]:mb-2 [&_h2]:text-xs [&_h2]:mt-3 [&_h2]:mb-1 [&_h3]:text-xs [&_h3]:mt-2 [&_h3]:mb-1 [&_p]:text-xs [&_p]:my-1.5 [&_li]:text-xs [&_li]:my-0.5 [&_ul]:pl-5 [&_ol]:pl-5";

async function responseData(response: Response): Promise<any> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 开发 MCP 卡片：dev token 签发/状态/吊销（对应 design-app-dev-mcp §3.2 四道闸） */
function DevMcpCard({ token }: { token: string | null }) {
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

export default function AppsSettingsTab() {
  const { token } = useAuth();
  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<InstalledApp | null>(null);
  const [operation, setOperation] = useState<InstallOperation | null>(null);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollingRef = useRef<number | null>(null);
  const dismissRef = useRef<number | null>(null);
  const pollingGenerationRef = useRef(0);
  const pollingFailuresRef = useRef(0);

  const fetchApps = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch(`${MAIN_URL}/api/app-store/apps`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await responseData(resp);
      if (!resp.ok) throw new Error(data.message || `加载失败: ${resp.status}`);
      setApps(Array.isArray(data) ? data : []);
    } catch (e: any) {
      setError(e.message || '加载应用列表失败');
    } finally {
      setLoading(false);
    }
  }, [token]);

  const stopPolling = useCallback(() => {
    pollingGenerationRef.current += 1;
    if (pollingRef.current !== null) {
      window.clearTimeout(pollingRef.current);
      pollingRef.current = null;
    }
    if (dismissRef.current !== null) {
      window.clearTimeout(dismissRef.current);
      dismissRef.current = null;
    }
  }, []);

  const scheduleDismiss = useCallback((stageId: string) => {
    dismissRef.current = window.setTimeout(() => {
      dismissRef.current = null;
      setOperation(current => current?.stageId === stageId ? null : current);
    }, 3000);
  }, []);

  const setOperationUnavailable = useCallback((stageId: string, message: string) => {
    stopPolling();
    setOperation(current => {
      if (!current || current.stageId !== stageId) return current;
      return {
        ...current,
        phase: 'unavailable',
        percent: 100,
        message,
        errors: [message],
      };
    });
  }, [stopPolling]);

  const pollOperation = useCallback(async (stageId: string): Promise<number | null> => {
    if (!token) return null;
    try {
      const resp = await fetch(`${MAIN_URL}/api/app-store/stage/${encodeURIComponent(stageId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await responseData(resp);
      if (!resp.ok) {
        if ([502, 503, 504].includes(resp.status)) {
          throw new Error('安装状态服务暂时不可用');
        }
        if ([401, 403].includes(resp.status)) {
          setOperationUnavailable(stageId, '登录状态已失效，请重新登录后再检查安装状态。');
        } else if ([404, 410].includes(resp.status)) {
          setOperationUnavailable(stageId, '安装状态已不存在或已过期。服务可能已重启，请刷新应用列表确认结果后重新上传。');
        } else {
          setOperationUnavailable(stageId, '无法确认安装状态。请刷新应用列表确认结果后重新上传。');
        }
        return null;
      }

      pollingFailuresRef.current = 0;
      setOperation(current => current?.stageId === stageId ? data : current);
      if (['ready', 'succeeded', 'failed', 'expired'].includes(data.phase)) {
        stopPolling();
        if (data.phase === 'succeeded') {
          await fetchApps();
          scheduleDismiss(stageId);
        }
        return null;
      }
      return 1200;
    } catch {
      pollingFailuresRef.current += 1;
      if (pollingFailuresRef.current >= 3) {
        setOperationUnavailable(stageId, '安装状态服务暂时不可用。请刷新应用列表确认结果，服务恢复后可重新检查或重新上传。');
        return null;
      }

      const attempt = pollingFailuresRef.current;
      setOperation(current => current?.stageId === stageId
        ? { ...current, message: `安装状态服务暂时不可用，正在重试（${attempt}/3）…` }
        : current,
      );
      return 1200 * 2 ** (attempt - 1);
    }
  }, [fetchApps, scheduleDismiss, setOperationUnavailable, stopPolling, token]);

  const startPolling = useCallback((stageId: string) => {
    stopPolling();
    pollingFailuresRef.current = 0;
    const generation = pollingGenerationRef.current;
    const poll = async () => {
      const delay = await pollOperation(stageId);
      if (delay === null || generation !== pollingGenerationRef.current) return;
      pollingRef.current = window.setTimeout(() => void poll(), delay);
    };
    void poll();
  }, [pollOperation, stopPolling]);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  useEffect(() => () => stopPolling(), [stopPolling]);

  const uploadPackage = (file: File): Promise<InstallOperation> => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${MAIN_URL}/api/app-store/stage`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) setUploadProgress(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onerror = () => reject(new Error('上传失败，请检查网络连接'));
    xhr.onload = () => {
      let data: any = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        data = {};
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(data.message || `上传失败: ${xhr.status}`));
        return;
      }
      resolve(data);
    };
    const form = new FormData();
    form.append('package', file);
    xhr.send(form);
  });

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !token) return;
    stopPolling();
    setOperation(null);
    setError(null);
    setUploadProgress(0);
    try {
      const nextOperation = await uploadPackage(file);
      setOperation(nextOperation);
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      startPolling(nextOperation.stageId);
    } catch (e: any) {
      setError(e.message || '应用包上传失败');
      setUploadProgress(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleInstall = async (purgeOrphanedData = false) => {
    const canInstall = operation?.phase === 'ready'
      || (purgeOrphanedData && operation?.phase === 'failed' && operation.recovery === 'purge-orphaned-data');
    if (!operation || !canInstall || !token) return;
    setError(null);
    try {
      const resp = await fetch(`${MAIN_URL}/api/app-store/apps`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ stageId: operation.stageId, purgeOrphanedData }),
      });
      const data = await responseData(resp);
      if (!resp.ok) throw new Error(data.message || `安装启动失败: ${resp.status}`);
      setOperation(data);
      startPolling(operation.stageId);
    } catch (e: any) {
      setError(e.message || '安装启动失败');
    }
  };

  /** 选中应用：先展示列表数据，再异步拉详情合并 capabilities/author/description */
  const selectApp = useCallback(async (app: InstalledApp) => {
    setSelected(app);
    if (!token) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/app-store/apps/${encodeURIComponent(app.appId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return;
      const data = await responseData(resp);
      setSelected(current => current?.appId === app.appId ? { ...current, ...data } : current);
    } catch {
      // 详情加载失败时保留列表数据
    }
  }, [token]);

  const handleDelete = async (appId: string) => {
    if (!token) return;
    if (!(await confirmDialog(`确定要卸载应用「${appId}」吗？应用数据库数据会保留，重新安装同一应用时将恢复。`, { danger: true, confirmText: '卸载' }))) return;
    setDeleting(appId);
    setError(null);
    try {
      const resp = await fetch(`${MAIN_URL}/api/app-store/apps/${encodeURIComponent(appId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) {
        const data = await responseData(resp);
        throw new Error(data.message || `卸载失败: ${resp.status}`);
      }
      if (selected?.appId === appId) setSelected(null);
      await fetchApps();
    } catch (e: any) {
      setError(e.message || '卸载失败');
    } finally {
      setDeleting(null);
    }
  };

  const activeOperation = operation && !['ready', 'succeeded', 'failed', 'expired', 'unavailable'].includes(operation.phase);
  const busy = uploadProgress !== null || activeOperation;

  return (
    <div className="space-y-4">
      <DevMcpCard token={token} />
      <div className="border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">应用管理</h3>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".jzapp"
              onChange={handleFileChange}
              className="hidden"
            />
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={Boolean(busy)}
              className="px-3 py-1 text-xs font-medium text-white bg-indigo-600 rounded hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              安装应用
            </button>
            <button
              onClick={fetchApps}
              disabled={Boolean(busy)}
              className="px-3 py-1 text-xs font-medium text-gray-600 bg-gray-100 rounded hover:bg-gray-200 disabled:opacity-50 transition-colors"
            >
              刷新
            </button>
          </div>
        </div>
        <p className="text-xs text-gray-400 mb-4">上传 .jzapp 应用包进行安装、查看或卸载已安装应用。</p>

        {error && (
          <div className="mb-3 px-3 py-2 text-xs text-red-700 bg-red-50 rounded border border-red-100">
            {error}
          </div>
        )}

        {uploadProgress !== null && (
          <div className="mb-3 p-3 text-xs rounded border border-indigo-100 bg-indigo-50">
            <div className="flex justify-between text-indigo-800 mb-2"><span>正在上传应用包</span><span>{uploadProgress}%</span></div>
            <div className="h-1.5 bg-indigo-100 rounded overflow-hidden"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${uploadProgress}%` }} /></div>
          </div>
        )}

        {operation && (
          <div className="mb-3 p-3 text-xs rounded border border-gray-200 bg-gray-50">
            <div className="flex items-center justify-between text-gray-800 mb-2">
              <span className="font-medium">{phaseLabels[operation.phase]}</span>
              <span>{operation.percent}%</span>
            </div>
            <div className="h-1.5 bg-gray-200 rounded overflow-hidden"><div className={`h-full transition-all ${operation.phase === 'unavailable' ? 'bg-amber-500' : operation.phase === 'failed' || operation.phase === 'expired' ? 'bg-red-500' : operation.phase === 'succeeded' ? 'bg-green-600' : 'bg-indigo-600'}`} style={{ width: `${operation.percent}%` }} /></div>
            <div className="mt-2 text-gray-600">{operation.message}</div>

            {operation.phase === 'ready' && operation.manifest && (
              <>
                <div className="mt-3 space-y-0.5 text-gray-600">
                  <div>ID: {operation.manifest.appId}</div>
                  <div>名称: {displayName(operation.manifest.name, operation.manifest.appId)}</div>
                  <div>版本: {operation.manifest.version}</div>
                </div>
                {operation.warnings.length > 0 && <div className="mt-2 text-amber-600">警告：{operation.warnings.join('; ')}</div>}
                <button
                  onClick={() => void handleInstall()}
                  className="mt-3 px-3 py-1 text-xs font-medium text-white bg-green-600 rounded hover:bg-green-700 transition-colors"
                >
                  立即安装
                </button>
              </>
            )}

            {operation.errors.length > 0 && !operation.errors.includes(operation.message) && <div className="mt-2 text-red-600">{operation.errors.join('; ')}</div>}

            {operation.phase === 'failed' && operation.recovery === 'purge-orphaned-data' && (
              <button
                onClick={async () => {
                  if (await confirmDialog('这会永久删除同名应用遗留的数据库数据，确定继续吗？', { danger: true, confirmText: '永久删除并重试' })) {
                    void handleInstall(true);
                  }
                }}
                className="mt-3 px-3 py-1 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 transition-colors"
              >
                清除遗留数据并重试
              </button>
            )}

            {operation.phase === 'unavailable' && (
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => startPolling(operation.stageId)}
                  className="px-3 py-1 text-xs font-medium text-amber-800 bg-amber-100 rounded hover:bg-amber-200 transition-colors"
                >
                  重新检查状态
                </button>
                <span className="text-amber-700">也可刷新应用列表后重新上传。</span>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col md:flex-row gap-4 min-h-[240px]">
          <div className="w-full md:w-64 border border-gray-200 rounded-lg flex flex-col">
            <div className="px-3 py-2 text-xs font-medium text-gray-500 border-b border-gray-100">已安装应用</div>
            {loading ? (
              <div className="p-4 text-xs text-gray-400">加载中...</div>
            ) : apps.length === 0 ? (
              <div className="p-4 text-xs text-gray-400">暂无已安装应用</div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                {apps.map(app => (
                  <button
                    key={app.appId}
                    onClick={() => void selectApp(app)}
                    className={`w-full text-left px-3 py-2 text-xs border-b border-gray-50 hover:bg-gray-50 ${selected?.appId === app.appId ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700'}`}
                  >
                    <div className="font-medium truncate">{displayName(app.name, app.appId)}</div>
                    <div className="text-gray-400 truncate">{app.appId} · {app.version}</div>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex-1 border border-gray-200 rounded-lg p-4 overflow-y-auto">
            {selected ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <h4 className="text-base font-semibold text-gray-800">{displayName(selected.name, selected.appId)}</h4>
                  <button
                    onClick={() => handleDelete(selected.appId)}
                    disabled={deleting === selected.appId || Boolean(busy)}
                    className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 rounded hover:bg-red-700 disabled:opacity-50 transition-colors"
                  >
                    {deleting === selected.appId ? '卸载中...' : '卸载'}
                  </button>
                </div>
                <div className="grid grid-cols-[80px_1fr] gap-y-2 text-xs text-gray-600">
                  <div className="text-gray-400">应用 ID</div>
                  <div>{selected.appId}</div>
                  <div className="text-gray-400">版本</div>
                  <div>{selected.version}</div>
                  <div className="text-gray-400">状态</div>
                  <div>{selected.status}</div>
                  {selected.author && <><div className="text-gray-400">作者</div><div>{selected.author}</div></>}
                  {selected.description && <><div className="text-gray-400">描述</div><div>{selected.description}</div></>}
                  {selected.installedAt && <><div className="text-gray-400">安装时间</div><div>{new Date(selected.installedAt).toLocaleString()}</div></>}
                </div>
                {selected.usage && (
                  <details className="border border-gray-100 rounded-lg group">
                    <summary className="flex items-center justify-between px-3 py-2 text-xs text-gray-500 cursor-pointer hover:bg-gray-50 rounded-lg select-none">
                      <span className="font-medium">使用说明</span>
                      <button
                        className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
                        onClick={e => {
                          e.preventDefault();
                          navigator.clipboard?.writeText(selected.usage!);
                        }}
                      >
                        复制
                      </button>
                    </summary>
                    <div className={`px-3 pb-3 ${usageProseClass}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.usage}</ReactMarkdown>
                    </div>
                  </details>
                )}
                {selected.capabilities && (
                  <div className="space-y-2 border-t border-gray-100 pt-3">
                    {([
                      { label: '工具', items: selected.capabilities.tools.map(t => t.id) },
                      { label: '技能', items: selected.capabilities.skills.map(s => s.name) },
                      { label: '智能体', items: selected.capabilities.agents.map(a => a.id) },
                    ]).filter(group => group.items.length > 0).map(group => (
                      <div key={group.label}>
                        <div className="text-xs text-gray-400 mb-1">{group.label}（{group.items.length}）</div>
                        <div className="flex flex-wrap gap-1">
                          {group.items.map(item => (
                            <span key={item} className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{item}</span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-gray-400 text-sm gap-2">
                <span className="text-2xl">🧩</span>
                <p>选择左侧应用查看详情</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
