'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

const MAIN_URL = getMainUrl();
const UniverSheet = dynamic(() => import('./UniverSheet'), { ssr: false });

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface ExportFile {
  fileId: string;
  filename: string;
  size: number;
  created: string;
}

export default function SpreadsheetPanel({ openFileId, onFileOpened }: { openFileId?: string; onFileOpened?: () => void }) {
  const [files, setFiles] = useState<ExportFile[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [sheetData, setSheetData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const loadFiles = useCallback(async () => {
    try {
      const resp = await fetch(`${MAIN_URL}/api/exports`, { headers: authHeaders() });
      const data = await resp.json();
      if (Array.isArray(data)) setFiles(data);
    } catch {}
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Auto-refresh file list every 5s if empty (waiting for AI to generate)
  useEffect(() => {
    if (files.length > 0) return;
    const t = setInterval(loadFiles, 5000);
    return () => clearInterval(t);
  }, [files.length, loadFiles]);

  const openFile = useCallback(async (fileId: string) => {
    setSelected(fileId);
    setLoading(true);
    setSheetData(null);
    try {
      const resp = await fetch(`${MAIN_URL}/api/exports/${fileId}/json`, { headers: authHeaders() });
      const data = await resp.json();
      setSheetData(data);
    } catch {}
    setLoading(false);
  }, []);

  // Open file passed via prop (from ui_hook show-file, ensures file opens even on first mount)
  useEffect(() => {
    if (openFileId) {
      loadFiles().then(() => openFile(openFileId));
      onFileOpened?.();
    }
  }, [openFileId, loadFiles, openFile, onFileOpened]);

  // Listen for agent-triggered file selection via UI hooks
  useEffect(() => {
    const handler = (e: Event) => {
      const { hook, params } = (e as CustomEvent).detail || {};
      if (hook === 'show-file' && params?.fileId) {
        loadFiles().then(() => openFile(params.fileId));
      }
    };
    window.addEventListener('jianzhi:ui-hook', handler);
    return () => window.removeEventListener('jianzhi:ui-hook', handler);
  }, [loadFiles, openFile]);

  const downloadFile = () => {
    if (!selected) return;
    const token = localStorage.getItem('jz_token');
    window.open(`${MAIN_URL}/api/exports/${selected}/download?token=${token}`, '_blank');
  };

  const deleteFile = async () => {
    if (!selected || !(await confirmDialog('确定删除此文件？', { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/exports/${selected}/delete`, { method: 'POST', headers: authHeaders() });
    setSelected('');
    setSheetData(null);
    loadFiles();
  };

  const refreshFiles = () => loadFiles();

  if (files.length === 0 && !loading) {
    return (
      <div className="flex items-center justify-center h-full text-gray-300">
        <div className="text-center">
          <div className="text-4xl mb-3">📋</div>
          <div className="text-sm">还没有工作表</div>
          <div className="text-xs mt-1">与"数据大师"对话，说"导出XX数据为Excel"来生成</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        <select value={selected} onChange={e => { if (e.target.value) openFile(e.target.value); }}
          className="text-sm border border-gray-200 rounded px-2 py-1 bg-white min-w-[200px]">
          <option value="">选择工作表...</option>
          {files.map(f => (
            <option key={f.fileId} value={f.fileId}>{f.filename}</option>
          ))}
        </select>
        <button onClick={refreshFiles} className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-indigo-600" title="刷新列表">⟳</button>
        <div className="flex-1" />
        {selected && (
          <>
            <button onClick={downloadFile}
              className="text-xs px-3 py-1 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50">
              📥 下载
            </button>
            <button onClick={deleteFile}
              className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-red-500">
              删除
            </button>
          </>
        )}
      </div>

      {/* Sheet viewer */}
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-sm">加载中...</div>
        ) : sheetData ? (
          <UniverSheet data={sheetData} />
        ) : (
          <div className="flex items-center justify-center h-full text-gray-300 text-xs">← 选择一个工作表查看</div>
        )}
      </div>
    </div>
  );
}
