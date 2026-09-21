'use client';

import { useCallback, useMemo, useRef } from 'react';
import { GridLayout, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import WidgetCard from './WidgetCard';
import type { DashboardWidget } from '@/hooks/useDashboard';

interface DashboardGridProps {
  layout: any[];
  widgets: DashboardWidget[];
  editing: boolean;
  theme?: 'light' | 'dark';
  readonly?: boolean;   // 分享只读
  onLayoutChange: (layout: any[]) => void;
  onDeleteWidget: (widgetId: string) => void;
  onRefreshWidget: (widgetId: string) => void;
  onEditWidget: (widget: DashboardWidget) => void;
  onChatWidget: (widget: DashboardWidget) => void;
}

export default function DashboardGrid({ layout, widgets, editing, theme = 'light', readonly = false, onLayoutChange, onDeleteWidget, onRefreshWidget, onEditWidget, onChatWidget }: DashboardGridProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { width, mounted, containerRef } = useContainerWidth({});

  const handleLayoutChange = useCallback((newLayout: readonly any[]) => {
    if (!editing) return; // 视图态不回写（compaction 等自动布局不产生副作用）
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onLayoutChange([...newLayout].map(item => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h })));
    }, 500);
  }, [editing, onLayoutChange]);

  // 有效布局：widgets 缺少 layout 项时自动补位（与后端 addWidget 的追加语义一致），
  // 保证所有子项都有坐标，编辑态/视图态共用同一 GridLayout，几何完全一致
  const effectiveLayout = useMemo(() => {
    const map = new Map<string, any>((layout || []).map((it: any) => [it.i, it]));
    let autoY = (layout || []).reduce((m: number, it: any) => Math.max(m, (it.y || 0) + (it.h || 0)), 0);
    return widgets.map(w => {
      const it = map.get(w.id);
      if (it) return { i: w.id, x: it.x, y: it.y, w: it.w, h: it.h };
      const def = w.widgetType === 'metric_card' ? { w: 4, h: 3 } : w.widgetType === 'table' ? { w: 8, h: 4 } : { w: 6, h: 4 };
      const item = { i: w.id, x: 0, y: autoY, ...def };
      autoY += def.h;
      return item;
    });
  }, [layout, widgets]);

  if (widgets.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--jz-faint)]">
        <div className="text-center">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-sm">还没有数据仪表</div>
          <div className="text-xs mt-1">与"数据大师"对话来创建图表，然后固定到仪表盘</div>
        </div>
      </div>
    );
  }

  // 编辑态/视图态共用同一 GridLayout（仅交互开关不同），杜绝两种渲染器的尺寸偏差
  return (
    <div ref={containerRef}>
      {mounted && (
        <GridLayout
          width={width}
          layout={effectiveLayout}
          gridConfig={{ cols: 12, rowHeight: 60, margin: [12, 12] as const, containerPadding: null, maxRows: Infinity }}
          dragConfig={{ enabled: editing, bounded: false, handle: '.drag-handle', threshold: 3 }}
          resizeConfig={{ enabled: editing }}
          compactor={verticalCompactor}
          onLayoutChange={handleLayoutChange}
        >
          {widgets.map(widget => (
            <div key={widget.id}>
              <WidgetCard
                widget={widget}
                editing={editing}
                theme={theme}
                readonly={readonly}
                onDelete={() => onDeleteWidget(widget.id)}
                onRefresh={() => onRefreshWidget(widget.id)}
                onEdit={() => onEditWidget(widget)}
                onChat={() => onChatWidget(widget)}
              />
            </div>
          ))}
        </GridLayout>
      )}
    </div>
  );
}
