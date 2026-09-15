'use client';

import type { ContextStatus } from '@/hooks/useChat';

// P0-1: 上下文健康度指示器
// 让后端的上下文裁剪（L2）/语义压缩、硬重置（L3）对用户可见，
// 避免长对话中 Agent "失忆" 时用户误以为是 Bug。
export default function ContextIndicator({ status }: { status?: ContextStatus | null }) {
  if (!status) return null;

  const { level, usagePercent, detail } = status;

  // ok：正常对话无干扰，不显示
  if (level === 'ok') return null;

  // compacted / reset：短暂 toast 风格提示（hook 已负责数秒后自动降级/清除）
  if (level === 'compacted' || level === 'reset') {
    const isReset = level === 'reset';
    return (
      <div
        className={`flex items-center gap-2 px-3 py-1.5 mb-1.5 rounded-md text-xs ${
          isReset
            ? 'bg-red-50 text-red-600 border border-red-200'
            : 'bg-blue-50 text-blue-600 border border-blue-200'
        }`}
        role="status"
      >
        <span>{isReset ? '🔄' : '⚠'}</span>
        <span>{detail || (isReset ? '上下文已满，已自动开启新会话' : '已压缩历史以继续')}</span>
      </div>
    );
  }

  // warn / critical：使用率徽标（critical 常驻 + 进度条 + 建议）
  const isCritical = level === 'critical';
  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 mb-1.5 rounded-md text-xs ${
        isCritical ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'
      }`}
      title={`上下文使用率 ${usagePercent}%`}
      role="status"
    >
      <span className={`w-2 h-2 rounded-full ${isCritical ? 'bg-red-500' : 'bg-amber-400'}`} />
      <span>上下文 {usagePercent}%</span>
      {isCritical && (
        <>
          <span className="flex-1 h-1.5 rounded-full bg-red-100 overflow-hidden">
            <span
              className="block h-full bg-red-400"
              style={{ width: `${Math.min(100, usagePercent)}%` }}
            />
          </span>
          <span className="shrink-0 text-red-500">建议开启新对话</span>
        </>
      )}
    </div>
  );
}
