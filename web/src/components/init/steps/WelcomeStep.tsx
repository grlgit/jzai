'use client';

import { useState, useEffect } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

interface HealthItem {
  status: 'ok' | 'error' | 'loading';
  message?: string;
  models?: string[];
}

interface Health {
  db: HealthItem;
  kb: HealthItem;
  localModel: HealthItem;
  cloudModel: HealthItem;
  overall: boolean;
}

export default function WelcomeStep({ onNext }: { onNext: () => void }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const check = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${MAIN_URL}/api/setup/health`);
        const data = await res.json();
        setHealth(data);
      } catch {
        setHealth(null);
      }
      setLoading(false);
    };
    check();
  }, []);

  const StatusBadge = ({ item }: { item: HealthItem }) => (
    <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${
      item.status === 'ok' ? 'bg-green-50 text-green-700' :
      item.status === 'loading' ? 'bg-gray-50 text-gray-500' :
      'bg-amber-50 text-amber-700'
    }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        item.status === 'ok' ? 'bg-green-500' :
        item.status === 'loading' ? 'bg-gray-400 animate-pulse' :
        'bg-amber-500'
      }`} />
      {item.status === 'ok' ? '正常' : item.status === 'loading' ? '检测中' : item.message || '未连接'}
    </span>
  );

  return (
    <div className="bg-white rounded-2xl shadow-xl border border-gray-200 p-8 w-full max-w-lg">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 mb-4">
          <img src="/logo.png" alt="见智" className="w-14 h-14 object-contain" />
        </div>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          欢迎使用见智
        </h1>
        <p className="text-sm text-gray-500">
          企业AI门户 — 首次部署需要完成初始化配置
        </p>
      </div>

      {/* Health check */}
      <div className="space-y-3 mb-8">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">系统状态</h3>

        {loading ? (
          <div className="text-center py-6 text-sm text-gray-400 animate-pulse">检测中...</div>
        ) : health ? (
          <div className="space-y-2.5">
            <div className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
              <span className="text-sm text-gray-700">数据库</span>
              <StatusBadge item={health.db} />
            </div>
            <div className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
              <span className="text-sm text-gray-700">知库服务</span>
              <StatusBadge item={health.kb} />
            </div>
            <div className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
              <div>
                <span className="text-sm text-gray-700">本地模型 (Ollama)</span>
                {health.localModel.models && health.localModel.models.length > 0 && (
                  <span className="text-xs text-gray-400 ml-2">{health.localModel.models.slice(0, 3).join(', ')}</span>
                )}
              </div>
              <StatusBadge item={health.localModel} />
            </div>
            <div className="flex items-center justify-between py-2 px-3 bg-gray-50 rounded-lg">
              <span className="text-sm text-gray-700">云端模型</span>
              <StatusBadge item={health.cloudModel} />
            </div>
          </div>
        ) : (
          <div className="text-center py-6 text-sm text-red-500">无法连接后端服务</div>
        )}

        {health && !health.overall && (
          <p className="text-xs text-amber-600 mt-2">
            部分服务未就绪，可在完成初始化后配置。
          </p>
        )}
      </div>

      {/* Action */}
      <button
        onClick={onNext}
        disabled={loading || (health?.db.status !== 'ok')}
        className="w-full py-3 text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm disabled:opacity-50 transition-all"
      >
        开始配置
      </button>
    </div>
  );
}
