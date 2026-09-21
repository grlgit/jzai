'use client';

interface TableWidgetProps {
  /** 数据源原始形态：{ columns: string[], rows: Record<string, any>[] } */
  data: { columns?: string[]; rows?: Record<string, any>[] };
  config?: any;
}

/**
 * 表格仪表块 — 渲染数据源的 columns/rows。
 * 主题跟随 .jz-dash 容器变量（黑/白双风格），粘性表头 + 双向滚动。
 * config 可选：{ maxRows?: number（默认全量，超出滚动）, columnLabels?: {col: 显示名} }
 */
export default function TableWidget({ data, config }: TableWidgetProps) {
  const columns: string[] = data?.columns || [];
  const rows: Record<string, any>[] = data?.rows || [];
  const labels: Record<string, string> = config?.columnLabels || {};
  const maxRows = config?.maxRows ?? rows.length;

  if (columns.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--jz-faint)] text-xs">
        暂无数据 — 点击 ⟳ 刷新
      </div>
    );
  }

  const fmt = (v: any): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  };

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-xs border-collapse">
        <thead className="sticky top-0 z-10">
          <tr>
            {columns.map(col => (
              <th key={col}
                className="text-left font-medium text-[var(--jz-muted)] bg-[var(--jz-card)] border-b border-[var(--jz-border)] px-2.5 py-1.5 whitespace-nowrap">
                {labels[col] || col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, maxRows).map((row, i) => (
            <tr key={i} className={i % 2 === 1 ? 'bg-[var(--jz-border-soft)]' : ''}>
              {columns.map(col => (
                <td key={col}
                  className="text-[var(--jz-fg)] border-b border-[var(--jz-border-soft)] px-2.5 py-1.5 whitespace-nowrap max-w-[240px] truncate"
                  title={fmt(row[col])}>
                  {fmt(row[col])}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="text-center text-[var(--jz-faint)] py-6">查询无结果</td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > maxRows && (
        <div className="text-center text-[10px] text-[var(--jz-faint)] py-1">
          显示前 {maxRows} / {rows.length} 行
        </div>
      )}
    </div>
  );
}
