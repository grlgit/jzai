'use client';

import { useState } from 'react';
import { useI18n } from '@/i18n';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface AuthField {
  key: string;
  label: string;
  type?: string;    // 'password' | 'text'
  required?: boolean;
}

interface CredentialFormProps {
  name: string;           // connector display name
  credSystem: string;     // system key for CredentialService
  authFields?: AuthField[] | null;  // from manifest auth.fields
  userId: string;
  credentials: Record<string, Record<string, string>>;  // all user credentials
  onSaved: () => void;    // refresh callback
  scope?: 'global' | 'user';  // credential scope
  isAdmin?: boolean;           // whether current user is admin
}

export default function CredentialForm({ name, credSystem, authFields, userId, credentials, onSaved, scope = 'user', isAdmin = false }: CredentialFormProps) {
  const { t } = useI18n();
  const existing = credentials[credSystem] || null;

  // Dynamic form state: key-value pairs
  const [fields, setFields] = useState<Record<string, string>>(() => {
    if (existing) return { ...existing };
    if (authFields?.length) {
      const init: Record<string, string> = {};
      for (const f of authFields) init[f.key] = '';
      return init;
    }
    return {};
  });

  // For free-form mode (no authFields): new key input
  const [newKey, setNewKey] = useState('');
  const [showSecrets, setShowSecrets] = useState(false);

  const isSensitive = (key: string) => /password|secret|key|token/i.test(key);

  const isGlobal = scope === 'global';
  const readOnly = isGlobal && !isAdmin;

  const save = async () => {
    if (readOnly) return;
    const cleaned: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (v) cleaned[k] = v;
    }
    if (Object.keys(cleaned).length === 0) return;

    if (isGlobal) {
      await fetch(`${MAIN_URL}/api/skills/credentials/global/save`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ systemName: credSystem, credentials: cleaned }),
      });
    } else {
      await fetch(`${MAIN_URL}/api/skills/credentials/save`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ userId, systemName: credSystem, credentials: cleaned }),
      });
    }
    onSaved();
  };

  const remove = async () => {
    if (readOnly) return;
    if (isGlobal) {
      await fetch(`${MAIN_URL}/api/skills/credentials/global/${encodeURIComponent(credSystem)}`, {
        method: 'DELETE', headers: authHeaders(),
      });
    } else {
      await fetch(`${MAIN_URL}/api/skills/credentials/${encodeURIComponent(credSystem)}?userId=${userId}`, {
        method: 'DELETE', headers: authHeaders(),
      });
    }
    setFields(authFields?.length ? Object.fromEntries(authFields.map(f => [f.key, ''])) : {});
    onSaved();
  };

  const addField = () => {
    if (!newKey || fields[newKey] !== undefined) return;
    setFields(prev => ({ ...prev, [newKey]: '' }));
    setNewKey('');
  };

  const removeField = (key: string) => {
    setFields(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const hasStructuredFields = authFields && authFields.length > 0;

  return (
    <div className="h-full overflow-y-auto p-5 max-w-lg">
      <h3 className="text-sm font-semibold mb-1">
        <span className="text-gray-800">{name}</span>
        <span className="text-gray-400 font-normal ml-2 text-xs">系统: {credSystem}</span>
      </h3>
      <p className="text-xs text-gray-400 mb-4">
        {isGlobal
          ? '🌐 全局凭证 — 所有用户调用该连接时共享此凭证。' + (readOnly ? '（仅管理员可编辑）' : '')
          : '此凭证在调用该连接时自动注入，按用户隔离。'}
      </p>

      {/* Status */}
      {existing ? (
        <div className="border border-gray-200 rounded-lg p-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-green-600">✓ 已配置</span>
            <div className="flex items-center gap-2">
              <button onClick={() => setShowSecrets(!showSecrets)}
                className="text-xs text-gray-400 hover:text-gray-600">
                {showSecrets ? '🙈 隐藏' : '👁 显示'}
              </button>
              <button onClick={remove} className="text-xs text-red-400 hover:text-red-600">{t('common.delete')}</button>
            </div>
          </div>
          <div className="space-y-1.5 text-sm">
            {Object.entries(existing).map(([k, v]) => (
              <div key={k} className="flex items-center gap-2">
                <span className="text-xs text-gray-400 w-24 shrink-0">{hasStructuredFields ? (authFields!.find(f => f.key === k)?.label || k) : k}</span>
                <span className="text-gray-600 font-mono text-xs">{isSensitive(k) && !showSecrets ? '••••••••' : v}</span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="border border-amber-200 rounded-lg p-3 mb-4 bg-amber-50/50">
          <span className="text-xs text-amber-600">⚠ 未配置凭证，调用时将需要手动提供登录信息</span>
        </div>
      )}

      {/* Form */}
      <form onSubmit={(e) => { e.preventDefault(); save(); }} className="border border-gray-200 rounded-lg p-4 space-y-3">
        <div className="text-xs font-medium text-gray-500">{existing ? '更新凭证' : '配置凭证'}</div>

        {hasStructuredFields ? (
          /* Structured mode: render from auth.fields */
          authFields!.map(f => (
            <div key={f.key}>
              <label className="block text-xs text-gray-500 mb-1">
                {f.label}{f.required ? <span className="text-red-400 ml-0.5">*</span> : ''}
              </label>
              <input
                type={f.type === 'password' && !showSecrets ? 'password' : 'text'}
                value={fields[f.key] || ''}
                onChange={e => setFields(prev => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={existing?.[f.key] ? '(已配置，留空保持不变)' : ''}
                className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-400"
              />
            </div>
          ))
        ) : (
          /* Free-form mode: dynamic key-value pairs */
          <>
            {Object.entries(fields).map(([k]) => (
              <div key={k} className="flex items-center gap-2">
                <span className="text-xs text-gray-500 w-24 shrink-0">{k}</span>
                <input
                  type={isSensitive(k) && !showSecrets ? 'password' : 'text'}
                  value={fields[k]}
                  onChange={e => setFields(prev => ({ ...prev, [k]: e.target.value }))}
                  placeholder={existing?.[k] ? '(已配置)' : ''}
                  className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-400"
                />
                <button type="button" onClick={() => removeField(k)} className="text-xs text-gray-300 hover:text-red-400">✕</button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input value={newKey} onChange={e => setNewKey(e.target.value)}
                placeholder="字段名 (如 api_key)"
                className="w-24 shrink-0 border border-gray-200 rounded px-2 py-1.5 text-xs focus:outline-none focus:border-indigo-400"
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addField(); } }}
              />
              <button type="button" onClick={addField} disabled={!newKey}
                className="text-xs text-indigo-500 hover:text-indigo-700 disabled:text-gray-300">+ 添加字段</button>
            </div>
          </>
        )}

        {!readOnly && (
          <button type="submit"
            disabled={hasStructuredFields ? authFields!.filter(f => f.required).some(f => !fields[f.key] && !existing?.[f.key]) : Object.values(fields).every(v => !v)}
            className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-40">
            {existing ? '更新' : '保存'}
          </button>
        )}
      </form>
    </div>
  );
}
