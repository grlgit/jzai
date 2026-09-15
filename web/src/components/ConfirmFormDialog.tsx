'use client';

import React, { useState, useCallback, useEffect } from 'react';
import type { ConfirmFormField, ConfirmFormColumn } from '@/hooks/useChat';

interface ParameterDef {
  name: string;
  type: string;
  required?: boolean;
  description?: string;
  label?: string;
}

export interface ConfirmFormProps {
  toolName: string;
  description?: string;
  args: Record<string, any>;
  parameters: ParameterDef[];
  confirmForm?: ConfirmFormField[];
  onConfirm: (editedArgs: Record<string, any>) => void;
  onCancel: () => void;
}

// ── Path utilities for nested object access ──

function getByPath(obj: any, path: string): any {
  if (obj == null) return undefined;
  // First check if the full dot-path exists as a flat key (LLM may pass "goHd.style.styleNo" as key name)
  if (path in obj) return obj[path];
  // Then try nested path traversal
  return path.split('.').reduce((o, k) => {
    if (o == null) return undefined;
    const m = k.match(/^(.+)\[(\d+)\]$/);
    if (m) return o[m[1]]?.[parseInt(m[2])];
    return o[k];
  }, obj);
}

function setByPath(obj: any, path: string, value: any): any {
  const clone = JSON.parse(JSON.stringify(obj));
  const keys = path.split('.');
  let cur = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const m = keys[i].match(/^(.+)\[(\d+)\]$/);
    if (m) {
      if (!cur[m[1]]) cur[m[1]] = [];
      while (cur[m[1]].length <= parseInt(m[2])) cur[m[1]].push({});
      cur = cur[m[1]][parseInt(m[2])];
    } else {
      if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
      cur = cur[keys[i]];
    }
  }
  const lastKey = keys[keys.length - 1];
  const lm = lastKey.match(/^(.+)\[(\d+)\]$/);
  if (lm) {
    if (!cur[lm[1]]) cur[lm[1]] = [];
    cur[lm[1]][parseInt(lm[2])] = value;
  } else {
    cur[lastKey] = value;
  }
  return clone;
}

// ── Nested table detection: a table whose columns include a type:table column ──

function isNestedTableField(field: ConfirmFormField): boolean {
  if (field.type !== 'table' || !Array.isArray(field.columns)) return false;
  return field.columns.some(c => c.type === 'table' && Array.isArray(c.columns));
}

function splitNestedColumns(columns: ConfirmFormColumn[]): {
  parentCols: ConfirmFormColumn[];
  childCol: ConfirmFormColumn | undefined;
} {
  const parentCols = columns.filter(c => !(c.type === 'table' && Array.isArray(c.columns)));
  const childCol = columns.find(c => c.type === 'table' && Array.isArray(c.columns));
  return { parentCols, childCol };
}

// ── Main component ──

export default function ConfirmFormCard({ toolName, description, args, parameters, confirmForm, onConfirm, onCancel }: ConfirmFormProps) {
  const hasFormBuilder = confirmForm && confirmForm.length > 0;
  const [submitted, setSubmitted] = useState(false);

  // Initialize form values: from confirmForm paths or from raw parameters
  const [formValues, setFormValues] = useState<Record<string, any>>(() => {
    if (hasFormBuilder) {
      const vals: Record<string, any> = {};
      for (const f of confirmForm!) {
        let v = getByPath(args, f.key);
        // Nested table: 2D array (parent rows containing sub-array)
        if (isNestedTableField(f)) {
          const { childCol } = splitNestedColumns(f.columns!);
          const arr = Array.isArray(v) && v.length > 0 ? JSON.parse(JSON.stringify(v)) : [{}];
          arr.forEach((row: any) => {
            if (!Array.isArray(row[childCol!.key])) row[childCol!.key] = [];
          });
          vals[f.key] = arr;
          continue;
        }
        v = v ?? f.default ?? (f.type === 'number' ? 0 : f.type === 'boolean' ? false : f.type === 'table' ? [] : '');
        // Apply format to date values on init so submit always has correct format
        if (v && isDateField(f) && f.format) {
          const hasTime = isDateTimeField(f);
          const raw = String(v);
          // Parse date from various formats and re-format
          const dateMatch = raw.match(/(\d{4})-(\d{2})-(\d{2})/);
          const timeMatch = raw.match(/(\d{2}):(\d{2})(?::(\d{2}))?/);
          if (dateMatch) {
            const isoStr = hasTime && timeMatch
              ? `${dateMatch[0]}T${timeMatch[1]}:${timeMatch[2]}`
              : dateMatch[0];
            v = formatDateOutput(isoStr, hasTime, f.format);
          }
        }
        vals[f.key] = v;
      }
      return vals;
    }
    // Fallback: raw parameters mode
    const vals: Record<string, any> = {};
    for (const p of parameters) {
      vals[p.name] = args[p.name] ?? (p.type === 'boolean' ? false : p.type === 'number' ? 0 : '');
    }
    return vals;
  });

  const updateField = useCallback((key: string, value: any) => {
    setFormValues(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = () => {
    setSubmitted(true);
    if (hasFormBuilder) {
      // Write form values back into original args by path
      let result = JSON.parse(JSON.stringify(args));
      for (const f of confirmForm!) {
        // Nested table: coerce number types on both parent + child rows
        if (isNestedTableField(f)) {
          const { parentCols, childCol } = splitNestedColumns(f.columns!);
          const subCols = childCol!.columns || [];
          const arr = (formValues[f.key] || []).map((row: any) => {
            const r = { ...row };
            for (const c of parentCols) {
              if (c.type === 'number' && typeof r[c.key] === 'string') r[c.key] = parseFloat(r[c.key]) || 0;
              if (c.type === 'boolean' && typeof r[c.key] === 'string') r[c.key] = r[c.key] === 'true';
            }
            r[childCol!.key] = (r[childCol!.key] || []).map((sub: any) => {
              const s = { ...sub };
              for (const c of subCols) {
                if (c.type === 'number' && typeof s[c.key] === 'string') s[c.key] = parseFloat(s[c.key]) || 0;
                if (c.type === 'boolean' && typeof s[c.key] === 'string') s[c.key] = s[c.key] === 'true';
              }
              return s;
            });
            return r;
          });
          result = setByPath(result, f.key, arr);
          continue;
        }
        let v = formValues[f.key];
        if (f.type === 'number' && typeof v === 'string') v = parseFloat(v) || 0;
        if (f.type === 'boolean' && typeof v === 'string') v = v === 'true';
        // Ensure date/datetime fields are formatted even if user didn't modify them
        if (isDateField(f) && v && f.format) {
          const hasTime = isDateTimeField(f);
          // Re-apply format to ensure consistency
          const raw = String(v);
          // Only reformat if not already matching the format pattern
          if (!raw.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/) || f.format !== 'yyyy-MM-dd HH:mm:ss') {
            v = formatDateOutput(hasTime ? toDateTimeInputValue(raw) : raw, hasTime, f.format);
          }
        }
        result = setByPath(result, f.key, v);
      }
      onConfirm(result);
    } else {
      // Raw parameters mode
      const result: Record<string, any> = {};
      for (const p of parameters) {
        let v = formValues[p.name];
        if (p.type === 'number' && typeof v === 'string') v = parseFloat(v) || 0;
        if (p.type === 'boolean' && typeof v === 'string') v = v === 'true';
        result[p.name] = v;
      }
      onConfirm(result);
    }
  };

  const handleCancel = () => {
    setSubmitted(true);
    onCancel();
  };

  return (
    <div className="self-stretch my-2 border border-indigo-200 rounded-xl bg-indigo-50/30 flex flex-col">
      {/* Header */}
      <div className="px-4 py-2.5 bg-indigo-50 border-b border-indigo-100 flex items-center gap-2 shrink-0 rounded-t-xl">
        <svg className="w-4 h-4 text-indigo-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
        </svg>
        <div className="flex-1 min-w-0">
          <span className="text-xs font-semibold text-indigo-700">确认参数 — {toolName}</span>
          {description && <span className="text-[11px] text-indigo-400 ml-2">{description}</span>}
        </div>
      </div>

      {/* Form body */}
      <div className="px-4 py-3 flex-1">
        {hasFormBuilder ? (
          // ── confirmForm mode: 3-column grid for fields, full-width for tables ──
          (() => {
            const fields = confirmForm!;
            const elements: React.ReactNode[] = [];
            let fieldBatch: ConfirmFormField[] = [];

            const flushBatch = () => {
              if (fieldBatch.length === 0) return;
              elements.push(
                <div key={`grid-${elements.length}`} className="grid grid-cols-3 gap-x-3 gap-y-1.5">
                  {fieldBatch.map(f => (
                    <FormFieldInput key={f.key} field={f} value={formValues[f.key]}
                      onChange={v => updateField(f.key, v)} disabled={submitted} />
                  ))}
                </div>
              );
              fieldBatch = [];
            };

            for (const f of fields) {
              if (f.type === 'table') {
                flushBatch();
                if (isNestedTableField(f)) {
                  elements.push(
                    <FormNestedTableEditor key={f.key} field={f} value={formValues[f.key] || []}
                      onChange={v => updateField(f.key, v)} disabled={submitted} />
                  );
                } else {
                  elements.push(
                    <FormTableEditor key={f.key} field={f} value={formValues[f.key] || []}
                      onChange={v => updateField(f.key, v)} disabled={submitted} />
                  );
                }
              } else {
                fieldBatch.push(f);
              }
            }
            flushBatch();
            return <div className="space-y-3">{elements}</div>;
          })()
        ) : (
          // ── Fallback: raw parameters mode ──
          <div className="space-y-3">
            {parameters.map(p => (
              <LegacyFieldEditor key={p.name} param={p} value={formValues[p.name]}
                onChange={v => updateField(p.name, v)} disabled={submitted} />
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 border-t border-indigo-100 flex justify-end gap-2 shrink-0 rounded-b-xl">
        <button onClick={handleCancel} disabled={submitted}
          className="px-4 py-1.5 text-xs rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          取消
        </button>
        <button onClick={handleSubmit} disabled={submitted}
          className="px-4 py-1.5 text-xs rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
          确认执行
        </button>
      </div>
    </div>
  );
}

// ── confirmForm field renderer ──

function isDateField(field: ConfirmFormField): boolean {
  if (field.type === 'date' || field.type === 'datetime') return true;
  const hint = `${field.key}.${field.label}`.toLowerCase();
  return /date|日期|交期|签单|ship.*date|sign.*date|cmp.*date|deliver/.test(hint);
}

function isDateTimeField(field: ConfirmFormField): boolean {
  if (field.type === 'datetime') return true;
  if (field.format && /H|h|m|s/.test(field.format)) return true;
  return false;
}

function toDateInputValue(v: any): string {
  if (!v) return '';
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

function toDateTimeInputValue(v: any): string {
  if (!v) return '';
  const s = String(v);
  // "2026-06-02 14:30:00" → "2026-06-02T14:30"
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  return m ? `${m[1]}T${m[2]}` : toDateInputValue(v) + 'T00:00';
}

function formatDateOutput(dateStr: string, hasTime: boolean, format?: string): string {
  if (!dateStr) return '';
  if (format) {
    // Apply format: replace yyyy, MM, dd, HH, mm, ss with actual values
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return format
      .replace('yyyy', d.getFullYear().toString())
      .replace('MM', pad(d.getMonth() + 1))
      .replace('dd', pad(d.getDate()))
      .replace('HH', pad(d.getHours()))
      .replace('mm', pad(d.getMinutes()))
      .replace('ss', pad(d.getSeconds()));
  }
  // Default formats
  if (hasTime) {
    // "2026-06-02T14:30" → "2026-06-02 14:30:00"
    const m = dateStr.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
    return m ? `${m[1]} ${m[2]}:00` : `${dateStr} 00:00:00`;
  }
  // Date only: "2026-06-02" → "2026-06-02 00:00:00"
  return `${dateStr} 00:00:00`;
}

function FormFieldInput({ field, value, onChange, disabled }: { field: ConfirmFormField; value: any; onChange: (v: any) => void; disabled?: boolean }) {
  const inputClass = "flex-1 min-w-0 text-xs border border-gray-200 rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300 disabled:bg-gray-50 disabled:text-gray-400";
  const labelEl = <label className="text-xs text-gray-600 font-medium shrink-0 w-16 text-right">{field.label}{field.required && <span className="text-red-400">*</span>}</label>;

  if (field.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        {labelEl}
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} disabled={disabled} className="rounded border-gray-300 text-indigo-600" />
      </div>
    );
  }

  if (field.type === 'number') {
    return (
      <div className="flex items-center gap-2">
        {labelEl}
        <input type="number" className={inputClass} value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} />
      </div>
    );
  }

  if (isDateField(field)) {
    const hasTime = isDateTimeField(field);
    return (
      <div className="flex items-center gap-2">
        {labelEl}
        {hasTime ? (
          <input type="datetime-local" className={inputClass} value={toDateTimeInputValue(value)} disabled={disabled}
            onChange={e => onChange(e.target.value ? formatDateOutput(e.target.value, true, field.format) : '')} />
        ) : (
          <input type="date" className={inputClass} value={toDateInputValue(value)} disabled={disabled}
            onChange={e => onChange(e.target.value ? formatDateOutput(e.target.value, false, field.format) : '')} />
        )}
        {field.format && <span className="text-[9px] text-gray-400 shrink-0">{field.format}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {labelEl}
      <input type="text" className={inputClass} value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} />
    </div>
  );
}

// ── confirmForm table renderer ──

function FormTableEditor({ field, value, onChange, disabled }: { field: ConfirmFormField; value: any[]; onChange: (v: any[]) => void; disabled?: boolean }) {
  const columns = field.columns || (value.length > 0 ? Object.keys(value[0]).map(k => ({ key: k, label: k })) : []);

  const updateCell = (rowIdx: number, colKey: string, cellValue: any) => {
    const updated = value.map((row, i) => i === rowIdx ? { ...row, [colKey]: cellValue } : row);
    onChange(updated);
  };

  const addRow = () => {
    const empty: Record<string, any> = {};
    for (const col of columns) empty[col.key] = '';
    onChange([...value, empty]);
  };

  const removeRow = (idx: number) => onChange(value.filter((_, i) => i !== idx));

  return (
    <div>
      <label className="text-xs text-gray-600 font-medium">{field.label} {field.required && <span className="text-red-400">*</span>}</label>
      <div className="mt-1 border border-gray-200 rounded-lg overflow-auto max-h-[200px] bg-white">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50">
              {columns.map(col => (
                <th key={col.key} className="px-2 py-1.5 border-b border-gray-200 text-left font-semibold text-gray-600">{col.label}</th>
              ))}
              {!disabled && <th className="px-2 py-1.5 border-b border-gray-200 w-8"></th>}
            </tr>
          </thead>
          <tbody>
            {value.map((row, rowIdx) => (
              <tr key={rowIdx} className="hover:bg-gray-50/50">
                {columns.map(col => (
                  <td key={col.key} className="px-1 py-0.5 border-b border-gray-100">
                    <input type="text"
                      className="w-full text-xs px-1.5 py-1 border border-transparent hover:border-gray-200 focus:border-indigo-300 rounded focus:ring-1 focus:ring-indigo-200 outline-none disabled:bg-gray-50 disabled:text-gray-400"
                      value={row[col.key] ?? ''} disabled={disabled}
                      onChange={e => updateCell(rowIdx, col.key, e.target.value)} />
                  </td>
                ))}
                {!disabled && (
                  <td className="px-1 py-0.5 border-b border-gray-100 text-center">
                    <button onClick={() => removeRow(rowIdx)} className="text-gray-300 hover:text-red-400 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!disabled && (
        <button onClick={addRow} className="mt-1.5 text-[11px] text-indigo-500 hover:text-indigo-700 flex items-center gap-1">
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
          添加行
        </button>
      )}
    </div>
  );
}

// ── confirmForm nested table renderer (parent rows + linked sub-table) ──

function FormNestedTableEditor({ field, value, onChange, disabled }: { field: ConfirmFormField; value: any[]; onChange: (v: any[]) => void; disabled?: boolean }) {
  const { parentCols, childCol } = splitNestedColumns(field.columns || []);
  const subCols = childCol?.columns || [];
  const subKey = childCol?.key || '';
  const [selectedIdx, setSelectedIdx] = useState(0);

  const safeIdx = Math.min(selectedIdx, Math.max(value.length - 1, 0));
  useEffect(() => {
    if (selectedIdx !== safeIdx && safeIdx >= 0) setSelectedIdx(safeIdx);
  }, [safeIdx, selectedIdx]);

  const updateParentCell = (rowIdx: number, colKey: string, cellValue: any) => {
    onChange(value.map((row, i) => i === rowIdx ? { ...row, [colKey]: cellValue } : row));
  };

  const addParentRow = () => {
    const empty: Record<string, any> = {};
    for (const c of parentCols) empty[c.key] = c.type === 'number' ? 0 : '';
    empty[subKey] = [];
    onChange([...value, empty]);
    setSelectedIdx(value.length);
  };

  const removeParentRow = (idx: number) => {
    const next = value.filter((_, i) => i !== idx);
    onChange(next);
    setSelectedIdx(prev => Math.min(prev, Math.max(next.length - 1, 0)));
  };

  const currentRow = value[safeIdx] || {};
  const subRows: any[] = Array.isArray(currentRow[subKey]) ? currentRow[subKey] : [];

  const updateSubCell = (rowIdx: number, colKey: string, cellValue: any) => {
    const updatedSub = subRows.map((r, i) => i === rowIdx ? { ...r, [colKey]: cellValue } : r);
    onChange(value.map((row, i) => i === safeIdx ? { ...row, [subKey]: updatedSub } : row));
  };

  const addSubRow = () => {
    const empty: Record<string, any> = {};
    for (const c of subCols) empty[c.key] = c.type === 'number' ? 0 : '';
    const updatedSub = [...subRows, empty];
    onChange(value.map((row, i) => i === safeIdx ? { ...row, [subKey]: updatedSub } : row));
  };

  const removeSubRow = (idx: number) => {
    const updatedSub = subRows.filter((_, i) => i !== idx);
    onChange(value.map((row, i) => i === safeIdx ? { ...row, [subKey]: updatedSub } : row));
  };

  const parentLabel = (value[safeIdx] && parentCols[0] && value[safeIdx][parentCols[0].key]) || `#${safeIdx + 1}`;
  const inputClass = "w-full text-xs px-1.5 py-1 border border-transparent hover:border-gray-200 focus:border-indigo-300 rounded focus:ring-1 focus:ring-indigo-200 outline-none disabled:bg-gray-50 disabled:text-gray-400";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs text-gray-600 font-medium">{field.label} {field.required && <span className="text-red-400">*</span>}</label>
        {!disabled && (
          <button onClick={addParentRow} className="text-[11px] text-indigo-500 hover:text-indigo-700 flex items-center gap-1">
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
            添加行
          </button>
        )}
      </div>

      {/* Parent table */}
      <div className="border border-gray-200 rounded-lg overflow-auto max-h-[220px] bg-white">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="bg-gray-50">
              <th className="px-1.5 py-1.5 border-b border-gray-200 w-6"></th>
              {parentCols.map(col => (
                <th key={col.key} className="px-2 py-1.5 border-b border-gray-200 text-left font-semibold text-gray-600">
                  {col.label}{col.required && <span className="text-red-400 ml-0.5">*</span>}
                </th>
              ))}
              {!disabled && <th className="px-2 py-1.5 border-b border-gray-200 w-8"></th>}
            </tr>
          </thead>
          <tbody>
            {value.map((row, rowIdx) => (
              <tr key={rowIdx} className={`cursor-pointer ${rowIdx === safeIdx ? 'bg-indigo-50/60' : 'hover:bg-gray-50/50'}`}>
                <td className="px-1.5 py-0.5 border-b border-gray-100 text-center" onClick={() => setSelectedIdx(rowIdx)}>
                  <span className={`inline-block w-3 h-3 rounded-full border ${rowIdx === safeIdx ? 'border-indigo-500 bg-indigo-500' : 'border-gray-300'}`}>
                    {rowIdx === safeIdx && <span className="block w-1 h-1 bg-white rounded-full m-auto mt-0.5" />}
                  </span>
                </td>
                {parentCols.map(col => (
                  <td key={col.key} className="px-1 py-0.5 border-b border-gray-100">
                    <input type={col.type === 'number' ? 'number' : 'text'}
                      className={inputClass}
                      value={row[col.key] ?? ''} disabled={disabled}
                      onClick={() => setSelectedIdx(rowIdx)}
                      onChange={e => updateParentCell(rowIdx, col.key, e.target.value)} />
                  </td>
                ))}
                {!disabled && (
                  <td className="px-1 py-0.5 border-b border-gray-100 text-center">
                    <button onClick={() => removeParentRow(rowIdx)} className="text-gray-300 hover:text-red-400 transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Sub table (linked) */}
      <div className="mt-2">
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-indigo-600 font-medium">
            ▾ {childCol!.label} <span className="text-gray-400 font-normal">— {parentLabel}</span>
          </label>
          {!disabled && value.length > 0 && (
            <button onClick={addSubRow} className="text-[11px] text-indigo-500 hover:text-indigo-700 flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" /></svg>
              添加行
            </button>
          )}
        </div>
        {value.length === 0 ? (
          <div className="text-[11px] text-gray-400 italic py-2">请先在上方添加行</div>
        ) : subCols.length === 0 ? (
          <div className="text-[11px] text-gray-400 italic py-2">无子列定义</div>
        ) : (
          <div className="border border-indigo-200 rounded-lg overflow-auto max-h-[200px] bg-indigo-50/20">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-indigo-50">
                  {subCols.map(col => (
                    <th key={col.key} className="px-2 py-1.5 border-b border-indigo-200 text-left font-semibold text-indigo-700">{col.label}</th>
                  ))}
                  {!disabled && <th className="px-2 py-1.5 border-b border-indigo-200 w-8"></th>}
                </tr>
              </thead>
              <tbody>
                {subRows.map((row, rowIdx) => (
                  <tr key={rowIdx} className="hover:bg-indigo-50/40">
                    {subCols.map(col => (
                      <td key={col.key} className="px-1 py-0.5 border-b border-indigo-100">
                        <input type={col.type === 'number' ? 'number' : 'text'}
                          className="w-full text-xs px-1.5 py-1 border border-transparent hover:border-indigo-200 focus:border-indigo-400 rounded focus:ring-1 focus:ring-indigo-200 outline-none disabled:bg-gray-50 disabled:text-gray-400"
                          value={row[col.key] ?? ''} disabled={disabled}
                          onChange={e => updateSubCell(rowIdx, col.key, e.target.value)} />
                      </td>
                    ))}
                    {!disabled && (
                      <td className="px-1 py-0.5 border-b border-indigo-100 text-center">
                        <button onClick={() => removeSubRow(rowIdx)} className="text-gray-300 hover:text-red-400 transition-colors">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
                {subRows.length === 0 && (
                  <tr><td colSpan={subCols.length + 1} className="text-center text-[11px] text-gray-400 italic py-2">暂无明细数据</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Legacy fallback: raw parameter editor (no confirmForm) ──

function LegacyFieldEditor({ param, value, onChange, disabled }: { param: ParameterDef; value: any; onChange: (v: any) => void; disabled?: boolean }) {
  const label = param.label || param.name;
  const isArray = param.type === 'array' || Array.isArray(value);
  const isObjectArray = isArray && Array.isArray(value) && value.length > 0 && typeof value[0] === 'object';

  if (isObjectArray) {
    return <FormTableEditor field={{ key: param.name, label, type: 'table', required: param.required }} value={value} onChange={onChange} disabled={disabled} />;
  }

  if (param.type === 'boolean') {
    return (
      <div className="flex items-center gap-2">
        <input type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} disabled={disabled} className="rounded border-gray-300 text-indigo-600" />
        <label className="text-xs text-gray-700">{label}</label>
      </div>
    );
  }

  if (param.type === 'object' || (typeof value === 'object' && value !== null && !Array.isArray(value))) {
    const jsonStr = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return (
      <div>
        <label className="text-xs text-gray-600 font-medium">{label} {param.required && <span className="text-red-400">*</span>}</label>
        {param.description && <p className="text-[11px] text-gray-400 mt-0.5">{param.description}</p>}
        <textarea
          className="mt-1 w-full text-xs border border-gray-200 rounded-lg px-3 py-2 font-mono resize-y min-h-[80px] max-h-[35vh] focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300 disabled:bg-gray-50 disabled:text-gray-400"
          value={jsonStr} disabled={disabled}
          onChange={e => { try { onChange(JSON.parse(e.target.value)); } catch { onChange(e.target.value); } }}
        />
      </div>
    );
  }

  if (param.type === 'number') {
    return (
      <div>
        <label className="text-xs text-gray-600 font-medium">{label} {param.required && <span className="text-red-400">*</span>}</label>
        <input type="number" className="mt-1 w-full text-xs border border-gray-200 rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300 disabled:bg-gray-50 disabled:text-gray-400"
          value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} />
      </div>
    );
  }

  return (
    <div>
      <label className="text-xs text-gray-600 font-medium">{label} {param.required && <span className="text-red-400">*</span>}</label>
      <input type="text" className="mt-1 w-full text-xs border border-gray-200 rounded-lg px-3 py-1.5 focus:ring-1 focus:ring-indigo-300 focus:border-indigo-300 disabled:bg-gray-50 disabled:text-gray-400"
        value={value ?? ''} disabled={disabled} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
