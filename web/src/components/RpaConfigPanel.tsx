'use client';

import { useState, useEffect, useCallback } from 'react';

import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface SystemTool {
  name: string; description: string; parameters: Record<string, any>;
  rpa_skill: string; data_template: string;
}
interface SystemConfig {
  name: string; description: string; baseUrl: string;
  auth?: { type: string; loginUrl: string; fields: Record<string, string>; submitButton: string; credentials: Record<string, string> };
  tools: SystemTool[];
}
interface TemplateInfo { key: string; name: string; description: string }

export default function RpaConfigPanel() {
  const [tab, setTab] = useState<'systems' | 'templates'>('systems');
  const [systems, setSystems] = useState<SystemConfig[]>([]);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [editSystem, setEditSystem] = useState<SystemConfig | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const [s, t] = await Promise.all([
      fetch(`${MAIN_URL}/api/systems`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${MAIN_URL}/api/templates`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
    ]);
    setSystems(Array.isArray(s) ? s : []);
    setTemplates(Array.isArray(t) ? t : []);
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  const saveSystem = async (data: SystemConfig) => {
    const method = editSystem ? 'PUT' : 'POST';
    const url = editSystem ? `${MAIN_URL}/api/systems/${encodeURIComponent(editSystem.name)}` : `${MAIN_URL}/api/systems`;
    const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(data) });
    if (res.ok) { flash('✅ 系统已保存'); setShowEditor(false); setEditSystem(null); load(); }
    else flash('❌ 保存失败');
  };

  const deleteSystem = async (name: string) => {
    if (!(await confirmDialog(`确认删除 ${name}？`, { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/systems/${encodeURIComponent(name)}`, { method: 'DELETE', headers: authHeaders() });
    flash('✅ 已删除'); load();
  };

  return (
    <div className="p-6 overflow-y-auto h-full">
      {msg && <div className="mb-4 text-sm px-3 py-2 bg-gray-50 rounded-lg">{msg}</div>}

      <div className="flex gap-2 mb-6">
        <button onClick={() => setTab('systems')} className={`px-4 py-1.5 rounded-lg text-sm font-medium ${tab === 'systems' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:bg-gray-50'}`}>集成系统</button>
        <button onClick={() => setTab('templates')} className={`px-4 py-1.5 rounded-lg text-sm font-medium ${tab === 'templates' ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:bg-gray-50'}`}>数据模板</button>
      </div>

      {/* Systems Tab */}
      {tab === 'systems' && !showEditor && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold">已注册系统 ({systems.length})</h3>
            <button onClick={() => { setEditSystem(null); setShowEditor(true); }} className="px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-lg hover:bg-indigo-700">+ 添加系统</button>
          </div>
          <div className="space-y-3">
            {systems.map(sys => (
              <div key={sys.name} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="font-medium text-sm">{sys.name}</span>
                    <span className="text-xs text-gray-400 ml-2">{sys.baseUrl}</span>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => { setEditSystem(sys); setShowEditor(true); }} className="text-xs text-gray-400 hover:text-gray-600">编辑</button>
                    <button onClick={() => deleteSystem(sys.name)} className="text-xs text-red-400 hover:text-red-600">删除</button>
                  </div>
                </div>
                <div className="text-xs text-gray-500 mb-2">{sys.description}</div>
                <div className="text-xs text-gray-400 mb-1">登录方式：{sys.auth?.type || '无'} {sys.auth ? `(${sys.auth.credentials?.username || '—'})` : ''}</div>
                <div className="text-xs text-gray-400 mb-2">操作 ({sys.tools.length})：</div>
                <div className="flex flex-wrap gap-1">
                  {sys.tools.map(t => (
                    <span key={t.name} className="px-2 py-0.5 bg-gray-100 rounded text-[11px] text-gray-600" title={t.description}>{t.name}</span>
                  ))}
                </div>
              </div>
            ))}
            {systems.length === 0 && <div className="text-sm text-gray-400 text-center py-8">暂无注册系统，点击"添加系统"开始配置</div>}
          </div>
        </div>
      )}

      {/* System Editor */}
      {tab === 'systems' && showEditor && (
        <SystemEditor
          initial={editSystem}
          onSave={saveSystem}
          onCancel={() => { setShowEditor(false); setEditSystem(null); }}
        />
      )}

      {/* Templates Tab */}
      {tab === 'templates' && (
        <div>
          <h3 className="text-sm font-semibold mb-4">数据映射模板 ({templates.length})</h3>
          <div className="space-y-2">
            {templates.map(tpl => (
              <div key={tpl.key} className="border border-gray-200 rounded-lg p-3 flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium">{tpl.name}</div>
                  <div className="text-xs text-gray-400">{tpl.key} · {tpl.description}</div>
                </div>
                <span className="text-xs text-gray-400">YAML配置</span>
              </div>
            ))}
            {templates.length === 0 && <div className="text-sm text-gray-400 text-center py-8">暂无数据模板</div>}
          </div>
          <div className="mt-4 p-3 bg-gray-50 rounded-lg text-xs text-gray-500">
            数据模板定义在 config/templates/ 目录下的YAML文件中，定义附件字段→系统字段的映射规则。
          </div>
        </div>
      )}
    </div>
  );
}

// ===== System Editor Component =====
function SystemEditor({ initial, onSave, onCancel }: {
  initial: SystemConfig | null;
  onSave: (data: SystemConfig) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || '');
  const [authType, setAuthType] = useState(initial?.auth?.type || 'none');
  const [loginUrl, setLoginUrl] = useState(initial?.auth?.loginUrl || '');
  const [usernameSelector, setUsernameSelector] = useState(initial?.auth?.fields?.username || '');
  const [passwordSelector, setPasswordSelector] = useState(initial?.auth?.fields?.password || '');
  const [submitSelector, setSubmitSelector] = useState(initial?.auth?.submitButton || '');
  const [credUser, setCredUser] = useState(initial?.auth?.credentials?.username || '');
  const [credPass, setCredPass] = useState(initial?.auth?.credentials?.password || '');
  const [tools, setTools] = useState<SystemTool[]>(initial?.tools || []);

  const addTool = () => {
    setTools([...tools, { name: '', description: '', parameters: {}, rpa_skill: '', data_template: '' }]);
  };

  const updateTool = (idx: number, field: string, value: any) => {
    const updated = [...tools];
    (updated[idx] as any)[field] = value;
    setTools(updated);
  };

  const removeTool = (idx: number) => {
    setTools(tools.filter((_, i) => i !== idx));
  };

  const handleSave = () => {
    const data: SystemConfig = {
      name, description, baseUrl, tools,
      auth: authType !== 'none' ? {
        type: authType, loginUrl,
        fields: { username: usernameSelector, password: passwordSelector },
        submitButton: submitSelector,
        credentials: { username: credUser, password: credPass },
      } : undefined,
    };
    onSave(data);
  };

  const inputCls = "w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500";
  const labelCls = "block text-xs text-gray-500 mb-1";

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <button onClick={onCancel} className="text-xs text-indigo-600 hover:underline">← 返回列表</button>
        <h3 className="text-sm font-semibold">{initial ? '编辑系统' : '添加系统'}</h3>
      </div>

      <div className="space-y-4">
        {/* Basic Info */}
        <div className="border border-gray-200 rounded-lg p-4">
          <h4 className="text-xs font-semibold text-gray-600 mb-3">基本信息</h4>
          <div className="grid grid-cols-2 gap-3">
            <div><label className={labelCls}>系统名称 *</label><input className={inputCls} value={name} onChange={e => setName(e.target.value)} placeholder="如：ERP系统" /></div>
            <div><label className={labelCls}>系统地址 *</label><input className={inputCls} value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://erp.company.com" /></div>
          </div>
          <div className="mt-3"><label className={labelCls}>系统描述</label><input className={inputCls} value={description} onChange={e => setDescription(e.target.value)} placeholder="管理订单、库存等" /></div>
        </div>

        {/* Auth */}
        <div className="border border-gray-200 rounded-lg p-4">
          <h4 className="text-xs font-semibold text-gray-600 mb-3">登录认证</h4>
          <div className="mb-3">
            <label className={labelCls}>认证方式</label>
            <select className={inputCls} style={{ maxWidth: 200 }} value={authType} onChange={e => setAuthType(e.target.value)}>
              <option value="none">无需登录</option>
              <option value="form">表单登录</option>
              <option value="sso">SSO</option>
            </select>
          </div>
          {authType !== 'none' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>登录页面路径</label><input className={inputCls} value={loginUrl} onChange={e => setLoginUrl(e.target.value)} placeholder="/login" /></div>
                <div><label className={labelCls}>提交按钮选择器</label><input className={inputCls} value={submitSelector} onChange={e => setSubmitSelector(e.target.value)} placeholder="button[type='submit']" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>用户名输入框选择器</label><input className={inputCls} value={usernameSelector} onChange={e => setUsernameSelector(e.target.value)} placeholder="#username" /></div>
                <div><label className={labelCls}>密码输入框选择器</label><input className={inputCls} value={passwordSelector} onChange={e => setPasswordSelector(e.target.value)} placeholder="#password" /></div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className={labelCls}>登录账号</label><input className={inputCls} value={credUser} onChange={e => setCredUser(e.target.value)} /></div>
                <div><label className={labelCls}>登录密码</label><input className={inputCls} type="password" value={credPass} onChange={e => setCredPass(e.target.value)} /></div>
              </div>
            </div>
          )}
        </div>

        {/* Tools/Operations */}
        <div className="border border-gray-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-xs font-semibold text-gray-600">可用操作 ({tools.length})</h4>
            <button onClick={addTool} className="text-xs text-indigo-600 hover:underline">+ 添加操作</button>
          </div>
          <div className="space-y-3">
            {tools.map((tool, idx) => (
              <div key={idx} className="bg-gray-50 rounded-lg p-3">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-xs text-gray-400">操作 #{idx + 1}</span>
                  <button onClick={() => removeTool(idx)} className="text-xs text-red-400 hover:text-red-600">删除</button>
                </div>
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div><label className={labelCls}>操作ID</label><input className={inputCls} value={tool.name} onChange={e => updateTool(idx, 'name', e.target.value)} placeholder="create_order" /></div>
                  <div><label className={labelCls}>数据模板Key</label><input className={inputCls} value={tool.data_template} onChange={e => updateTool(idx, 'data_template', e.target.value)} placeholder="erp/create_order" /></div>
                </div>
                <div className="mb-2"><label className={labelCls}>操作描述（Agent据此判断何时调用，不要写关键词）</label>
                  <textarea className={inputCls + ' resize-none'} rows={2} value={tool.description} onChange={e => updateTool(idx, 'description', e.target.value)}
                    placeholder="录入销售订单。当用户提到下单、录订单、某客户下了某产品时调用" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Save */}
        <div className="flex gap-3">
          <button onClick={handleSave} disabled={!name || !baseUrl} className="px-6 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50">保存</button>
          <button onClick={onCancel} className="px-4 py-2 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">取消</button>
        </div>
      </div>
    </div>
  );
}
