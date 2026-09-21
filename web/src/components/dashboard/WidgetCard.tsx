'use client';

import { useState } from 'react';
import ChartWidget from './widgets/ChartWidget';
import MetricCard from './widgets/MetricCard';
import TableWidget from './widgets/TableWidget';
import type { DashboardWidget } from '@/hooks/useDashboard';

interface WidgetCardProps {
  widget: DashboardWidget;
  editing: boolean;
  theme?: 'light' | 'dark';
  readonly?: boolean;   // 分享只读：隐藏编辑/对话/删除，仅保留刷新
  onDelete: () => void;
  onRefresh: () => void;
  onEdit: () => void;
  onChat: () => void;
}

/** Resolve #{field} templates against a data row */
function resolveBindings(template: string, row: Record<string, any> | null): string {
  if (!template || !row) return template || '';
  return template.replace(/#\{(\w+)\}/g, (_, key) => {
    const val = row[key];
    return val !== undefined && val !== null ? String(val) : `#{${key}}`;
  });
}

export default function WidgetCard({ widget, editing, theme = 'light', readonly = false, onDelete, onRefresh, onEdit, onChat }: WidgetCardProps) {
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = async () => {
    setRefreshing(true);
    await onRefresh();
    setRefreshing(false);
  };

  const isMetric = widget.widgetType === 'metric_card';

  // 取数失败（success:false，如 SQL 语法错误）——显示错误态，不把错误对象当数据渲染
  const fetchError: string | null = widget.cachedData?.success === false
    ? (widget.cachedData?.message || '数据加载失败')
    : null;

  const chartData = fetchError
    ? null
    : widget.cachedData?.rows
      ? transformDataForChart(widget.widgetType, widget.cachedData, widget.config)
      : widget.config?.data || widget.cachedData;

  // For metric_card: resolve #{field} bindings from cachedData
  const bindingRow = widget.cachedData?.rows?.[0] || null;

  const errorBox = (compact: boolean) => (
    <div className={`flex flex-col items-center justify-center h-full gap-1 ${compact ? 'p-3' : 'p-4'}`}>
      <div className="text-red-400 text-lg">⚠</div>
      <div className="text-[11px] text-red-400 text-center leading-snug line-clamp-3" title={fetchError || ''}>
        数据加载失败{fetchError ? `：${fetchError}` : ''}
      </div>
      <div className="text-[10px] text-[var(--jz-faint)]">点击 ✎ 检查数据源，或 ⟳ 重试</div>
    </div>
  );

  if (isMetric) {
    const cachedAtStr = widget.cachedAt
      ? new Date(widget.cachedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '';
    return (
      <div className="bg-[var(--jz-card)] rounded-xl shadow-sm h-full flex flex-col overflow-hidden group relative">
        {/* Hover overlay: refresh time + edit/delete */}
        <div className="absolute top-0 left-0 right-0 flex items-center px-3 py-1 bg-[var(--jz-overlay)] backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity z-10">
          {editing && <span className="cursor-grab text-[var(--jz-faint)] mr-1 drag-handle">⠿</span>}
          <span className="text-[10px] text-[var(--jz-faint)] flex-1 truncate">{cachedAtStr}</span>
          <button onClick={handleRefresh} disabled={refreshing}
            className="text-[var(--jz-faint)] hover:text-[var(--jz-fg)] text-xs px-0.5 disabled:opacity-50" title="刷新数据">
            {refreshing ? '...' : '⟳'}
          </button>
          {!readonly && (<>
            <button onClick={onEdit} className="text-[var(--jz-faint)] hover:text-[var(--jz-accent)] text-xs px-0.5" title="编辑">✎</button>
            <button onClick={onChat} className="text-[var(--jz-faint)] hover:text-[var(--jz-accent)] text-xs px-0.5" title="对话编辑">💬</button>
          </>)}
          {editing && (
            <button onClick={onDelete} className="text-[var(--jz-faint)] hover:text-red-500 text-xs px-0.5" title="删除">✕</button>
          )}
        </div>
        {/* Metric content — full height, no title bar */}
        <div className="flex-1 min-h-0">
          {fetchError ? errorBox(true) : (
            <MetricCard title={widget.title} data={chartData || {}} config={widget.config} bindingRow={bindingRow} />
          )}
        </div>
      </div>
    );
  }

  // Chart types: keep existing title bar
  return (
    <div className="bg-[var(--jz-card)] rounded-lg border border-[var(--jz-border)] shadow-sm h-full flex flex-col overflow-hidden">
      {/* Title bar */}
      <div className="flex items-center px-3 py-1.5 border-b border-[var(--jz-border-soft)] shrink-0">
        {editing && (
          <span className="cursor-grab text-[var(--jz-faint)] mr-1 drag-handle">⠿</span>
        )}
        <span className="text-xs font-medium text-[var(--jz-fg)] truncate flex-1">{widget.title || '未命名'}</span>
        <div className="flex items-center gap-1">
          {widget.refreshInterval > 0 && (
            <span className="text-[10px] text-[var(--jz-faint)]" title={`每 ${widget.refreshInterval} 秒刷新`}>
              ⟳ {widget.refreshInterval}s
            </span>
          )}
          <button onClick={handleRefresh} disabled={refreshing}
            className="text-[var(--jz-faint)] hover:text-[var(--jz-fg)] text-xs px-0.5 disabled:opacity-50"
            title="刷新数据">
            {refreshing ? '...' : '⟳'}
          </button>
          {!readonly && (<>
            <button onClick={onEdit} className="text-[var(--jz-faint)] hover:text-[var(--jz-accent)] text-xs px-0.5" title="编辑">✎</button>
            <button onClick={onChat} className="text-[var(--jz-faint)] hover:text-[var(--jz-accent)] text-xs px-0.5" title="对话编辑">💬</button>
          </>)}
          {editing && (
            <button onClick={onDelete} className="text-[var(--jz-faint)] hover:text-red-500 text-xs px-0.5" title="删除">✕</button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 p-1">
        {fetchError ? errorBox(false) : widget.widgetType === 'table' ? (
          <TableWidget data={widget.cachedData || {}} config={widget.config} />
        ) : chartData ? (
          <ChartWidget
            chartType={widget.widgetType}
            title=""
            data={chartData}
            config={widget.config}
            theme={theme}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-[var(--jz-faint)] text-xs">
            暂无数据 — 点击 ⟳ 刷新
          </div>
        )}
      </div>
    </div>
  );
}

function transformDataForChart(widgetType: string, cachedData: any, config: any): any {
  if (!cachedData?.rows || !cachedData?.columns) return cachedData;

  const { columns, rows } = cachedData;
  if (columns.length < 2 || rows.length === 0) return cachedData;

  if (widgetType === 'pie') {
    return rows.map((row: any) => ({ name: String(row[columns[0]]), value: Number(row[columns[1]]) }));
  }

  if (widgetType === 'bar' || widgetType === 'line' || widgetType === 'curve') {
    const xAxis = rows.map((row: any) => String(row[columns[0]]));
    const series = columns.slice(1).map((col: string) => ({
      name: col,
      data: rows.map((row: any) => Number(row[col])),
    }));
    return { xAxis, series };
  }

  if (widgetType === 'metric_card' && rows.length === 1) {
    const val = rows[0][columns[0]];
    return { value: val, subtitle: config?.subtitle || '' };
  }

  return cachedData;
}
