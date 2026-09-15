'use client';

import { useState, useEffect } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

interface ConfigGuideBannerProps {
  token: string;
  onNavigate: (panel: string) => void;
}

interface Health {
  localModel: { status: string };
  cloudModel: { status: string };
}

export default function ConfigGuideBanner({ token, onNavigate }: ConfigGuideBannerProps) {
  const [visible, setVisible] = useState(true);
  const [health, setHealth] = useState<Health | null>(null);

  useEffect(() => {
    fetch(`${MAIN_URL}/api/setup/health`)
      .then(r => r.json())
      .then(setHealth)
      .catch(() => {});
  }, []);

  const handleDismiss = async () => {
    setVisible(false);
    try {
      await fetch(`${MAIN_URL}/api/setup/complete-guide`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
    } catch { /* non-critical */ }
  };

  if (!visible) return null;

  const hasModel = health && (health.localModel.status === 'ok' || health.cloudModel.status === 'ok');

  return (
    <div className="bg-indigo-50 border-b border-indigo-100 px-4 py-3">
      <div className="flex items-center justify-between max-w-screen-xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-indigo-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <span className="text-sm text-indigo-800">
            {hasModel ? '系统已就绪，可在设置中调整模型配置。' : '请配置 AI 模型以开始使用智能对话功能。'}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => onNavigate('cfg')}
            className="px-3 py-1.5 text-xs font-medium text-indigo-700 bg-indigo-100 hover:bg-indigo-200 rounded-lg transition-colors"
          >
            配置模型
          </button>
          <button
            onClick={handleDismiss}
            className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 transition-colors"
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
