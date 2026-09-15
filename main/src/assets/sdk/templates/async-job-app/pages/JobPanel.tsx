import { useEffect, useRef, useState } from 'react';
import type { PanelProps } from '../../types/panel';
import { invoke } from '../sdk-lib/panel-api';

export const panelMeta = { id: 'ajMain', minWidth: 480, minHeight: 360 };

const APP_ID = 'com.example.async-job-app';

interface Job {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  progress: number;
  result?: { files?: number; rows?: number; summary?: string; error?: string } | null;
}

export default function JobPanel(_props: PanelProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [active, setActive] = useState<Job | null>(null);
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = async () => {
    const r = await invoke<{ jobs: Job[] }>(APP_ID, 'JobController.listJobs');
    setJobs(r.jobs);
  };

  useEffect(() => {
    void reload().catch(e => setMsg(e.message));
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  /** 创建任务后轮询 getJob，直到 done/failed */
  const createJob = async () => {
    setMsg('');
    try {
      const { jobId } = await invoke<{ jobId: string }>(APP_ID, 'JobController.createJob', {
        type: 'monthly-report',
      });
      await reload();
      if (timer.current) clearInterval(timer.current);
      timer.current = setInterval(async () => {
        const job = await invoke<Job>(APP_ID, 'JobController.getJob', { jobId });
        setActive(job);
        void reload().catch(() => {});
        if (job.status === 'done' || job.status === 'failed') {
          if (timer.current) clearInterval(timer.current);
          timer.current = null;
        }
      }, 1500);
    } catch (e: any) {
      setMsg(`创建失败：${e.message}`);
    }
  };

  return (
    <div className="h-full flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-gray-800">批量报表生成</h2>
        <button
          className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
          onClick={createJob}
        >
          创建任务
        </button>
      </div>
      <p className="text-[11px] text-gray-400">
        提交后立即返回 jobId，后台异步执行；面板轮询进度——同步请求不做长任务。
      </p>

      {msg && <p className="text-xs text-red-500">{msg}</p>}

      {/* 当前任务进度条 */}
      {active && (
        <div className="border border-gray-100 rounded-lg p-3">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1.5">
            <span className="font-mono">{active.id}</span>
            <span>{active.status} · {active.progress}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
            <div
              className={`h-full transition-all ${active.status === 'failed' ? 'bg-red-400' : 'bg-indigo-500'}`}
              style={{ width: `${active.progress}%` }}
            />
          </div>
          {active.status === 'done' && active.result && (
            <p className="text-xs text-emerald-600 mt-2">
              {active.result.summary}（{active.result.files} 份 / {active.result.rows} 行）
            </p>
          )}
          {active.status === 'failed' && (
            <p className="text-xs text-red-500 mt-2">失败：{active.result?.error}</p>
          )}
        </div>
      )}

      {/* 历史任务 */}
      <ul className="flex-1 overflow-auto divide-y divide-gray-100 border border-gray-100 rounded">
        {jobs.map(j => (
          <li key={j.id} className="flex items-center gap-2 px-3 py-2 text-xs">
            <span className="font-mono text-gray-500 truncate flex-1">{j.id}</span>
            <span className="text-gray-400">{j.type}</span>
            <span className={
              j.status === 'done' ? 'text-emerald-600'
              : j.status === 'failed' ? 'text-red-500'
              : 'text-indigo-600'
            }>
              {j.status}{j.status === 'running' || j.status === 'pending' ? ` ${j.progress}%` : ''}
            </span>
          </li>
        ))}
        {jobs.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-gray-400">暂无任务</li>
        )}
      </ul>
    </div>
  );
}
