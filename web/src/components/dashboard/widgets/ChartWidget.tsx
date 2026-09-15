'use client';

import { useEffect, useRef } from 'react';

// Lazy-load ECharts with tree-shaking
import * as echarts from 'echarts/core';
import { PieChart, BarChart, LineChart, RadarChart } from 'echarts/charts';
import { TitleComponent, TooltipComponent, LegendComponent, GridComponent, RadarComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';

echarts.use([PieChart, BarChart, LineChart, RadarChart, TitleComponent, TooltipComponent, LegendComponent, GridComponent, RadarComponent, CanvasRenderer]);

interface ChartWidgetProps {
  chartType: string;
  title: string;
  data: any;
  config?: any;
  className?: string;
}

function buildOption(chartType: string, title: string, data: any, config?: any): any {
  const seriesNames: string[] = config?.seriesNames || [];
  const hiddenSet = new Set<string>(config?.hiddenSeries || []);
  const suffix = config?.tooltipSuffix || '';
  const stacked = config?.stacked;

  const defaultColors = ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#e0e7ff', '#f43f5e', '#fb923c', '#facc15', '#34d399', '#38bdf8'];

  const base: any = {
    title: title ? { text: title, left: 'center', textStyle: { fontSize: 14 } } : undefined,
    tooltip: {
      trigger: chartType === 'pie' ? 'item' : 'axis',
      ...(suffix ? { valueFormatter: (v: number) => `${v}${suffix}` } : {}),
    },
    legend: config?.legend || { show: true, top: 0 },
    color: config?.colors || defaultColors,
    grid: config?.grid?.show === false ? { show: false } : { left: '3%', right: '4%', bottom: '8%', containLabel: true },
  };

  const applySeries = (series: any[], type: string, extra?: any) =>
    series
    .filter((s: any) => !hiddenSet.has(s.name)) // Hide series in hiddenSeries
    .map((s: any, i: number) => ({
      ...s,
      type,
      name: seriesNames[i] || s.name,
      ...(stacked ? { stack: 'total' } : {}),
      ...extra,
    }));

  switch (chartType) {
    case 'pie':
      return { ...base, series: [{ type: 'pie', radius: '60%', data: Array.isArray(data) ? data : data.series || data.data || [] }] };
    case 'bar':
      return { ...base, xAxis: { type: 'category', data: data.xAxis || [], ...(config?.xAxis || {}) }, yAxis: { type: 'value', ...(config?.yAxis || {}) }, series: applySeries(data.series || [], 'bar') };
    case 'line':
    case 'curve':
      return { ...base, xAxis: { type: 'category', data: data.xAxis || [], ...(config?.xAxis || {}) }, yAxis: { type: 'value', ...(config?.yAxis || {}) }, series: applySeries(data.series || [], 'line', { smooth: config?.smooth ?? chartType === 'curve' }) };
    case 'radar':
      return { ...base, radar: { indicator: data.indicator || [] }, series: [{ type: 'radar', data: (data.series || []).map((s: any) => ({ name: s.name, value: s.value })) }] };
    default:
      return base;
  }
}

export default function ChartWidget({ chartType, title, data, config, className }: ChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!chartRef.current) {
      chartRef.current = echarts.init(containerRef.current);
    }

    const option = buildOption(chartType, title, data, config);
    chartRef.current.setOption(option, true);

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [chartType, title, data, config]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className={className || 'w-full h-full min-h-[200px]'} />;
}
