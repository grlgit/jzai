'use client';

import { useState, useEffect, useCallback } from 'react';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';
import PdfTemplateEditor from './PdfTemplateEditor';

const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface PdfTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  isSystem: boolean;
  page: { size: string; orientation: string; margins: number[] };
  header?: any;
  footer?: any;
  styles?: any;
  sections: any[];
  createdAt: string;
  updatedAt: string;
}

export default function PdfTemplateManager() {
  const [templates, setTemplates] = useState<PdfTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTemplate, setEditingTemplate] = useState<PdfTemplate | null | undefined>(undefined);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    try {
      const resp = await fetch(`${MAIN_URL}/api/pdf-templates`, { headers: authHeaders() });
      const data = await resp.json();
      if (Array.isArray(data)) setTemplates(data);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadTemplates(); }, [loadTemplates]);

  const handleDuplicate = async (id: string) => {
    try {
      await fetch(`${MAIN_URL}/api/pdf-templates/${id}/duplicate`, { method: 'POST', headers: authHeaders() });
      loadTemplates();
    } catch {}
  };

  const handleDelete = async (id: string, name: string) => {
    if (!(await confirmDialog(`确定删除模板"${name}"？`, { danger: true }))) return;
    try {
      await fetch(`${MAIN_URL}/api/pdf-templates/${id}`, { method: 'DELETE', headers: authHeaders() });
      loadTemplates();
    } catch {}
  };

  const handleSave = async (data: Partial<PdfTemplate>) => {
    try {
      if (editingTemplate === null) {
        // Create new
        await fetch(`${MAIN_URL}/api/pdf-templates`, {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify(data),
        });
      } else if (editingTemplate) {
        // Update existing
        await fetch(`${MAIN_URL}/api/pdf-templates/${editingTemplate.id}`, {
          method: 'PUT',
          headers: authHeaders(),
          body: JSON.stringify(data),
        });
      }
      setEditingTemplate(undefined);
      loadTemplates();
    } catch {}
  };

  if (loading) {
    return <div className="flex items-center justify-center h-full text-gray-400 text-sm">加载中...</div>;
  }

  const systemTemplates = templates.filter(t => t.isSystem);
  const userTemplates = templates.filter(t => !t.isSystem);

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        <span className="text-sm font-medium text-gray-600">PDF模板</span>
        <div className="flex-1" />
        <button onClick={() => setEditingTemplate(null)}
          className="text-xs px-3 py-1 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50">
          + 新建模板
        </button>
        <button onClick={() => loadTemplates()}
          className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-indigo-600" title="刷新">⟳</button>
      </div>

      {/* Template cards */}
      <div className="flex-1 overflow-auto p-4">
        {systemTemplates.length > 0 && (
          <div className="mb-6">
            <h3 className="text-xs font-medium text-gray-400 mb-3 uppercase tracking-wider">共享模板</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {systemTemplates.map(t => (
                <TemplateCard key={t.id} template={t}
                  onEdit={() => setEditingTemplate(t)}
                  onDuplicate={() => handleDuplicate(t.id)}
                  onDelete={() => handleDelete(t.id, t.name)} />
              ))}
            </div>
          </div>
        )}

        {userTemplates.length > 0 && (
          <div className="mb-6">
            <h3 className="text-xs font-medium text-gray-400 mb-3 uppercase tracking-wider">我的模板</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {userTemplates.map(t => (
                <TemplateCard key={t.id} template={t}
                  onEdit={() => setEditingTemplate(t)}
                  onDuplicate={() => handleDuplicate(t.id)}
                  onDelete={() => handleDelete(t.id, t.name)} />
              ))}
            </div>
          </div>
        )}

        {templates.length === 0 && (
          <div className="flex items-center justify-center h-40 text-gray-300">
            <div className="text-center">
              <div className="text-3xl mb-2">📐</div>
              <div className="text-sm">暂无模板</div>
            </div>
          </div>
        )}
      </div>

      {/* Template editor dialog */}
      {editingTemplate !== undefined && (
        <PdfTemplateEditor
          template={editingTemplate}
          onClose={() => setEditingTemplate(undefined)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

function TemplateCard({ template, onEdit, onDuplicate, onDelete }: {
  template: PdfTemplate;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 hover:shadow-sm transition-shadow">
      <div className="flex items-start gap-2 mb-2">
        <span className="text-2xl">{template.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-800 truncate">{template.name}</div>
          <div className="text-xs text-gray-400 mt-0.5 line-clamp-2">{template.description}</div>
        </div>
      </div>

      <div className="border-t border-gray-100 pt-2 mt-2">
        <div className="flex items-center gap-2 text-[11px] text-gray-400 mb-2">
          {template.isSystem ? (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-blue-50 border border-blue-100 text-blue-500">
              共享模板
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-indigo-50 border border-indigo-100 text-indigo-500">
              👤 我的模板
            </span>
          )}
          <span>{template.page?.size || 'A4'} · {template.page?.orientation === 'landscape' ? '横向' : '纵向'} · {template.sections?.length || 0}个区块</span>
        </div>

        <div className="flex items-center gap-1.5">
          {onEdit && (
            <button onClick={onEdit}
              className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:text-indigo-600 hover:border-indigo-300">
              编辑
            </button>
          )}
          {onDuplicate && (
            <button onClick={onDuplicate}
              className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-500 hover:text-indigo-600 hover:border-indigo-300">
              复制
            </button>
          )}
          {onDelete && (
            <button onClick={onDelete}
              className="text-[11px] px-2 py-0.5 rounded border border-gray-200 text-gray-400 hover:text-red-500 hover:border-red-300">
              删除
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
