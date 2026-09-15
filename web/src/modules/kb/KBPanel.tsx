'use client';

import { useEffect } from 'react';
import { useKBStore } from './stores/useKBStore';
import { KBDetail } from './components/kb/KBDetail';
import type { ViewMode } from './components/kb/KBDetail';
import { Toaster } from 'sonner';

export default function KBPanel() {
  const { knowledgeBases, fetchKBs } = useKBStore();

  useEffect(() => {
    fetchKBs();
  }, [fetchKBs]);

  // Use the first (default) knowledge base
  const kb = knowledgeBases[0];

  if (!kb) {
    return (
      <div className="h-full flex items-center justify-center text-gray-400">
        <div className="text-center">
          <div className="text-4xl mb-2">🧠</div>
          <div className="text-sm">正在加载企业心智...</div>
          <div className="text-xs mt-1 text-gray-300">请确保企业心智服务已启动</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <Toaster position="top-right" />
      <KBDetail
        kbId={kb.id}
        kbSlug={kb.slug || kb.id}
        kbName={kb.name}
        viewMode={'mind' as ViewMode}
        routeFilesPath="/"
      />
    </div>
  );
}
