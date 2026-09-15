'use client';

import { useState, useEffect, useCallback } from 'react';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

const MAIN_URL = getMainUrl();

function authHeaders() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : '';
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
}

interface McpBinding { mcp_name: string; label?: string; schema_hint?: string; is_default?: boolean; }
interface OemApp {
  id: string; appId: string; name: string; bearerUserId: string;
  scope: string[]; mcpBindings: McpBinding[]; branding: Record<string, any>;
  allowedOrigins: string[]; cachePolicy: 'on' | 'off';
  rateLimit?: { tokenPerMin?: number; msgPerMin?: number; msgPerDay?: number };
  status: 'active' | 'suspended'; createdAt: string;
}
interface UserItem { id: string; name: string; username: string; email: string; }
interface UsageRow { metric: string; total: number; }

const ALL_SCOPES = [
  { id: 'chat:use', label: '对话出图' },
  { id: 'dash:view', label: '查看仪表盘' },
];
const METRIC_LABELS: Record<string, string> = {
  token_issue: 'Token 签发', chat_msg: '对话消息', widget_refresh: '图表刷新', mcp_query: 'MCP 查询',
};

const EMBED_HINT = `<script src="<见智域名>/oem/sdk.js"></script>
<script>
  // token 由你的后端用 app_id + app_secret 调 POST /api/oem/token 换取
  JianzhiDashboard.embed('#container', { token, view: 'full' });
</script>`;

const downloadSdk = () => {
  const sdkUrl = `${window.location.origin}/oem/sdk.js`;
  const a = document.createElement('a');
  a.href = sdkUrl;
  a.download = 'jianzhi-oem-sdk.js';
  a.click();
};

export default function OemConsolePanel() {
  const [apps, setApps] = useState<OemApp[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState('');
  const [editApp, setEditApp] = useState<OemApp | null>(null);   // null=未打开；{}空对象=新建
  const [showForm, setShowForm] = useState(false);
  const [secretReveal, setSecretReveal] = useState<{ appId: string; secret: string } | null>(null);
  const [usageFor, setUsageFor] = useState<{ app: OemApp; rows: UsageRow[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [a, u] = await Promise.all([
      fetch(`${MAIN_URL}/api/admin/oem/apps`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []).catch(() => []),
      fetch(`${MAIN_URL}/api/users`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);
    setApps(Array.isArray(a) ? a : []);
    setUsers(Array.isArray(u) ? u : []);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const openNew = () => {
    setEditApp({
      id: '', appId: '', name: '', bearerUserId: users[0]?.id || '',
      scope: ['chat:use', 'dash:view'], mcpBindings: [{ mcp_name: '', label: '', schema_hint: '', is_default: true }],
      branding: { primary: '1677ff', brandName: '', hideJianzhiMark: false },
      allowedOrigins: [], cachePolicy: 'on', rateLimit: { tokenPerMin: 30, msgPerMin: 20, msgPerDay: 2000 },
      status: 'active', createdAt: '',
    } as OemApp);
    setShowForm(true);
  };

  const save = async (form: OemApp, originsText: string) => {
    const body: any = {
      name: form.name, scope: form.scope,
      mcpBindings: form.mcpBindings.filter(b => b.mcp_name.trim()),
      branding: form.branding,
      allowedOrigins: originsText.split(',').map(s => s.trim()).filter(Boolean),
      cachePolicy: form.cachePolicy, rateLimit: form.rateLimit,
    };
    if (!form.id) {
      body.bearerUserId = form.bearerUserId;
      const res = await fetch(`${MAIN_URL}/api/admin/oem/apps`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
      if (!res.ok) { flash('创建失败：' + (await res.text())); return; }
      const { app, appSecret } = await res.json();
      setSecretReveal({ appId: app.appId, secret: appSecret });
    } else {
      const res = await fetch(`${MAIN_URL}/api/admin/oem/apps/${form.id}`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify(body) });
      if (!res.ok) { flash('保存失败'); return; }
      flash('已保存');
    }
    setShowForm(false); setEditApp(null);
    load();
  };

  const rotate = async (app: OemApp) => {
    if (!(await confirmDialog(`轮换 ${app.name} 的密钥？旧密钥立即失效。`, { danger: true }))) return;
    const res = await fetch(`${MAIN_URL}/api/admin/oem/apps/${app.id}/rotate-secret`, { method: 'POST', headers: authHeaders() });
    if (!res.ok) { flash('轮换失败'); return; }
    const { appSecret } = await res.json();
    setSecretReveal({ appId: app.appId, secret: appSecret });
  };

  const toggleStatus = async (app: OemApp) => {
    const status = app.status === 'active' ? 'suspended' : 'active';
    await fetch(`${MAIN_URL}/api/admin/oem/apps/${app.id}/status`, { method: 'PUT', headers: authHeaders(), body: JSON.stringify({ status }) });
    load();
  };

  const showUsage = async (app: OemApp) => {
    const rows = await fetch(`${MAIN_URL}/api/admin/oem/apps/${app.id}/usage`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []).catch(() => []);
    setUsageFor({ app, rows: Array.isArray(rows) ? rows : [] });
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h2 className="text-lg font-semibold">OEM 接入管理</h2>
          <p className="text-xs text-gray-400 mt-0.5">第三方系统通过凭据换取 token，白标嵌入数据大师面板（需专业版）</p>
        </div>
        <div className="flex gap-2">
          <button onClick={downloadSdk} className="px-3 py-2 border border-gray-200 text-gray-600 rounded-lg text-sm hover:bg-gray-50">
            ⬇ 下载 SDK
          </button>
          <button onClick={openNew} className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm hover:bg-indigo-700">+ 新建接入方</button>
        </div>
      </div>
      {msg && <div className="mb-3 text-sm text-indigo-600 bg-indigo-50 rounded px-3 py-2">{msg}</div>}

      {loading ? <div className="text-gray-300 text-sm">加载中…</div> : apps.length === 0 ? (
        <div className="text-center text-gray-300 py-16">
          <div className="text-4xl mb-3">🔌</div>
          <div className="text-sm">还没有接入方</div>
          <div className="text-xs mt-1">点击「新建接入方」为第三方系统创建凭据</div>
        </div>
      ) : (
        <div className="space-y-3">
          {apps.map(app => (
            <div key={app.id} className="border border-gray-100 rounded-lg p-4 hover:shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{app.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${app.status === 'active' ? 'bg-green-50 text-green-600' : 'bg-gray-100 text-gray-400'}`}>
                      {app.status === 'active' ? '启用' : '已停用'}
                    </span>
                  </div>
                  <div className="text-xs text-gray-400 mt-1 font-mono">{app.appId}</div>
                  <div className="text-xs text-gray-500 mt-1.5">
                    数据源 {app.mcpBindings?.length || 0} 个 · 权限 {app.scope?.join('/') || '—'} · 缓存 {app.cachePolicy === 'off' ? '关' : '开'}
                  </div>
                </div>
                <div className="flex gap-2 text-xs">
                  <button onClick={() => showUsage(app)} className="text-gray-500 hover:text-indigo-600">用量</button>
                  <button onClick={() => { setEditApp(app); setShowForm(true); }} className="text-gray-500 hover:text-indigo-600">编辑</button>
                  <button onClick={() => rotate(app)} className="text-gray-500 hover:text-amber-600">轮换密钥</button>
                  <button onClick={() => toggleStatus(app)} className="text-gray-500 hover:text-red-600">{app.status === 'active' ? '停用' : '启用'}</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showForm && editApp && (
        <AppForm app={editApp} users={users} onCancel={() => { setShowForm(false); setEditApp(null); }} onSave={save} />
      )}
      {secretReveal && <SecretModal data={secretReveal} embedHint={EMBED_HINT} onClose={() => setSecretReveal(null)} />}
      {usageFor && <UsageModal data={usageFor} onClose={() => setUsageFor(null)} />}
    </div>
  );
}

function AppForm({ app, users, onCancel, onSave }: {
  app: OemApp; users: UserItem[]; onCancel: () => void; onSave: (a: OemApp, origins: string) => void;
}) {
  const [form, setForm] = useState<OemApp>(JSON.parse(JSON.stringify(app)));
  const [originsText, setOriginsText] = useState((app.allowedOrigins || []).join(', '));
  const set = (patch: Partial<OemApp>) => setForm(f => ({ ...f, ...patch }));
  const setBinding = (i: number, patch: Partial<McpBinding>) =>
    setForm(f => ({ ...f, mcpBindings: f.mcpBindings.map((b, j) => j === i ? { ...b, ...patch } : (patch.is_default ? { ...b, is_default: false } : b)) }));
  const rl = form.rateLimit || {};

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={onCancel}>
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[88vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-4">{form.id ? '编辑接入方' : '新建接入方'}</h3>

        <Field label="名称">
          <input className="inp" value={form.name} onChange={e => set({ name: e.target.value })} placeholder="例如：XX 客户 ERP" />
        </Field>

        {!form.id && (
          <Field label="承载用户（数据可见范围）">
            <select className="inp" value={form.bearerUserId} onChange={e => set({ bearerUserId: e.target.value })}>
              {users.map(u => <option key={u.id} value={u.id}>{u.name}（{u.email}）</option>)}
            </select>
          </Field>
        )}

        <Field label="权限范围">
          <div className="flex gap-4">
            {ALL_SCOPES.map(s => (
              <label key={s.id} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={form.scope.includes(s.id)}
                  onChange={e => set({ scope: e.target.checked ? [...form.scope, s.id] : form.scope.filter(x => x !== s.id) })} />
                {s.label}
              </label>
            ))}
          </div>
        </Field>

        <Field label="绑定数据源（MCP）">
          <div className="space-y-2">
            {form.mcpBindings.map((b, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input className="inp flex-1" value={b.mcp_name} onChange={e => setBinding(i, { mcp_name: e.target.value })} placeholder="mcp_name（已注册的MCP源名）" />
                <input className="inp w-28" value={b.label || ''} onChange={e => setBinding(i, { label: e.target.value })} placeholder="展示名" />
                <input className="inp flex-1" value={b.schema_hint || ''} onChange={e => setBinding(i, { schema_hint: e.target.value })} placeholder="结构提示（订单/库存…）" />
                <label className="text-xs flex items-center gap-1"><input type="radio" name="def" checked={!!b.is_default} onChange={() => setBinding(i, { is_default: true })} />默认</label>
                <button onClick={() => set({ mcpBindings: form.mcpBindings.filter((_, j) => j !== i) })} className="text-gray-300 hover:text-red-500">✕</button>
              </div>
            ))}
            <button onClick={() => set({ mcpBindings: [...form.mcpBindings, { mcp_name: '', label: '', schema_hint: '' }] })} className="text-xs text-indigo-600">+ 添加数据源</button>
          </div>
        </Field>

        <Field label="白标">
          <div className="flex gap-3 items-center flex-wrap">
            <span className="text-xs text-gray-400">主色#</span>
            <input className="inp w-24" value={form.branding?.primary || ''} onChange={e => set({ branding: { ...form.branding, primary: e.target.value } })} placeholder="1677ff" />
            <input className="inp w-40" value={form.branding?.brandName || ''} onChange={e => set({ branding: { ...form.branding, brandName: e.target.value } })} placeholder="品牌名" />
            <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={!!form.branding?.hideJianzhiMark} onChange={e => set({ branding: { ...form.branding, hideJianzhiMark: e.target.checked } })} />隐藏见智标识</label>
          </div>
        </Field>

        <Field label="允许的父域（iframe，逗号分隔，留空=不限）">
          <input className="inp" value={originsText} onChange={e => setOriginsText(e.target.value)} placeholder="https://erp.client.com, https://mes.client.com" />
        </Field>

        <Field label="限流 / 配额">
          <div className="flex gap-3 items-center flex-wrap text-sm">
            <span className="text-xs text-gray-400">token/分</span>
            <input className="inp w-20" type="number" value={rl.tokenPerMin ?? ''} onChange={e => set({ rateLimit: { ...rl, tokenPerMin: Number(e.target.value) || undefined } })} />
            <span className="text-xs text-gray-400">消息/分</span>
            <input className="inp w-20" type="number" value={rl.msgPerMin ?? ''} onChange={e => set({ rateLimit: { ...rl, msgPerMin: Number(e.target.value) || undefined } })} />
            <span className="text-xs text-gray-400">消息/日</span>
            <input className="inp w-24" type="number" value={rl.msgPerDay ?? ''} onChange={e => set({ rateLimit: { ...rl, msgPerDay: Number(e.target.value) || undefined } })} />
          </div>
        </Field>

        <Field label="数据缓存">
          <select className="inp w-40" value={form.cachePolicy} onChange={e => set({ cachePolicy: e.target.value as any })}>
            <option value="on">开（缓存结果）</option>
            <option value="off">关（实时回查，合规）</option>
          </select>
        </Field>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 rounded-lg">取消</button>
          <button onClick={() => onSave(form, originsText)} disabled={!form.name} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">保存</button>
        </div>
      </div>
      <style jsx>{`.inp { border: 1px solid #e5e7eb; border-radius: 6px; padding: 6px 8px; font-size: 13px; }`}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <label className="block text-xs font-medium text-gray-500 mb-1.5">{label}</label>
      {children}
    </div>
  );
}

function SecretModal({ data, embedHint, onClose }: { data: { appId: string; secret: string }; embedHint: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = () => {
    const text = `app_id=${data.appId}\napp_secret=${data.secret}`;

    // 方法 1: 现代浏览器 Clipboard API (HTTPS 或 localhost)
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => {
        // 失败则尝试方法 2
        fallbackCopy(text);
      });
    } else {
      // 方法 2: 传统 document.execCommand (兼容 HTTP 环境)
      fallbackCopy(text);
    }
  };

  const fallbackCopy = (text: string) => {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      const successful = document.execCommand('copy');
      if (successful) {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } else {
        console.error('复制失败');
      }
    } catch (err) {
      console.error('复制失败:', err);
    }
    document.body.removeChild(textArea);
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-lg p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-1">凭据已生成</h3>
        <p className="text-xs text-amber-600 mb-4">⚠️ app_secret 仅此一次明文显示，请立即保存到客户后端。关闭后无法再查看。</p>
        <div className="space-y-2 text-sm">
          <div><span className="text-gray-400 text-xs">app_id</span><div className="font-mono bg-gray-50 rounded px-3 py-2 mt-1 break-all">{data.appId}</div></div>
          <div><span className="text-gray-400 text-xs">app_secret</span><div className="font-mono bg-gray-50 rounded px-3 py-2 mt-1 break-all">{data.secret}</div></div>
        </div>
        <div className="mt-4">
          <span className="text-gray-400 text-xs">前端嵌入示例</span>
          <pre className="bg-gray-900 text-gray-100 text-xs rounded p-3 mt-1 overflow-x-auto whitespace-pre-wrap">{embedHint}</pre>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={copyToClipboard} className={`px-3 py-1.5 text-sm rounded-lg ${copied ? 'bg-green-100 text-green-700' : 'text-indigo-600 hover:bg-indigo-50'}`}>
            {copied ? '✓ 已复制' : '复制凭据'}
          </button>
          <button onClick={onClose} className="px-4 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 ml-2">我已保存</button>
        </div>
      </div>
    </div>
  );
}

function UsageModal({ data, onClose }: { data: { app: OemApp; rows: UsageRow[] }; onClose: () => void }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
        <h3 className="text-base font-semibold mb-4">用量 — {data.app.name}</h3>
        {data.rows.length === 0 ? <div className="text-sm text-gray-400">暂无用量记录</div> : (
          <div className="space-y-2">
            {data.rows.map(r => (
              <div key={r.metric} className="flex justify-between text-sm border-b border-gray-50 pb-2">
                <span className="text-gray-500">{METRIC_LABELS[r.metric] || r.metric}</span>
                <span className="font-mono font-medium">{r.total.toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex justify-end mt-5"><button onClick={onClose} className="px-4 py-1.5 text-sm bg-gray-100 rounded-lg hover:bg-gray-200">关闭</button></div>
      </div>
    </div>
  );
}
