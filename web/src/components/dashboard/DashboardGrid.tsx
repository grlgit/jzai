'use client';

import { useCallback, useRef } from 'react';
import { GridLayout, useContainerWidth, verticalCompactor } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import WidgetCard from './WidgetCard';
import type { DashboardWidget } from '@/hooks/useDashboard';

interface DashboardGridProps {
  layout: any[];
  widgets: DashboardWidget[];
  editing: boolean;
  onLayoutChange: (layout: any[]) => void;
  onDeleteWidget: (widgetId: string) => void;
  onRefreshWidget: (widgetId: string) => void;
  onEditWidget: (widget: DashboardWidget) => void;
  onChatWidget: (widget: DashboardWidget) => void;
}

export default function DashboardGrid({ layout, widgets, editing, onLayoutChange, onDeleteWidget, onRefreshWidget, onEditWidget, onChatWidget }: DashboardGridProps) {
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { width, mounted, containerRef } = useContainerWidth({});

  const handleLayoutChange = useCallback((newLayout: readonly any[]) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      onLayoutChange([...newLayout].map(item => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h })));
    }, 500);
  }, [onLayoutChange]);

  if (widgets.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-300">
        <div className="text-center">
          <div className="text-4xl mb-3">📊</div>
          <div className="text-sm">还没有数据仪表</div>
          <div className="text-xs mt-1">与"数据大师"对话来创建图表，然后固定到仪表盘</div>
        </div>
      </div>
    );
  }

  // Non-editing mode: flex-wrap flow layout (responsive, no grid coordinates needed)
  // Editing mode: GridLayout with drag & resize
  if (!editing) {
    return (
      <div className="flex flex-wrap gap-3 p-3">
        {widgets.map(widget => {
          const isMetric = widget.widgetType === 'metric_card';
          return (
            <div key={widget.id} className={isMetric ? 'w-[280px] h-[180px]' : 'w-[420px] h-[280px]'} style={{ flexShrink: 0 }}>
              <WidgetCard
                widget={widget}
                editing={false}
                onDelete={() => onDeleteWidget(widget.id)}
                onRefresh={() => onRefreshWidget(widget.id)}
                onEdit={() => onEditWidget(widget)}
                onChat={() => onChatWidget(widget)}
              />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={containerRef}>
      {mounted && (
        <GridLayout
          width={width}
          layout={layout}
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
