'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { DashboardWidget } from '@/hooks/useDashboard';

const CHART_TYPES = [
  { value: 'line', label: '折线图' },
  { value: 'curve', label: '曲线图' },
  { value: 'bar', label: '柱状图' },
  { value: 'pie', label: '饼图' },
  { value: 'radar', label: '雷达图' },
  { value: 'metric_card', label: '指标卡' },
];

const PRESET_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#fb923c',
  '#facc15', '#34d399', '#22d3ee', '#38bdf8', '#64748b',
];

const PRESET_ICONS = [
  '📊', '📈', '📉', '💰', '🏭', '📦', '🛒', '👥',
  '⏱', '✅', '⚠️', '🔧', '📋', '🎯', '💡', '🔔',
];

interface WidgetEditDialogProps {
  widget?: DashboardWidget | null;
  onSave: (updates: any) => Promise<void>;
  onClose: () => void;
}

// Toggle switch component
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)}
      className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${value ? 'bg-indigo-500' : 'bg-gray-300'}`}>
      <span className={`absolute top-0.5 w-3 h-3 rounded-full bg-white shadow transition-transform ${value ? 'left-[17px]' : 'left-0.5'}`} />
    </button>
  );
}

export default function WidgetEditDialog({ widget, onSave, onClose }: WidgetEditDialogProps) {
  const isNew = !widget;
  const cfg = widget?.config || {};
  const metricData = widget?.dataSource?.type === 'static' ? widget.dataSource.data : (widget?.cachedData || {});

  // Common
  const [title, setTitle] = useState(widget?.title || '');
  const [widgetType, setWidgetType] = useState(widget?.widgetType || 'line');
  const [refreshInterval, setRefreshInterval] = useState(widget?.refreshInterval || 0);

  // Chart fields
  const [colors, setColors] = useState<string[]>(cfg.colors || cfg.color || []);
  const [legendShow, setLegendShow] = useState(cfg.legend?.show !== false);
  const [legendPosition, setLegendPosition] = useState(cfg.legend?.bottom !== undefined ? 'bottom' : 'top');
  const [smooth, setSmooth] = useState(cfg.smooth ?? (widget?.widgetType === 'curve'));
  const [yAxisName, setYAxisName] = useState(cfg.yAxis?.name || '');
  const [xAxisName, setXAxisName] = useState(cfg.xAxis?.name || '');
  const [stacked, setStacked] = useState(!!cfg.stacked);
  const [showGrid, setShowGrid] = useState(cfg.grid?.show !== false);
  const [tooltipFormat, setTooltipFormat] = useState(cfg.tooltipSuffix || '');
  // Series config: each series has name, color, visible
  const [seriesList, setSeriesList] = useState<{ key: string; name: string; color: string; visible: boolean }[]>(() => {
    const cols = widget?.cachedData?.columns;
    const dataCols = Array.isArray(cols) && cols.length > 1 ? cols.slice(1) : [];
    const savedNames = cfg.seriesNames || [];
    const savedColors = cfg.colors || [];
    const hiddenSet = new Set<string>(cfg.hiddenSeries || []);
    return dataCols.map((col: string, i: number) => ({
      key: col,
      name: savedNames[i] || col,
      color: savedColors[i] || '',
      visible: !hiddenSet.has(col),
    }));
  });

  // Metric card fields
  const [mcIcon, setMcIcon] = useState<string>(cfg.icon || metricData?.icon || '');
  const [mcValue, setMcValue] = useState<string>(String(cfg.value ?? metricData?.value ?? ''));
  const [mcUnit, setMcUnit] = useState<string>(cfg.unit ?? metricData?.unit ?? '');
  const [mcSubtitle, setMcSubtitle] = useState<string>(cfg.subtitle ?? metricData?.subtitle ?? '');
  const [mcTrend, setMcTrend] = useState<string>(cfg.trend ?? metricData?.trend ?? '');
  const [mcTrendValue, setMcTrendValue] = useState<string>(cfg.trendValue ?? metricData?.trendValue ?? '');
  const [mcFootnote, setMcFootnote] = useState<string>(cfg.footnote ?? '');

  // Data source
  const [dsType, setDsType] = useState(widget?.dataSource?.type || 'static');
  const [dsMcpName, setDsMcpName] = useState(widget?.dataSource?.mcp_name || '');
  const [dsQuery, setDsQuery] = useState(widget?.dataSource?.query || '');
  const [dsStaticData, setDsStaticData] = useState(
    widget?.dataSource?.type === 'static' ? JSON.stringify(widget.dataSource.data || {}, null, 2) : ''
  );

  const [saving, setSaving] = useState(false);

  const isMetric = widgetType === 'metric_card' || widget?.widgetType === 'metric_card';

  // === Drag logic ===
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [size, setSize] = useState({ w: 520, h: 600 });
  const dragState = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeState = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).tagName === 'BUTTON' || (e.target as HTMLElement).tagName === 'INPUT') return;
    dragState.current = { startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      setPos({ x: dragState.current.origX + ev.clientX - dragState.current.startX, y: dragState.current.origY + ev.clientY - dragState.current.startY });
    };
    const onUp = () => { dragState.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [pos]);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    resizeState.current = { startX: e.clientX, startY: e.clientY, origW: size.w, origH: size.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeState.current) return;
      setSize({
        w: Math.max(400, resizeState.current.origW + ev.clientX - resizeState.current.startX),
        h: Math.max(350, resizeState.current.origH + ev.clientY - resizeState.current.startY),
      });
    };
    const onUp = () => { resizeState.current = null; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [size]);

  // === Save ===
  const handleSave = async () => {
    setSaving(true);
    const config: any = {};

    if (isMetric) {
      if (mcIcon) config.icon = mcIcon;
      if (mcFootnote) config.footnote = mcFootnote;
      if (mcValue) config.value = mcValue;
      if (mcUnit) config.unit = mcUnit;
      if (mcSubtitle) config.subtitle = mcSubtitle;
      if (mcTrend) config.trend = mcTrend;
      if (mcTrendValue) config.trendValue = mcTrendValue;

      const updates: any = { title, config, refreshInterval };
      if (isNew) updates.widgetType = 'metric_card';

      if (dsType === 'mcp') updates.dataSource = { type: 'mcp', mcp_name: dsMcpName, query: dsQuery };
      else if (dsType === 'sql') updates.dataSource = { type: 'sql', query: dsQuery };
      else {
        const staticData: any = {};
        if (mcValue) staticData.value = isNaN(Number(mcValue)) ? mcValue : Number(mcValue);
        if (mcUnit) staticData.unit = mcUnit;
        if (mcSubtitle) staticData.subtitle = mcSubtitle;
        if (mcTrend) staticData.trend = mcTrend;
        if (mcTrendValue) staticData.trendValue = mcTrendValue;
        if (mcIcon) staticData.icon = mcIcon;
        updates.dataSource = { type: 'static', data: staticData };
      }

      await onSave(updates);
      setSaving(false);
      return;
    }

    // Chart config from series list
    if (seriesList.length > 0) {
      config.seriesNames = seriesList.map(s => s.name);
      const seriesColors = seriesList.map(s => s.color).filter(Boolean);
      if (seriesColors.length > 0) config.colors = seriesColors;
      const hidden = seriesList.filter(s => !s.visible).map(s => s.key);
      if (hidden.length > 0) config.hiddenSeries = hidden;
    }
    if (colors.length > 0 && seriesList.every(s => !s.color)) config.colors = colors;
    config.legend = { show: legendShow, ...(legendPosition === 'bottom' ? { bottom: 0 } : { top: 0 }) };
    if (smooth) config.smooth = true;
    if (yAxisName) config.yAxis = { name: yAxisName };
    if (xAxisName) config.xAxis = { name: xAxisName };
    if (stacked) config.stacked = true;
    if (!showGrid) config.grid = { show: false };
    if (tooltipFormat) config.tooltipSuffix = tooltipFormat;

    const updates: any = { title, config, refreshInterval };
    if (isNew) updates.widgetType = widgetType;

    if (dsType === 'mcp') updates.dataSource = { type: 'mcp', mcp_name: dsMcpName, query: dsQuery };
    else if (dsType === 'sql') updates.dataSource = { type: 'sql', query: dsQuery };
    else if (dsType === 'static') {
      try { updates.dataSource = { type: 'static', data: JSON.parse(dsStaticData || '{}') }; } catch {}
    }

    await onSave(updates);
    setSaving(false);
  };

  const addColor = () => {
    const unused = PRESET_COLORS.filter(c => !colors.includes(c));
    if (unused.length > 0) setColors([...colors, unused[0]]);
  };

  return (
    <div className="fixed inset-0 bg-black/20 z-50 flex items-center justify-center">
      <div ref={dialogRef}
        className="bg-white rounded-xl shadow-2xl flex flex-col overflow-hidden border border-gray-200 absolute"
        style={{ width: size.w, height: size.h, transform: `translate(${pos.x}px, ${pos.y}px)` }}>

        {/* Header — draggable */}
        <div className="flex items-center px-5 py-2.5 border-b border-gray-200 cursor-move select-none shrink-0 bg-gray-50"
          onMouseDown={onDragStart}>
          <h3 className="text-sm font-medium flex-1">{isNew ? '新建仪表' : '编辑仪表'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-0">
          {/* Title */}
          <div>
            <label className="text-[11px] text-gray-500 block mb-1">标题</label>
            <input value={title} onChange={e => setTitle(e.target.value)}
              className="w-full border border-gray-200 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-400" />
          </div>

          {/* Chart type (new only) */}
          {isNew && (
            <div>
              <label className="text-[11px] text-gray-500 block mb-1">图表类型</label>
              <div className="flex flex-wrap gap-1.5">
                {CHART_TYPES.map(t => (
                  <button key={t.value} onClick={() => setWidgetType(t.value)}
                    className={`text-xs px-2.5 py-1 rounded border ${widgetType === t.value ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ========== METRIC CARD FIELDS ========== */}
          {isMetric && (
            <>
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">图标</label>
                <div className="flex flex-wrap gap-1 items-center">
                  {PRESET_ICONS.map(icon => (
                    <button key={icon} onClick={() => setMcIcon(icon)}
                      className={`w-8 h-8 rounded border text-lg flex items-center justify-center ${mcIcon === icon ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 hover:border-gray-300'}`}>
                      {icon}
                    </button>
                  ))}
                  {mcIcon && <button onClick={() => setMcIcon('')} className="text-[10px] text-gray-400 hover:text-red-500 ml-1">清除</button>}
                </div>
              </div>

              <div className="text-[10px] text-indigo-400 bg-indigo-50 rounded px-2 py-1">
                支持数据绑定：用 <code className="font-mono bg-white px-1 rounded">{'#{字段名}'}</code> 引用 SQL 返回的字段值
              </div>

              <div className="flex gap-3">
                <div className="flex-1">
                  <label className="text-[11px] text-gray-500 block mb-1">主内容</label>
                  <input value={mcValue} onChange={e => setMcValue(e.target.value)}
                    className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-400" placeholder="如 1280 或 #{count}" />
                </div>
                <div className="w-20">
                  <label className="text-[11px] text-gray-500 block mb-1">单位</label>
                  <input value={mcUnit} onChange={e => setMcUnit(e.target.value)}
                    className="w-full border border-gray-200 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-indigo-400" placeholder="条" />
                </div>
              </div>

              <div>
                <label className="text-[11px] text-gray-500 block mb-1">副内容</label>
                <input value={mcSubtitle} onChange={e => setMcSubtitle(e.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400" placeholder="如: 较上月 或 #{desc}" />
              </div>

              <div>
                <label className="text-[11px] text-gray-500 block mb-1">趋势</label>
                <div className="flex items-center gap-3">
                  <div className="flex gap-1 shrink-0">
                    {[['↑', '升'], ['↓', '降'], ['→', '平'], ['', '无']].map(([v, l]) => (
                      <button key={l} onClick={() => setMcTrend(v)}
                        className={`text-xs px-2.5 py-1 rounded border ${mcTrend === v ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-200 text-gray-400'}`}>
                        {v || '—'} {l}
                      </button>
                    ))}
                  </div>
                  <input value={mcTrendValue} onChange={e => setMcTrendValue(e.target.value)}
                    className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400" placeholder="趋势值，如 +12.5% 或 #{rate}" />
                </div>
              </div>

              <div>
                <label className="text-[11px] text-gray-500 block mb-1">底部附加说明（可选）</label>
                <input value={mcFootnote} onChange={e => setMcFootnote(e.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400" placeholder="如: 数据截止至昨日" />
              </div>
            </>
          )}

          {/* ========== CHART FIELDS ========== */}
          {!isMetric && (
            <>
              {/* Series list: name + color + visible */}
              {seriesList.length > 0 && (
                <div>
                  <label className="text-[11px] text-gray-500 block mb-1">系列设置</label>
                  <div className="space-y-1.5">
                    {seriesList.map((s, i) => (
                      <div key={s.key} className="flex items-center gap-2">
                        <Toggle value={s.visible} onChange={v => {
                          const ns = [...seriesList]; ns[i] = { ...ns[i], visible: v }; setSeriesList(ns);
                        }} />
                        <input value={s.name} onChange={e => {
                          const ns = [...seriesList]; ns[i] = { ...ns[i], name: e.target.value }; setSeriesList(ns);
                        }}
                          className={`flex-1 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400 ${!s.visible ? 'opacity-40 line-through' : ''}`}
                          placeholder={s.key} />
                        <input type="color" value={s.color || PRESET_COLORS[i % PRESET_COLORS.length]} onChange={e => {
                          const ns = [...seriesList]; ns[i] = { ...ns[i], color: e.target.value }; setSeriesList(ns);
                        }}
                          className="w-6 h-6 rounded border border-gray-200 cursor-pointer shrink-0" />
                        <span className="text-[9px] text-gray-300 w-12 truncate" title={s.key}>{s.key}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Legend + Grid + Stack toggles */}
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-gray-500">图例</label>
                  <Toggle value={legendShow} onChange={setLegendShow} />
                  {legendShow && (
                    <select value={legendPosition} onChange={e => setLegendPosition(e.target.value)}
                      className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 ml-1">
                      <option value="top">顶部</option>
                      <option value="bottom">底部</option>
                    </select>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-gray-500">网格线</label>
                  <Toggle value={showGrid} onChange={setShowGrid} />
                </div>
                {(widgetType === 'bar' || widgetType === 'line' || widgetType === 'curve') && (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-gray-500">堆叠</label>
                    <Toggle value={stacked} onChange={setStacked} />
                  </div>
                )}
                {(widgetType === 'line' || widgetType === 'curve') && (
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-gray-500">平滑</label>
                    <Toggle value={smooth} onChange={setSmooth} />
                  </div>
                )}
              </div>

              {/* Axis names */}
              {(widgetType === 'line' || widgetType === 'curve' || widgetType === 'bar') && (
                <div className="flex gap-3">
                  <div className="flex-1">
                    <label className="text-[11px] text-gray-500 block mb-1">X轴名称</label>
                    <input value={xAxisName} onChange={e => setXAxisName(e.target.value)}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400" placeholder="可选" />
                  </div>
                  <div className="flex-1">
                    <label className="text-[11px] text-gray-500 block mb-1">Y轴名称</label>
                    <input value={yAxisName} onChange={e => setYAxisName(e.target.value)}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400" placeholder="可选" />
                  </div>
                </div>
              )}

              {/* Tooltip suffix */}
              <div>
                <label className="text-[11px] text-gray-500 block mb-1">提示框后缀（tooltip 数值后面追加的文字）</label>
                <input value={tooltipFormat} onChange={e => setTooltipFormat(e.target.value)}
                  className="w-40 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400" placeholder="如 % 或 件" />
              </div>
            </>
          )}

          {/* Refresh interval */}
          <div>
            <label className="text-[11px] text-gray-500 block mb-1">自动刷新间隔（秒，0=不自动刷新）</label>
            <input type="number" value={refreshInterval} onChange={e => setRefreshInterval(parseInt(e.target.value) || 0)}
              className="w-32 border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400" />
          </div>

          {/* Data source */}
          <div>
            <label className="text-[11px] text-gray-500 block mb-1">数据源</label>
            <div className="flex gap-1.5 mb-2">
              {[['static', '静态数据'], ['mcp', '外部数据库'], ['sql', '系统SQL']].map(([v, l]) => (
                <button key={v} onClick={() => setDsType(v)}
                  className={`text-[11px] px-2 py-0.5 rounded border ${dsType === v ? 'border-indigo-500 text-indigo-600 bg-indigo-50' : 'border-gray-200 text-gray-400'}`}>
                  {l}
                </button>
              ))}
            </div>
            {dsType === 'mcp' && (
              <div className="space-y-2">
                <input value={dsMcpName} onChange={e => setDsMcpName(e.target.value)}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-xs focus:outline-none focus:border-indigo-400"
                  placeholder="MCP 名称，如 db-MOM-dev" />
                <textarea value={dsQuery} onChange={e => setDsQuery(e.target.value)} rows={3}
                  className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-indigo-400 resize-y"
                  placeholder="SELECT ..." />
              </div>
            )}
            {dsType === 'sql' && (
              <textarea value={dsQuery} onChange={e => setDsQuery(e.target.value)} rows={3}
                className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-indigo-400 resize-y"
                placeholder="SELECT ..." />
            )}
            {dsType === 'static' && (
              <textarea value={dsStaticData} onChange={e => setDsStaticData(e.target.value)} rows={4}
                className="w-full border border-gray-200 rounded px-2 py-1 text-xs font-mono focus:outline-none focus:border-indigo-400 resize-y"
                placeholder='{"xAxis":["1月","2月"],"series":[{"name":"销量","data":[10,20]}]}' />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-2.5 border-t border-gray-200 shrink-0">
          <button onClick={onClose} className="text-xs px-3 py-1.5 text-gray-500 hover:text-gray-700">取消</button>
          <button onClick={handleSave} disabled={saving || !title.trim()}
            className="text-xs px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中...' : isNew ? '创建' : '保存'}
          </button>
        </div>

        {/* Resize handle */}
        <div className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize" onMouseDown={onResizeStart}>
          <svg viewBox="0 0 16 16" className="w-full h-full text-gray-300">
            <path d="M14 14L8 14L14 8Z" fill="currentColor" />
            <path d="M14 14L11 14L14 11Z" fill="currentColor" opacity="0.5" />
          </svg>
        </div>
      </div>
    </div>
  );
}
