import { useEffect, useState } from 'react';
import type { PanelProps } from '../../types/panel';
import { invoke } from '../sdk-lib/panel-api';

export const panelMeta = { id: 'faMain', minWidth: 480, minHeight: 360 };

const APP_ID = 'com.example.full-app';

interface Note {
  id: string;
  title: string;
  content: string;
  created_at: string;
}

export default function NotePanel({ initialData, onMessage }: PanelProps) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const reload = async () => {
    const r = await invoke<{ notes: Note[] }>(APP_ID, 'NoteController.listNotes');
    setNotes(r.notes);
  };

  useEffect(() => { void reload().catch(e => setMsg(e.message)); }, []);

  const addNote = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setMsg('');
    try {
      await invoke(APP_ID, 'NoteController.addNote', { title, content });
      setTitle('');
      setContent('');
      await reload();
      // 通知 agent：agent 可经 initialData 感知面板侧变更
      onMessage?.({ type: 'note_added', title });
    } catch (e: any) {
      setMsg(`新增失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteNote = async (id: string) => {
    try {
      await invoke(APP_ID, 'NoteController.deleteNote', { id });
      await reload();
    } catch (e: any) {
      setMsg(`删除失败：${e.message}`);
    }
  };

  // agent 侧（fa_note_add）写入后推送刷新信号
  const pushed = initialData as { refresh?: boolean } | undefined;
  useEffect(() => {
    if (pushed?.refresh) void reload().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushed?.refresh]);

  return (
    <div className="h-full flex flex-col gap-3 p-4">
      <h2 className="text-base font-semibold text-gray-800">备忘本</h2>

      <div className="flex flex-col gap-2">
        <input
          className="px-3 py-1.5 text-sm border border-gray-200 rounded"
          value={title}
          onChange={e => setTitle(e.target.value)}
          placeholder="标题"
        />
        <textarea
          className="px-3 py-1.5 text-sm border border-gray-200 rounded h-16 resize-none"
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="内容（可选）"
        />
        <button
          className="self-start px-4 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
          onClick={addNote}
          disabled={busy || !title.trim()}
        >
          {busy ? '保存中…' : '新增笔记'}
        </button>
      </div>

      {msg && <p className="text-xs text-red-500">{msg}</p>}

      <ul className="flex-1 overflow-auto divide-y divide-gray-100 border border-gray-100 rounded">
        {notes.map(n => (
          <li key={n.id} className="flex items-start gap-2 px-3 py-2">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-800 truncate">{n.title}</p>
              {n.content && <p className="text-xs text-gray-500 mt-0.5 whitespace-pre-wrap">{n.content}</p>}
              <p className="text-[10px] text-gray-300 mt-0.5">{new Date(n.created_at).toLocaleString()}</p>
            </div>
            <button
              className="shrink-0 px-2 py-0.5 text-[11px] text-red-500 border border-red-200 rounded hover:bg-red-50"
              onClick={() => deleteNote(n.id)}
            >
              删除
            </button>
          </li>
        ))}
        {notes.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-gray-400">暂无笔记</li>
        )}
      </ul>
    </div>
  );
}
