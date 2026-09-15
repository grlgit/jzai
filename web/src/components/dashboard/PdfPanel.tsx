'use client';

import { useState, useEffect, useCallback } from 'react';
import dynamic from 'next/dynamic';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

const PdfTemplateManager = dynamic(() => import('./PdfTemplateManager'), { ssr: false });

const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface PdfFile {
  fileId: string;
  filename: string;
  size: number;
  created: string;
}

interface PdfPanelProps {
  openFileId?: string;
  onFileOpened?: () => void;
  onSelectedChange?: (fileId: string) => void;
}

export default function PdfPanel({ openFileId, onFileOpened, onSelectedChange }: PdfPanelProps) {
  const [files, setFiles] = useState<PdfFile[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);

  const loadFiles = useCallback(async () => {
    try {
      const resp = await fetch(`${MAIN_URL}/api/pdf-exports`, { headers: authHeaders() });
      const data = await resp.json();
      if (Array.isArray(data)) setFiles(data);
    } catch {}
  }, []);

  useEffect(() => { loadFiles(); }, [loadFiles]);

  // Auto-refresh if empty (waiting for AI to generate)
  useEffect(() => {
    if (files.length > 0) return;
    const t = setInterval(loadFiles, 5000);
    return () => clearInterval(t);
  }, [files.length, loadFiles]);

  const openFile = useCallback((fileId: string) => {
    setSelected(fileId);
    onSelectedChange?.(fileId);
  }, [onSelectedChange]);

  // Open file passed via prop (from ui_hook show-pdf)
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
      if (hook === 'show-pdf' && params?.fileId) {
        loadFiles().then(() => openFile(params.fileId));
      }
      if (hook === 'refresh-pdf' && params?.fileId) {
        if (selected === params.fileId) {
          setSelected('');
          setTimeout(() => setSelected(params.fileId), 100);
        }
      }
    };
    window.addEventListener('jianzhi:ui-hook', handler);
    return () => window.removeEventListener('jianzhi:ui-hook', handler);
  }, [loadFiles, openFile, selected]);

  const getViewUrl = (fileId: string) => {
    const token = localStorage.getItem('jz_token');
    return `${MAIN_URL}/api/pdf-exports/${fileId}/view?token=${token}`;
  };

  const downloadFile = () => {
    if (!selected) return;
    const token = localStorage.getItem('jz_token');
    window.open(`${MAIN_URL}/api/pdf-exports/${selected}/download?token=${token}`, '_blank');
  };

  const printFile = () => {
    const iframe = document.getElementById('pdf-preview-frame') as HTMLIFrameElement;
    if (iframe?.contentWindow) {
      iframe.contentWindow.print();
    }
  };

  const deleteFile = async () => {
    if (!selected || !(await confirmDialog('确定删除此文件？', { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/pdf-exports/${selected}/delete`, { method: 'POST', headers: authHeaders() });
    setSelected('');
    loadFiles();
  };

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-white border-b border-gray-200 shrink-0">
        <select value={selected} onChange={e => { if (e.target.value) openFile(e.target.value); }}
          className="text-sm border border-gray-200 rounded px-2 py-1 bg-white min-w-[200px]">
          <option value="">选择PDF文档...</option>
          {files.map(f => (
            <option key={f.fileId} value={f.fileId}>{f.filename}</option>
          ))}
        </select>
        <button onClick={() => loadFiles()} className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-indigo-600" title="刷新列表">⟳</button>
        <div className="flex-1" />
        {selected && (
          <>
            <button onClick={printFile}
              className="text-xs px-3 py-1 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50 shrink-0">
              打印
            </button>
            <button onClick={downloadFile}
              className="text-xs px-3 py-1 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50 shrink-0">
              下载
            </button>
            <button onClick={deleteFile}
              className="text-xs px-2 py-1 rounded border border-gray-200 text-gray-400 hover:text-red-500 shrink-0">
              删除
            </button>
          </>
        )}
        <button onClick={() => setShowTemplates(true)}
          className="text-xs px-3 py-1 rounded border border-gray-200 text-gray-500 hover:text-indigo-600 hover:border-indigo-300 shrink-0 whitespace-nowrap">
          模板管理
        </button>
      </div>

      {/* PDF viewer */}
      <div className="flex-1 min-h-0">
        {selected ? (
          <iframe
            id="pdf-preview-frame"
            src={getViewUrl(selected)}
            className="w-full h-full border-none"
            title="PDF Preview"
          />
        ) : files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-300">
            <div className="text-center">
              <div className="text-4xl mb-3">📄</div>
              <div className="text-sm">还没有PDF文档</div>
              <div className="text-xs mt-1">与"数据大师"对话，说"生成XX报告PDF"来创建</div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-gray-300 text-xs">← 选择一个PDF文档查看</div>
        )}
      </div>

      {/* Template manager — slide-in panel */}
      {showTemplates && (
        <div className="fixed inset-0 z-50 flex justify-end" onClick={e => { if (e.target === e.currentTarget) setShowTemplates(false); }}>
          <div className="bg-black/20 absolute inset-0" />
          <div className="relative w-[650px] max-w-full h-full bg-white shadow-2xl flex flex-col animate-slide-in-right">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 shrink-0">
              <h3 className="text-sm font-medium text-gray-700">模板管理</h3>
              <button onClick={() => setShowTemplates(false)} className="text-gray-400 hover:text-gray-600 text-lg leading-none">✕</button>
            </div>
            <div className="flex-1 overflow-hidden">
              <PdfTemplateManager />
            </div>
          </div>
        </div>
      )}

      <style jsx>{`
        @keyframes slideInRight {
          from { transform: translateX(100%); }
          to { transform: translateX(0); }
        }
        .animate-slide-in-right {
          animation: slideInRight 0.2s ease-out;
        }
      `}</style>
    </div>
  );
}
