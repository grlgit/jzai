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
  theme?: 'light' | 'dark';
}

function buildOption(chartType: string, title: string, data: any, config?: any, theme: 'light' | 'dark' = 'light'): any {
  const seriesNames: string[] = config?.seriesNames || [];
  const hiddenSet = new Set<string>(config?.hiddenSeries || []);
  const suffix = config?.tooltipSuffix || '';
  const stacked = config?.stacked;

  const isDark = theme === 'dark';
  // 暗色 = 深底反白、内容高亮流线；亮色沿用现状
  const textColor = isDark ? '#e5e9f2' : '#374151';
  const mutedColor = isDark ? '#8b94ab' : '#9ca3af';
  const lineColor = isDark ? '#3a4568' : '#e5e7eb';
  const splitColor = isDark ? '#232c47' : '#f3f4f6';
  const tooltipBg = isDark ? '#1b2340' : '#ffffff';
  const defaultColors = isDark
    ? ['#818cf8', '#22d3ee', '#34d399', '#facc15', '#fb923c', '#f472b6', '#a78bfa', '#38bdf8', '#4ade80', '#f87171']
    : ['#6366f1', '#8b5cf6', '#a78bfa', '#c4b5fd', '#e0e7ff', '#f43f5e', '#fb923c', '#facc15', '#34d399', '#38bdf8'];

  const axisStyle = {
    axisLine: { lineStyle: { color: lineColor } },
    axisLabel: { color: mutedColor },
    splitLine: { lineStyle: { color: splitColor } },
    axisName: { color: mutedColor },
  };

  const base: any = {
    backgroundColor: 'transparent',
    textStyle: { color: textColor },
    title: title ? { text: title, left: 'center', textStyle: { fontSize: 14, color: textColor } } : undefined,
    tooltip: {
      trigger: chartType === 'pie' ? 'item' : 'axis',
      backgroundColor: tooltipBg,
      borderColor: lineColor,
      textStyle: { color: textColor, fontSize: 12 },
      ...(suffix ? { valueFormatter: (v: number) => `${v}${suffix}` } : {}),
    },
    legend: { textStyle: { color: mutedColor }, ...(config?.legend || { show: true, top: 0 }) },
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

  // 坐标轴配置覆盖：剥离 config 中的 data 字段——LLM 可能写入 "#{field}" 模板字面量
  // （#{field} 绑定仅支持指标卡），直接覆盖会把模板字符串拆成无意义字符渲染
  const stripData = (axisCfg: any) => {
    if (!axisCfg || typeof axisCfg !== 'object') return {};
    const { data: _drop, ...rest } = axisCfg;
    return rest;
  };

  const catAxis = { type: 'category', data: data.xAxis || [], ...stripData(config?.xAxis), ...axisStyle, axisLabel: { color: mutedColor, ...(config?.xAxis?.axisLabel || {}) } };
  const valAxis = { type: 'value', ...stripData(config?.yAxis), ...axisStyle };

  switch (chartType) {
    case 'pie':
      return {
        ...base,
        series: [{
          type: 'pie', radius: '60%',
          label: { color: mutedColor }, labelLine: { lineStyle: { color: lineColor } },
          itemStyle: isDark ? { borderColor: '#151b2e', borderWidth: 1 } : undefined,
          data: Array.isArray(data) ? data : data.series || data.data || [],
        }],
      };
    case 'bar':
      return { ...base, xAxis: catAxis, yAxis: valAxis, series: applySeries(data.series || [], 'bar') };
    case 'line':
    case 'curve':
      return { ...base, xAxis: catAxis, yAxis: valAxis, series: applySeries(data.series || [], 'line', { smooth: config?.smooth ?? chartType === 'curve' }) };
    case 'radar':
      return {
        ...base,
        radar: {
          indicator: data.indicator || [],
          axisName: { color: mutedColor },
          splitLine: { lineStyle: { color: splitColor } },
          splitArea: { areaStyle: { color: isDark ? ['rgba(255,255,255,0.02)', 'rgba(255,255,255,0.05)'] : ['rgba(0,0,0,0.01)', 'rgba(0,0,0,0.03)'] } },
          axisLine: { lineStyle: { color: lineColor } },
        },
        series: [{ type: 'radar', data: (data.series || []).map((s: any) => ({ name: s.name, value: s.value })) }],
      };
    default:
      return base;
  }
}

export default function ChartWidget({ chartType, title, data, config, className, theme = 'light' }: ChartWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    if (!chartRef.current) {
      chartRef.current = echarts.init(containerRef.current);
    }

    const option = buildOption(chartType, title, data, config, theme);
    chartRef.current.setOption(option, true);

    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
    };
  }, [chartType, title, data, config, theme]);

  useEffect(() => {
    return () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className={className || 'w-full h-full min-h-[200px]'} />;
}
