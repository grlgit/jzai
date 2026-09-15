'use client';

import { useState } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

interface PdfTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  isSystem: boolean;
  page: { size: string; orientation: string; margins: number[] };
  header?: { left?: string; right?: string; logo?: boolean; borderBottom?: boolean };
  footer?: { center?: string; right?: string };
  styles?: Record<string, any>;
  sections: any[];
}

const SECTION_TYPES = [
  { type: 'heading', label: '标题', icon: 'H' },
  { type: 'paragraph', label: '段落', icon: '¶' },
  { type: 'table', label: '表格', icon: '▦' },
  { type: 'chart', label: '图表', icon: '📈' },
  { type: 'key_values', label: '指标卡', icon: '🔢' },
  { type: 'image', label: '图片', icon: '🖼' },
  { type: 'page_break', label: '分页符', icon: '⏎' },
];

const ICONS = ['📄', '📊', '📋', '📦', '💰', '📈', '🏭', '🔬', '📝', '🎯', '⚙️', '🛒', '👥', '📅', '🏗️', '🔧'];

const COLOR_PRESETS = ['#F0F0F0', '#E8EAF6', '#E3F2FD', '#E8F5E9', '#FFF3E0', '#FCE4EC', '#F3E5F5', '#4472C4', '#2E75B6', '#ED7D31', '#70AD47', '#FF6B6B'];

interface PdfTemplateEditorProps {
  template: PdfTemplate | null;  // null = new template
  readOnly?: boolean;
  onClose: () => void;
  onSave: (data: Partial<PdfTemplate>) => void;
}

export default function PdfTemplateEditor({ template, readOnly, onClose, onSave }: PdfTemplateEditorProps) {
  const [name, setName] = useState(template?.name || '');
  const [description, setDescription] = useState(template?.description || '');
  const [icon, setIcon] = useState(template?.icon || '📄');
  const [pageSize, setPageSize] = useState(template?.page?.size || 'A4');
  const [orientation, setOrientation] = useState(template?.page?.orientation || 'portrait');
  const [margins, setMargins] = useState(template?.page?.margins || [40, 60, 40, 60]);
  const [headerLeft, setHeaderLeft] = useState(template?.header?.left || '');
  const [headerRight, setHeaderRight] = useState(template?.header?.right || '');
  const [headerLogo, setHeaderLogo] = useState(template?.header?.logo || false);
  const [headerBorder, setHeaderBorder] = useState(template?.header?.borderBottom || false);
  const [footerCenter, setFooterCenter] = useState(template?.footer?.center || '第 {{page}} 页 / 共 {{pages}} 页');
  const [footerRight, setFooterRight] = useState(template?.footer?.right || '');
  const [sections, setSections] = useState<any[]>(template?.sections ? JSON.parse(JSON.stringify(template.sections)) : []);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const handleSave = () => {
    if (!name.trim() || readOnly) return;
    onSave({
      name: name.trim(),
      description: description.trim(),
      icon,
      page: { size: pageSize, orientation, margins },
      header: { left: headerLeft, right: headerRight, logo: headerLogo, borderBottom: headerBorder },
      footer: { center: footerCenter, right: footerRight },
      sections,
    });
  };

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Generate a preview PDF with sample data
      const previewSpec = {
        filename: `预览_${name || '模板'}.pdf`,
        sections: sections.map(s => {
          const resolved = { ...s };
          // Replace {{var}} with sample values for preview
          if (typeof resolved.text === 'string') {
            resolved.text = resolved.text.replace(/\{\{(\w+)\}\}/g, '[$1]');
          }
          if (typeof resolved.data_source === 'string' && resolved.data_source.startsWith('{{')) {
            resolved.data_source = undefined; // Skip SQL vars in preview
          }
          if (typeof resolved.mcp === 'string' && resolved.mcp.startsWith('{{')) {
            resolved.mcp = undefined;
          }
          // For key_values, fill sample items if empty
          if (resolved.type === 'key_values' && (!resolved.items || resolved.items.length === 0)) {
            resolved.items = [{ label: '示例指标1', value: '100' }, { label: '示例指标2', value: '200' }];
          }
          return resolved;
        }),
        page: { size: pageSize, orientation, margins },
        header: { left: headerLeft.replace(/\{\{(\w+)\}\}/g, '[$1]'), right: headerRight.replace(/\{\{(\w+)\}\}/g, '[$1]') },
        footer: { center: footerCenter, right: footerRight },
      };

      const resp = await fetch(`${MAIN_URL}/api/pdf-exports/preview`, {
        method: 'POST', headers, body: JSON.stringify(previewSpec),
      });

      if (resp.ok) {
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch {}
    setPreviewing(false);
  };

  const moveSection = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= sections.length) return;
    const updated = [...sections];
    [updated[idx], updated[newIdx]] = [updated[newIdx], updated[idx]];
    setSections(updated);
  };

  const removeSection = (idx: number) => {
    setSections(sections.filter((_, i) => i !== idx));
  };

  const updateSection = (idx: number, field: string, value: any) => {
    setSections(sections.map((s, i) => i === idx ? { ...s, [field]: value } : s));
  };

  const updateSectionStyle = (idx: number, styleField: string, value: any) => {
    setSections(sections.map((s, i) => {
      if (i !== idx) return s;
      const style = { ...(s.style || {}) };
      if (value === '' || value === undefined) { delete style[styleField]; }
      else { style[styleField] = value; }
      return { ...s, style: Object.keys(style).length > 0 ? style : undefined };
    }));
  };

  const addSection = (type: string) => {
    const defaults: Record<string, any> = {
      heading: { type: 'heading', level: 1, text: '' },
      paragraph: { type: 'paragraph', text: '' },
      table: { type: 'table', data_source: '', mcp: '' },
      chart: { type: 'chart', chartType: 'bar', data_source: '', mcp: '', title: '' },
      key_values: { type: 'key_values', title: '', items: [{ label: '', value: '' }], layout: 'grid' },
      image: { type: 'image', base64: '', caption: '' },
      page_break: { type: 'page_break' },
    };
    setSections([...sections, defaults[type] || { type }]);
    setShowAddMenu(false);
  };

  const duplicateSection = (idx: number) => {
    const copy = JSON.parse(JSON.stringify(sections[idx]));
    const updated = [...sections];
    updated.splice(idx + 1, 0, copy);
    setSections(updated);
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-xl shadow-2xl w-[680px] max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-100 shrink-0">
          <h3 className="text-sm font-medium">
            {readOnly ? '查看模板' : template ? '编辑模板' : '新建模板'}
            {readOnly && <span className="ml-2 text-[10px] text-gray-400 font-normal">(只读)</span>}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
        </div>

        {/* Body — scrollable */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Basic info */}
          <div className="grid grid-cols-[auto_1fr] gap-3 items-start">
            <div className="relative">
              <button onClick={() => !readOnly && setShowIconPicker(!showIconPicker)} disabled={readOnly}
                className="w-12 h-12 rounded-lg border border-gray-200 flex items-center justify-center text-2xl hover:border-indigo-300 disabled:hover:border-gray-200">
                {icon}
              </button>
              {showIconPicker && !readOnly && (
                <div className="absolute top-14 left-0 bg-white border border-gray-200 rounded-lg shadow-lg p-2 grid grid-cols-8 gap-1 z-10">
                  {ICONS.map(i => (
                    <button key={i} onClick={() => { setIcon(i); setShowIconPicker(false); }}
                      className="w-8 h-8 rounded hover:bg-gray-100 flex items-center justify-center text-lg">
                      {i}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <input type="text" value={name} onChange={e => setName(e.target.value)} readOnly={readOnly}
                placeholder="模板名称" className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-indigo-400 read-only:bg-gray-50" />
              <input type="text" value={description} onChange={e => setDescription(e.target.value)} readOnly={readOnly}
                placeholder="用途说明" className="w-full border border-gray-200 rounded-lg px-3 py-1.5 text-xs text-gray-500 focus:outline-none focus:border-indigo-400 read-only:bg-gray-50" />
            </div>
          </div>

          {/* Page settings */}
          <fieldset className="border border-gray-100 rounded-lg p-3">
            <legend className="text-xs font-medium text-gray-500 px-1">页面设置</legend>
            <div className="flex items-center gap-3 flex-wrap">
              <label className="text-xs text-gray-500">纸张</label>
              <select value={pageSize} onChange={e => setPageSize(e.target.value)} disabled={readOnly}
                className="text-xs border border-gray-200 rounded px-2 py-1 disabled:bg-gray-50">
                <option value="A4">A4</option>
                <option value="A3">A3</option>
                <option value="LETTER">Letter</option>
              </select>
              <label className="text-xs text-gray-500">方向</label>
              <select value={orientation} onChange={e => setOrientation(e.target.value)} disabled={readOnly}
                className="text-xs border border-gray-200 rounded px-2 py-1 disabled:bg-gray-50">
                <option value="portrait">纵向</option>
                <option value="landscape">横向</option>
              </select>
              <label className="text-xs text-gray-500">边距</label>
              {['左', '上', '右', '下'].map((label, i) => (
                <input key={i} type="number" value={margins[i]} readOnly={readOnly} onChange={e => {
                  const m = [...margins]; m[i] = Number(e.target.value); setMargins(m);
                }} className="w-10 text-xs border border-gray-200 rounded px-1 py-1 text-center read-only:bg-gray-50" title={label} />
              ))}
            </div>
          </fieldset>

          {/* Header */}
          <fieldset className="border border-gray-100 rounded-lg p-3">
            <legend className="text-xs font-medium text-gray-500 px-1">页眉</legend>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={headerLeft} onChange={e => setHeaderLeft(e.target.value)} readOnly={readOnly}
                placeholder={'左侧文本，如 {{company_name}}'} className="text-xs border border-gray-200 rounded px-2 py-1 read-only:bg-gray-50" />
              <input type="text" value={headerRight} onChange={e => setHeaderRight(e.target.value)} readOnly={readOnly}
                placeholder={'右侧文本，如 {{report_date}}'} className="text-xs border border-gray-200 rounded px-2 py-1 read-only:bg-gray-50" />
            </div>
            <div className="flex items-center gap-4 mt-2">
              <label className="flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={headerLogo} onChange={e => setHeaderLogo(e.target.checked)} disabled={readOnly} className="rounded" />
                显示Logo
              </label>
              <label className="flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={headerBorder} onChange={e => setHeaderBorder(e.target.checked)} disabled={readOnly} className="rounded" />
                底部分割线
              </label>
            </div>
          </fieldset>

          {/* Footer */}
          <fieldset className="border border-gray-100 rounded-lg p-3">
            <legend className="text-xs font-medium text-gray-500 px-1">页脚</legend>
            <div className="grid grid-cols-2 gap-2">
              <input type="text" value={footerCenter} onChange={e => setFooterCenter(e.target.value)} readOnly={readOnly}
                placeholder="居中文本" className="text-xs border border-gray-200 rounded px-2 py-1 read-only:bg-gray-50" />
              <input type="text" value={footerRight} onChange={e => setFooterRight(e.target.value)} readOnly={readOnly}
                placeholder="右侧文本" className="text-xs border border-gray-200 rounded px-2 py-1 read-only:bg-gray-50" />
            </div>
          </fieldset>

          {/* Sections */}
          <fieldset className="border border-gray-100 rounded-lg p-3">
            <legend className="text-xs font-medium text-gray-500 px-1">内容区块 ({sections.length})</legend>
            <div className="space-y-2">
              {sections.map((section, idx) => (
                <SectionRow
                  key={idx}
                  index={idx}
                  section={section}
                  total={sections.length}
                  readOnly={readOnly}
                  onMove={moveSection}
                  onRemove={removeSection}
                  onUpdate={updateSection}
                  onUpdateStyle={updateSectionStyle}
                  onDuplicate={duplicateSection}
                />
              ))}
            </div>

            {!readOnly && (
              <div className="relative mt-3">
                <button onClick={() => setShowAddMenu(!showAddMenu)}
                  className="text-xs px-3 py-1.5 rounded border border-dashed border-gray-300 text-gray-400 hover:text-indigo-600 hover:border-indigo-300 w-full">
                  + 添加区块
                </button>
                {showAddMenu && (
                  <div className="absolute bottom-10 left-0 bg-white border border-gray-200 rounded-lg shadow-lg py-1 w-48 z-10">
                    {SECTION_TYPES.map(st => (
                      <button key={st.type} onClick={() => addSection(st.type)}
                        className="w-full text-left px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50 hover:text-indigo-600 flex items-center gap-2">
                        <span className="w-5 text-center">{st.icon}</span> {st.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </fieldset>
        </div>

        {/* Footer buttons */}
        <div className="flex items-center gap-2 px-5 py-3 border-t border-gray-100 shrink-0">
          <button onClick={handlePreview} disabled={previewing || sections.length === 0}
            className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 disabled:opacity-40">
            {previewing ? '生成中...' : '预览'}
          </button>
          <div className="flex-1" />
          <button onClick={onClose}
            className="text-xs px-4 py-1.5 text-gray-500 hover:text-gray-700">{readOnly ? '关闭' : '取消'}</button>
          {!readOnly && (
            <button onClick={handleSave} disabled={!name.trim()}
              className="text-xs px-4 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-40">
              保存
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionRow({ index, section, total, readOnly, onMove, onRemove, onUpdate, onUpdateStyle, onDuplicate }: {
  index: number;
  section: any;
  total: number;
  readOnly?: boolean;
  onMove: (idx: number, dir: -1 | 1) => void;
  onRemove: (idx: number) => void;
  onUpdate: (idx: number, field: string, value: any) => void;
  onUpdateStyle: (idx: number, field: string, value: any) => void;
  onDuplicate: (idx: number) => void;
}) {
  const [showStyle, setShowStyle] = useState(false);
  const typeInfo = SECTION_TYPES.find(st => st.type === section.type);
  const hasStyle = section.type === 'heading' || section.type === 'paragraph';

  return (
    <div className="border border-gray-100 rounded-lg p-2.5 bg-gray-50/50">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="text-xs font-medium text-gray-400 w-5 text-center">{index + 1}.</span>
        <span className="text-xs font-medium text-gray-600">{typeInfo?.label || section.type}</span>
        {section.style?.backgroundColor && (
          <span className="w-3 h-3 rounded-sm border border-gray-200" style={{ backgroundColor: section.style.backgroundColor }} />
        )}
        <div className="flex-1" />
        {!readOnly && (
          <>
            {hasStyle && (
              <button onClick={() => setShowStyle(!showStyle)} title="样式"
                className={`text-[10px] px-1 rounded ${showStyle ? 'text-indigo-600 bg-indigo-50' : 'text-gray-400 hover:text-gray-600'}`}>
                🎨
              </button>
            )}
            <button onClick={() => onDuplicate(index)} title="复制区块"
              className="text-[10px] text-gray-400 hover:text-gray-600">⧉</button>
            <button onClick={() => onMove(index, -1)} disabled={index === 0}
              className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-30">↑</button>
            <button onClick={() => onMove(index, 1)} disabled={index === total - 1}
              className="text-[10px] text-gray-400 hover:text-gray-600 disabled:opacity-30">↓</button>
            <button onClick={() => onRemove(index)}
              className="text-[10px] text-gray-400 hover:text-red-500">✕</button>
          </>
        )}
      </div>

      {/* Style panel */}
      {showStyle && hasStyle && !readOnly && (
        <div className="flex items-center gap-2 mb-2 p-2 bg-white rounded border border-gray-100">
          <label className="text-[10px] text-gray-400 shrink-0">底色</label>
          <div className="flex gap-1 flex-wrap">
            <button onClick={() => onUpdateStyle(index, 'backgroundColor', '')}
              className={`w-4 h-4 rounded-sm border ${!section.style?.backgroundColor ? 'border-indigo-400' : 'border-gray-200'}`}
              style={{ background: 'repeating-conic-gradient(#ccc 0% 25%, white 0% 50%) 50%/8px 8px' }} title="无" />
            {COLOR_PRESETS.map(c => (
              <button key={c} onClick={() => onUpdateStyle(index, 'backgroundColor', c)}
                className={`w-4 h-4 rounded-sm border ${section.style?.backgroundColor === c ? 'border-indigo-400 ring-1 ring-indigo-300' : 'border-gray-200'}`}
                style={{ backgroundColor: c }} />
            ))}
          </div>
          <label className="text-[10px] text-gray-400 shrink-0 ml-2">字号</label>
          <input type="number" value={section.style?.fontSize || ''} onChange={e => onUpdateStyle(index, 'fontSize', e.target.value ? Number(e.target.value) : undefined)}
            placeholder="默认" className="w-12 text-[10px] border border-gray-200 rounded px-1 py-0.5 text-center" />
          <label className="flex items-center gap-0.5 text-[10px] text-gray-400 shrink-0">
            <input type="checkbox" checked={!!section.style?.bold} onChange={e => onUpdateStyle(index, 'bold', e.target.checked || undefined)} className="rounded w-3 h-3" />
            粗体
          </label>
        </div>
      )}

      {/* Type-specific fields */}
      {section.type === 'heading' && (
        <div className="flex items-center gap-2">
          <select value={section.level || 1} onChange={e => onUpdate(index, 'level', Number(e.target.value))} disabled={readOnly}
            className="text-xs border border-gray-200 rounded px-1.5 py-0.5 w-16 disabled:bg-gray-50">
            <option value={1}>H1</option>
            <option value={2}>H2</option>
            <option value={3}>H3</option>
          </select>
          <input type="text" value={section.text || ''} onChange={e => onUpdate(index, 'text', e.target.value)} readOnly={readOnly}
            placeholder="标题文本，如 {{title}}" className="flex-1 text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
        </div>
      )}

      {section.type === 'paragraph' && (
        <textarea value={section.text || ''} onChange={e => onUpdate(index, 'text', e.target.value)} readOnly={readOnly}
          placeholder="段落文本" rows={2}
          className="w-full text-xs border border-gray-200 rounded px-2 py-1 resize-none read-only:bg-gray-50" />
      )}

      {section.type === 'table' && (
        <div className="space-y-1">
          <input type="text" value={section.data_source || ''} onChange={e => onUpdate(index, 'data_source', e.target.value)} readOnly={readOnly}
            placeholder={'SQL查询，如 {{detail_sql}}'} className="w-full text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
          <input type="text" value={section.mcp || ''} onChange={e => onUpdate(index, 'mcp', e.target.value)} readOnly={readOnly}
            placeholder={'MCP名称，如 {{mcp_name}}'} className="w-full text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
        </div>
      )}

      {section.type === 'chart' && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <select value={section.chartType || 'bar'} onChange={e => onUpdate(index, 'chartType', e.target.value)} disabled={readOnly}
              className="text-xs border border-gray-200 rounded px-1.5 py-0.5 disabled:bg-gray-50">
              <option value="bar">柱状图</option>
              <option value="line">折线图</option>
              <option value="pie">饼图</option>
              <option value="area">面积图</option>
              <option value="stacked_bar">堆叠柱状图</option>
            </select>
            <input type="text" value={section.title || ''} onChange={e => onUpdate(index, 'title', e.target.value)} readOnly={readOnly}
              placeholder="图表标题" className="flex-1 text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
          </div>
          <input type="text" value={section.data_source || ''} onChange={e => onUpdate(index, 'data_source', e.target.value)} readOnly={readOnly}
            placeholder="SQL查询" className="w-full text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
          <input type="text" value={section.mcp || ''} onChange={e => onUpdate(index, 'mcp', e.target.value)} readOnly={readOnly}
            placeholder="MCP名称" className="w-full text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
        </div>
      )}

      {section.type === 'key_values' && (
        <KeyValuesEditor
          section={section}
          index={index}
          readOnly={readOnly}
          onUpdate={onUpdate}
        />
      )}

      {section.type === 'image' && (
        <input type="text" value={section.caption || ''} onChange={e => onUpdate(index, 'caption', e.target.value)} readOnly={readOnly}
          placeholder="图片说明" className="w-full text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
      )}

      {section.type === 'page_break' && (
        <div className="text-[10px] text-gray-400 text-center">— 分页 —</div>
      )}
    </div>
  );
}

/** Inline editor for key_values items */
function KeyValuesEditor({ section, index, readOnly, onUpdate }: {
  section: any; index: number; readOnly?: boolean;
  onUpdate: (idx: number, field: string, value: any) => void;
}) {
  const items: { label: string; value: string }[] = section.items || [];
  const layout = section.layout || 'grid';

  const setItems = (newItems: { label: string; value: string }[]) => {
    onUpdate(index, 'items', newItems);
  };

  const updateItem = (i: number, field: 'label' | 'value', val: string) => {
    setItems(items.map((item, j) => j === i ? { ...item, [field]: val } : item));
  };

  const removeItem = (i: number) => {
    setItems(items.filter((_, j) => j !== i));
  };

  const addItem = () => {
    setItems([...items, { label: '', value: '' }]);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input type="text" value={section.title || ''} onChange={e => onUpdate(index, 'title', e.target.value)} readOnly={readOnly}
          placeholder="区块标题" className="flex-1 text-xs border border-gray-200 rounded px-2 py-0.5 read-only:bg-gray-50" />
        <select value={layout} onChange={e => onUpdate(index, 'layout', e.target.value)} disabled={readOnly}
          className="text-xs border border-gray-200 rounded px-1.5 py-0.5 disabled:bg-gray-50">
          <option value="grid">网格(2列)</option>
          <option value="list">列表</option>
        </select>
      </div>

      {/* Items list */}
      <div className="space-y-1 ml-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <input type="text" value={item.label} onChange={e => updateItem(i, 'label', e.target.value)} readOnly={readOnly}
              placeholder="标签" className="w-28 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 read-only:bg-gray-50" />
            <span className="text-gray-300 text-[10px]">:</span>
            <input type="text" value={item.value} onChange={e => updateItem(i, 'value', e.target.value)} readOnly={readOnly}
              placeholder={'值或 {{变量名}}'} className="flex-1 text-[11px] border border-gray-200 rounded px-1.5 py-0.5 read-only:bg-gray-50" />
            {!readOnly && (
              <button onClick={() => removeItem(i)} className="text-[10px] text-gray-300 hover:text-red-400">✕</button>
            )}
          </div>
        ))}
      </div>

      {!readOnly && (
        <button onClick={addItem} className="text-[10px] text-gray-400 hover:text-indigo-600 ml-2">+ 添加指标项</button>
      )}
    </div>
  );
}
