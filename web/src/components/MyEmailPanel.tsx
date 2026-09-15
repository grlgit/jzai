'use client';

import { useState, useCallback, useEffect } from 'react';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

const EMAIL_PASSWORD_HINTS: Record<string, string> = {
  '163': '网易163/126：请填写授权码（非登录密码），在邮箱设置 → POP3/SMTP 中开启并获取',
  'gmail': 'Gmail：需开启两步验证后生成应用专用密码',
  'qq': 'QQ邮箱：请填写授权码，在设置 → 账户 → POP3/IMAP/SMTP 中生成',
  'exmail': '腾讯企业邮：需在管理后台生成客户端专用密码',
  'outlook': 'Outlook：需在安全设置中生成应用密码',
};

function getPasswordHint(serverName: string): string | null {
  if (!serverName) return null;
  const n = serverName.toLowerCase();
  if (n.includes('163') || n.includes('126') || n.includes('网易')) return EMAIL_PASSWORD_HINTS['163'];
  if (n.includes('gmail')) return EMAIL_PASSWORD_HINTS['gmail'];
  if (n.includes('企业邮') || n.includes('exmail')) return EMAIL_PASSWORD_HINTS['exmail'];
  if (n.includes('qq')) return EMAIL_PASSWORD_HINTS['qq'];
  if (n.includes('outlook')) return EMAIL_PASSWORD_HINTS['outlook'];
  return null;
}

const EMPTY_FORM = { label: '', email_address: '', server_id: '', password: '', is_default: false };

export default function MyEmailPanel({ onClose }: { onClose: () => void }) {
  const MAIN_URL = getMainUrl();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [saveMsg, setSaveMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [accRes, srvRes] = await Promise.all([
        fetch(`${MAIN_URL}/api/email/accounts`, { headers: authHeaders() }),
        fetch(`${MAIN_URL}/api/email/servers/available`, { headers: authHeaders() }),
      ]);
      setAccounts(await accRes.json());
      setServers(await srvRes.json());
    } catch {}
    setLoading(false);
  }, [MAIN_URL]);

  useEffect(() => { load(); }, [load]);

  const selectedServer = servers.find((s: any) => s.id === form.server_id);
  const hint = selectedServer ? getPasswordHint(selectedServer.name) : null;

  const handleSave = async () => {
    setSaveMsg('');
    try {
      const url = editId ? `${MAIN_URL}/api/email/accounts/${editId}` : `${MAIN_URL}/api/email/accounts`;
      const method = editId ? 'PUT' : 'POST';
      const body: any = { ...form };
      if (editId && !body.password) delete body.password;
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(body) });
      if (res.ok) {
        setShowForm(false); setEditId(null); setForm({ ...EMPTY_FORM }); load();
      } else {
        const data = await res.json();
        setSaveMsg(data.message || '保存失败');
      }
    } catch { setSaveMsg('保存失败'); }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('确认删除此邮箱账号？', { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/email/accounts/${id}`, { method: 'DELETE', headers: authHeaders() });
    load();
  };

  const handleTest = async (id: string) => {
    setTestMsg(prev => ({ ...prev, [id]: '测试中...' }));
    try {
      const res = await fetch(`${MAIN_URL}/api/email/accounts/${id}/test`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      setTestMsg(prev => ({ ...prev, [id]: data.success ? `✅ ${data.message}` : `❌ ${data.message}` }));
    } catch {
      setTestMsg(prev => ({ ...prev, [id]: '❌ 测试失败' }));
    }
    setTimeout(() => setTestMsg(prev => { const n = { ...prev }; delete n[id]; return n; }), 6000);
  };

  const startEdit = (a: any) => {
    setEditId(a.id);
    setForm({ label: a.label, email_address: a.email_address, server_id: a.server_id || '', password: '', is_default: a.is_default });
    setShowForm(true);
  };

  const getServerName = (id: string) => servers.find((s: any) => s.id === id)?.name || '-';

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-[100]" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-gray-100 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">我的邮箱</h2>
            <p className="text-xs text-gray-400 mt-0.5">配置邮箱后，AI 助手可帮您收发邮件</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setEditId(null); setForm({ ...EMPTY_FORM }); setShowForm(true); }}
              className="px-3 py-1 text-xs border border-indigo-200 text-indigo-600 rounded-lg hover:bg-indigo-50">
              + 添加邮箱
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg px-1">&times;</button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {loading ? (
            <div className="text-sm text-gray-400 text-center py-8 animate-pulse">加载中...</div>
          ) : servers.length === 0 ? (
            <div className="text-sm text-gray-400 text-center py-8 border border-dashed border-gray-200 rounded-lg">
              管理员尚未配置邮件服务器，请联系管理员在设置「邮件」页面中配置
            </div>
          ) : accounts.length === 0 && !showForm ? (
            <div className="text-sm text-gray-400 text-center py-8 border border-dashed border-gray-200 rounded-lg">
              暂未配置邮箱账号，点击上方按钮添加
            </div>
          ) : (
            <div className="space-y-2">
              {accounts.map((a: any) => (
                <div key={a.id} className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-200">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{a.email_address}</span>
                      {a.label && <span className="text-xs text-gray-400">({a.label})</span>}
                      {a.is_default && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600">默认</span>}
                    </div>
                    <div className="text-xs text-gray-400">
                      服务器: {a.server_id ? getServerName(a.server_id) : '未配置'}
                    </div>
                  </div>
                  {testMsg[a.id] && <span className="text-xs shrink-0">{testMsg[a.id]}</span>}
                  <button onClick={() => handleTest(a.id)} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0">测试</button>
                  <button onClick={() => startEdit(a)} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0">编辑</button>
                  <button onClick={() => handleDelete(a.id)} className="text-xs text-gray-400 hover:text-red-500 shrink-0">删除</button>
                </div>
              ))}
            </div>
          )}

          {showForm && (
            <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50/30">
              <h4 className="text-sm font-semibold mb-3">{editId ? '编辑邮箱' : '添加邮箱'}</h4>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">邮箱地址 *</label>
                    <input value={form.email_address} onChange={e => setForm({ ...form, email_address: e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="user@example.com" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">别名</label>
                    <input value={form.label} onChange={e => setForm({ ...form, label: e.target.value })}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="如：工作邮箱" />
                  </div>
                </div>

                <div>
                  <label className="block text-xs text-gray-500 mb-1">邮件服务器</label>
                  <select value={form.server_id} onChange={e => setForm({ ...form, server_id: e.target.value })}
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                    <option value="">请选择...</option>
                    {servers.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>

                <div>
                  <label className="block text-xs text-gray-500 mb-1">密码 / 授权码 {editId ? '(留空则不修改)' : '*'}</label>
                  <input type="password" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })}
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500"
                    placeholder={editId ? '留空保持不变' : '邮箱密码或授权码'} />
                  {hint && <p className="text-[11px] text-amber-600 mt-1 bg-amber-50 rounded px-2 py-1">{hint}</p>}
                </div>

                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={form.is_default} onChange={e => setForm({ ...form, is_default: e.target.checked })}
                    className="rounded border-gray-300 text-indigo-600" />
                  <span className="text-sm text-gray-600">设为默认邮箱（AI 发邮件时优先使用）</span>
                </label>
              </div>

              <div className="flex items-center gap-3 mt-4">
                <button onClick={handleSave} disabled={!form.email_address || (!editId && !form.password)}
                  className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                  {editId ? '保存修改' : '添加'}
                </button>
                <button onClick={() => { setShowForm(false); setEditId(null); setSaveMsg(''); }}
                  className="px-4 py-1.5 text-sm text-gray-500 hover:text-gray-700">取消</button>
                {saveMsg && <span className="text-sm text-red-500">{saveMsg}</span>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
