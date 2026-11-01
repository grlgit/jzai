'use client';

/**
 * P1 资源归属徽标：global=全局（灰）、user=用户（琥珀）。
 * 列表行内联展示；scope 缺失（旧数据/未接线）时不渲染。
 */
export default function ScopeBadge({ scope }: { scope?: string }) {
  if (!scope) return null;
  if (scope === 'user') {
    return (
      <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-amber-50 text-amber-600 shrink-0" title="用户创建的资源，可分享">
        用户
      </span>
    );
  }
  return (
    <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-gray-100 text-gray-500 shrink-0" title="全局资源">
      全局
    </span>
  );
}
