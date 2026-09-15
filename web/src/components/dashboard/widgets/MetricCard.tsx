'use client';

interface MetricCardProps {
  title: string;
  data: {
    value: number | string;
    unit?: string;
    subtitle?: string;
    trend?: string;
    trendValue?: string;
    icon?: string;
  };
  config?: any;
  bindingRow?: Record<string, any> | null;
}

/** Resolve #{field} templates against a data row */
function resolve(template: string | number | undefined, row: Record<string, any> | null): string {
  if (template === undefined || template === null) return '';
  const s = String(template);
  if (!row || !s.includes('#{')) return s;
  return s.replace(/#\{(\w+)\}/g, (_, key) => {
    const val = row[key];
    return val !== undefined && val !== null ? String(val) : `#{${key}}`;
  });
}

// Icon background color mapping
const ICON_BG: Record<string, string> = {
  '📊': 'bg-indigo-100', '📈': 'bg-green-100', '📉': 'bg-red-100', '💰': 'bg-yellow-100',
  '🏭': 'bg-gray-200', '📦': 'bg-amber-100', '🛒': 'bg-blue-100', '👥': 'bg-cyan-100',
  '⏱': 'bg-purple-100', '✅': 'bg-emerald-100', '⚠️': 'bg-amber-400', '🔧': 'bg-slate-200',
  '📋': 'bg-orange-100', '🎯': 'bg-rose-100', '💡': 'bg-yellow-200', '🔔': 'bg-red-100',
};

export default function MetricCard({ title, data, config, bindingRow }: MetricCardProps) {
  const row = bindingRow || null;
  // Config fields take priority over data fields (config may contain #{field} templates)
  const icon = config?.icon || data.icon;
  const trend = config?.trend || data.trend;

  const resolvedValue = resolve(config?.value ?? data.value, row);
  const resolvedUnit = resolve(config?.unit ?? data.unit, row);
  const resolvedSubtitle = resolve(config?.subtitle ?? data.subtitle, row);
  const resolvedTrendValue = resolve(config?.trendValue ?? data.trendValue, row);
  const resolvedFootnote = resolve(config?.footnote, row);
  const resolvedTitle = resolve(title, row);

  const trendColor = trend === '↑' ? 'text-green-500' : trend === '↓' ? 'text-red-500' : 'text-gray-400';
  const iconBg = icon ? (ICON_BG[icon] || 'bg-gray-100') : '';

  return (
    <div className="flex flex-col justify-between h-full px-5 py-4">
      {/* Top row: title left, icon right */}
      <div className="flex items-start justify-between">
        <span className="text-sm text-gray-400 leading-snug">{resolvedTitle}</span>
        {icon && (
          <span className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center text-xl shrink-0 ml-2`}>
            {icon}
          </span>
        )}
      </div>

      {/* Main value */}
      <div className="flex items-baseline gap-1.5 mt-1">
        <span className="text-2xl font-bold text-gray-800 leading-tight">{resolvedValue || '—'}</span>
        {resolvedUnit && <span className="text-sm text-gray-400">{resolvedUnit}</span>}
      </div>

      {/* Subtitle + trend */}
      <div className="flex items-center gap-2 mt-1">
        {resolvedSubtitle && <span className="text-xs text-gray-400">{resolvedSubtitle}</span>}
        {trend && (
          <span className={`text-xs font-medium ${trendColor}`}>
            {trend} {resolvedTrendValue}
          </span>
        )}
      </div>

      {/* Footnote */}
      {resolvedFootnote && (
        <div className="text-[10px] text-gray-300 truncate mt-2 border-t border-gray-50 pt-1.5">{resolvedFootnote}</div>
      )}
    </div>
  );
}
