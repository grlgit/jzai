'use client';

import { useState, useEffect } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

interface RegistrationStepProps {
  onComplete: () => void;
}

type SubStep = 'form' | 'verify';

export default function RegistrationStep({ onComplete }: RegistrationStepProps) {
  const [subStep, setSubStep] = useState<SubStep>('form');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Form fields
  const [companyName, setCompanyName] = useState('');
  const [contactPerson, setContactPerson] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [smsSending, setSmsSending] = useState(false);
  const [countdown, setCountdown] = useState(0);

  // Countdown timer
  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const handleSendSms = async () => {
    if (!companyName.trim() || !contactPerson.trim() || !contactPhone.trim()) {
      setError('请填写所有必填项');
      return;
    }
    if (!/^1\d{10}$/.test(contactPhone)) {
      setError('请输入正确的手机号');
      return;
    }

    setSmsSending(true);
    setError('');
    try {
      const resp = await fetch(`${MAIN_URL}/api/edition/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName, contactPerson, contactPhone }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || data.error || '发送失败');

      if (data.skipVerification) {
        // 无需短信验证 — 直接完成注册
        const completeResp = await fetch(`${MAIN_URL}/api/edition/register/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ companyName, contactPerson, contactPhone }),
        });
        if (!completeResp.ok) {
          const d = await completeResp.json().catch(() => ({}));
          throw new Error(d.message || d.error || '注册安装失败');
        }
        onComplete();
        return;
      }

      if (data._devCode) setDevCode(data._devCode);
      setCountdown(60);
      setSubStep('verify');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSmsSending(false);
    }
  };

  const handleVerify = async () => {
    if (!smsCode.trim()) { setError('请输入验证码'); return; }
    setLoading(true);
    setError('');
    try {
      // Step 1: Verify SMS
      const verifyResp = await fetch(`${MAIN_URL}/api/edition/register/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactPhone, code: smsCode }),
      });
      const verifyData = await verifyResp.json();
      if (!verifyResp.ok) throw new Error(verifyData.message || verifyData.error || '验证失败');

      // Step 2: Complete registration
      const completeResp = await fetch(`${MAIN_URL}/api/edition/register/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName, contactPerson, contactPhone,
          code: smsCode,
          customerId: verifyData.customerId,
          apiKey: verifyData.apiKey,
        }),
      });
      const completeData = await completeResp.json();
      if (!completeResp.ok) throw new Error(completeData.message || completeData.error || '注册安装失败');

      onComplete();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const inputClass = 'w-full px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 outline-none transition-all';

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-8 w-full max-w-md">
      {/* Header */}
      <div className="text-center mb-6">
        <h2 className="text-lg font-bold text-gray-900 mb-1">
          {subStep === 'form' ? '企业注册' : '验证手机号'}
        </h2>
        <p className="text-sm text-gray-500">
          {subStep === 'form' ? '注册企业信息以获取系统授权' : `验证码已发送至 ${contactPhone}`}
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-red-600 bg-red-50 rounded-lg border border-red-100">
          {error}
        </div>
      )}

      {subStep === 'form' && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">企业名称 <span className="text-red-400">*</span></label>
            <input className={inputClass} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="请输入企业全称" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">联系人 <span className="text-red-400">*</span></label>
            <input className={inputClass} value={contactPerson} onChange={e => setContactPerson(e.target.value)} placeholder="负责人姓名" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">手机号 <span className="text-red-400">*</span></label>
            <input className={inputClass} type="tel" value={contactPhone} onChange={e => setContactPhone(e.target.value)} placeholder="用于接收验证码" />
          </div>
          <button
            onClick={handleSendSms}
            disabled={smsSending}
            className="w-full py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm disabled:opacity-50 transition-all"
          >
            {smsSending ? '发送中...' : '获取验证码'}
          </button>
        </div>
      )}

      {subStep === 'verify' && (
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">验证码 <span className="text-red-400">*</span></label>
            <input
              className={inputClass}
              value={smsCode}
              onChange={e => setSmsCode(e.target.value)}
              placeholder="6位数字验证码"
              maxLength={6}
              autoFocus
            />
          </div>

          {devCode && (
            <div className="px-3 py-2 text-xs text-amber-700 bg-amber-50 rounded-lg border border-amber-100">
              开发模式验证码: <strong className="font-mono">{devCode}</strong>
            </div>
          )}

          <button
            onClick={handleVerify}
            disabled={loading}
            className="w-full py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm disabled:opacity-50 transition-all"
          >
            {loading ? '注册中...' : '验证并完成注册'}
          </button>

          <div className="flex items-center justify-between text-xs">
            <button
              onClick={() => { setSubStep('form'); setError(''); setSmsCode(''); }}
              className="text-gray-500 hover:text-gray-700"
            >
              &larr; 修改信息
            </button>
            <button
              onClick={handleSendSms}
              disabled={countdown > 0 || smsSending}
              className="text-indigo-600 hover:text-indigo-700 disabled:text-gray-400"
            >
              {countdown > 0 ? `${countdown}s 后重发` : '重新发送'}
            </button>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-400 text-center mt-6">
        注册信息仅用于产品授权，我们承诺保护您的隐私
      </p>
    </div>
  );
}
