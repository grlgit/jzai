'use client';

import { useState } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

interface AdminPasswordStepProps {
  onComplete: () => void;
}

export default function AdminPasswordStep({ onComplete }: AdminPasswordStepProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const validate = () => {
    if (!password) return '请输入密码';
    if (password.length < 8) return '密码长度至少8位';
    if (!/[a-zA-Z]/.test(password)) return '密码需包含字母';
    if (!/\d/.test(password)) return '密码需包含数字';
    if (password !== confirmPassword) return '两次密码不一致';
    return '';
  };

  const handleSubmit = async () => {
    const err = validate();
    if (err) { setError(err); return; }

    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${MAIN_URL}/api/setup/admin-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, confirmPassword }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || data.error || '设置失败');
      onComplete();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none transition-all';

  const strength = (() => {
    if (!password) return { level: 0, text: '', color: '' };
    let s = 0;
    if (password.length >= 8) s++;
    if (/[a-z]/.test(password) && /[A-Z]/.test(password)) s++;
    if (/\d/.test(password)) s++;
    if (/[^a-zA-Z0-9]/.test(password)) s++;
    if (s <= 1) return { level: 1, text: '弱', color: 'bg-red-400' };
    if (s === 2) return { level: 2, text: '中', color: 'bg-amber-400' };
    return { level: 3, text: '强', color: 'bg-green-500' };
  })();

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-8 w-full max-w-md">
      <div className="text-center mb-6">
        <h2 className="text-lg font-bold text-gray-900 mb-1">设置管理员密码</h2>
        <p className="text-sm text-gray-500">管理员账号：admin@company.com</p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-red-600 bg-red-50 rounded-lg border border-red-100">
          {error}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">新密码 <span className="text-red-400">*</span></label>
          <div className="relative">
            <input
              className={inputClass}
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="至少8位，含字母和数字"
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
            >
              {showPassword ? '隐藏' : '显示'}
            </button>
          </div>
          {/* Password strength */}
          {password && (
            <div className="flex items-center gap-2 mt-1.5">
              <div className="flex gap-0.5 flex-1">
                {[1, 2, 3].map(i => (
                  <div key={i} className={`h-1 flex-1 rounded-full ${i <= strength.level ? strength.color : 'bg-gray-200'}`} />
                ))}
              </div>
              <span className="text-xs text-gray-500">{strength.text}</span>
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">确认密码 <span className="text-red-400">*</span></label>
          <input
            className={inputClass}
            type={showPassword ? 'text' : 'password'}
            value={confirmPassword}
            onChange={e => setConfirmPassword(e.target.value)}
            placeholder="再次输入密码"
          />
          {confirmPassword && password !== confirmPassword && (
            <p className="text-xs text-red-500 mt-1">两次密码不一致</p>
          )}
        </div>

        <button
          onClick={handleSubmit}
          disabled={loading || !password || !confirmPassword}
          className="w-full py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm disabled:opacity-50 transition-all"
        >
          {loading ? '设置中...' : '确认设置'}
        </button>
      </div>

      <p className="text-xs text-gray-400 text-center mt-6">
        请牢记此密码，后续可在设置中修改
      </p>
    </div>
  );
}
