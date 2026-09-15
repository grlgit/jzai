'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { saveAdminKey, loadAdminKey, clearAdminKey } from '@/lib/admin-auth';

const ADMIN_MODULES = [
  {
    href: '/admin/dashboard',
    icon: '📊',
    title: '运营看板',
    desc: '平台健康度、客户增长、Token 消耗、收入趋势、用户满意度',
  },
  {
    href: '/admin/customers',
    icon: '👥',
    title: '客户管理',
    desc: '积分余额、使用详情、安装状态、管理员充值',
  },
  {
    href: '/admin/cases',
    icon: '📦',
    title: '用例管理',
    desc: '创建、编辑、删除用例，支持富文本编排',
  },
  {
    href: '/admin/versions',
    icon: '🚀',
    title: '版本管理',
    desc: '安装包上传下载、OTA升级版本发布与管理',
  },
  {
    href: '/admin/cms',
    icon: '✏️',
    title: '官网CMS',
    desc: '站点文案编辑（首页/产品/文档）+ 独立页面管理（关于/隐私/条款）',
  },
  {
    href: '/admin/settings',
    icon: '⚙️',
    title: '系统设置',
    desc: 'LLM 供应商、API Key、积分费率、管理密码',
  },
];

export default function AdminIndexPage() {
  const [authed, setAuthed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [adminKey, setAdminKey] = useState('');
  const [error, setError] = useState('');

  const verifyKey = useCallback(async (key: string) => {
    setLoading(true);
    setError('');
    try {
      const resp = await fetch('/api/v1/admin/dashboard', { headers: { 'X-Admin-Key': key } });
      if (resp.status === 401) { setAuthed(false); setError('密码错误'); clearAdminKey(); return; }
      if (!resp.ok) throw new Error(`${resp.status}`);
      setAuthed(true);
      await saveAdminKey(key);
    } catch (e: any) {
      setError(e.message);
      setAuthed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAdminKey().then(saved => {
      if (saved) { setAdminKey(saved); verifyKey(saved); }
      else setLoading(false);
    });
  }, [verifyKey]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 animate-pulse">Loading...</div>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="bg-white rounded-2xl shadow-lg border border-gray-200 p-8 w-full max-w-sm">
          <div className="text-center mb-6">
            <img src="/logo-64.png" alt="见智" className="w-10 h-10 mx-auto mb-3 object-contain" />
            <h1 className="text-xl font-bold text-gray-900 mb-1">管理后台</h1>
            <p className="text-sm text-gray-500">请输入管理密码</p>
          </div>
          {error && <div className="text-sm text-red-500 mb-4 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
          <form onSubmit={(e) => { e.preventDefault(); verifyKey(adminKey); }}>
            <input type="password" className="w-full px-4 py-2.5 text-sm border border-gray-200 rounded-lg focus:border-primary-400 focus:ring-2 focus:ring-primary-100 outline-none mb-4"
              value={adminKey} onChange={(e) => setAdminKey(e.target.value)} placeholder="Admin Secret" autoFocus />
            <button type="submit" className="w-full py-2.5 text-sm font-semibold text-white bg-primary-600 hover:bg-primary-700 rounded-lg">登录</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2.5 mb-4">
            <img src="/logo-64.png" alt="见智" className="w-10 h-10 object-contain" />
            <span className="text-2xl font-bold text-gray-900">管理后台</span>
          </div>
          <p className="text-gray-500">见智平台运营管理</p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {ADMIN_MODULES.map((m) => (
            <Link key={m.href} href={m.href} className="group block">
              <div className="bg-white rounded-xl p-6 border border-gray-200 hover:border-primary-300 hover:shadow-lg transition-all h-full">
                <span className="text-3xl mb-3 block">{m.icon}</span>
                <h2 className="text-base font-bold text-gray-900 group-hover:text-primary-600 transition-colors mb-1">
                  {m.title}
                </h2>
                <p className="text-sm text-gray-500 leading-relaxed">{m.desc}</p>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
