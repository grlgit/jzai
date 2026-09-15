import { useState } from 'react';
import type { PanelProps } from '../../types/panel';
import { invoke } from '../sdk-lib/panel-api';

export const panelMeta = { id: 'taMain', minWidth: 480, minHeight: 360 };

const APP_ID = 'com.example.tool-app';

export default function ReportPanel(_props: PanelProps) {
  const [title, setTitle] = useState('示例报告');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const makePdf = async () => {
    setBusy(true);
    setMsg('');
    try {
      await invoke(APP_ID, 'ReportController.makePdf', { title });
      setMsg('PDF 已生成（经平台 generate_pdf 工具）');
    } catch (e: any) {
      setMsg(`生成失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6">
      <h2 className="text-base font-semibold text-gray-800">平台工具复用示例</h2>
      <p className="text-xs text-gray-400">经 ctx.tools.call 调用平台 generate_pdf（通道②）</p>
      <input
        className="px-3 py-1.5 text-sm border border-gray-200 rounded w-64"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="报告标题"
      />
      <button
        className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
        onClick={makePdf}
        disabled={busy}
      >
        {busy ? '生成中…' : '生成 PDF'}
      </button>
      {msg && <p className="text-xs text-gray-500">{msg}</p>}
    </div>
  );
}
