'use client';

/**
 * P2 定时任务面板（docs/rework-2026H2/design-p2-scheduler.md §5）。
 * 任务列表 / 新建编辑弹窗（cron 模板 + 未来 3 次预览）/ 执行历史抽屉 / 手动触发 / 启停。
 * 仅 admin 可见（SettingsPanel tab 层过滤）。
 */
import { useState, useEffect, useCallback } from 'react';
import { getMainUrl } from '@/lib/env';

const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface ScheduledTask {
  id: string; name: string; enabled: boolean; cron: string; timezone: string;
  targetType: 'agent' | 'skill'; targetId: string;
  payload: { prompt?: string; params?: Record<string, any> };
  runAsUserId: string; onConfirm: 'reject' | 'skip_tool';
  timeoutSec: number; maxRetries: number;
  lastRunAt?: string; nextRunAt?: string;
}

interface RunRow {
  id: number; status: string; trigger: string; startedAt: string; finishedAt?: string;
  durationMs?: number; output?: string; error?: string; sessionId?: string;
}

const CRON_TEMPLATES = [
  { label: '每天 09:00', value: '0 9 * * *' },
  { label: '每小时整点', value: '0 * * * *' },
  { label: '每周一 09:00', value: '0 9 * * 1' },
  { label: '每月 1 日 09:00', value: '0 9 1 * *' },
  { label: '工作日 18:00', value: '0 18 * * 1-5' },
];

const STATUS_STYLE: Record<string, string> = {
  success: 'bg-emerald-50 text-emerald-600',
  failed: 'bg-red-50 text-red-600',
  timeout: 'bg-orange-50 text-orange-600',
  skipped: 'bg-gray-100 text-gray-500',
  running: 'bg-blue-50 text-blue-600',
};

const emptyForm = {
  name: '', cron: '0 9 * * *', timezone: 'Asia/Shanghai',
  targetType: 'agent' as 'agent' | 'skill', targetId: '',
  prompt: '', paramsText: '', runAsUserId: '',
  onConfirm: 'reject' as 'reject' | 'skip_tool', timeoutSec: 300, maxRetries: 0, enabled: true,
};

export default function TimerPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [msg, setMsg] = useState('');
  const [editing, setEditing] = useState<ScheduledTask | 'new' | null>(null);
  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null);

  const load = useCallback(async () => {
    const list = await fetch(`${MAIN_URL}/api/scheduler/tasks`, { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : [])).catch(() => []);
    if (Array.isArray(list)) setTasks(list);
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggle = async (t: ScheduledTask) => {
    await fetch(`${MAIN_URL}/api/scheduler/tasks/${t.id}/toggle`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ enabled: !t.enabled }),
    });
    load();
  };

  const runNow = async (t: ScheduledTask) => {
    const resp = await fetch(`${MAIN_URL}/api/scheduler/tasks/${t.id}/run`, { method: 'POST', headers: authHeaders() });
    setMsg(resp.ok ? `已触发「${t.name}」，稍后可在历史中查看结果` : `触发失败（${resp.status}）`);
    setTimeout(() => setMsg(''), 4000);
  };

  const remove = async (t: ScheduledTask) => {
    if (!window.confirm(`确认删除定时任务「${t.name}」？执行历史将一并删除。`)) return;
    await fetch(`${MAIN_URL}/api/scheduler/tasks/${t.id}`, { method: 'DELETE', headers: authHeaders() });
    load();
  };

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">定时任务</h3>
        <button onClick={() => setEditing('new')}
          className="text-xs px-2.5 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700">
          + 新建任务
        </button>
      </div>
      {msg && <div className="text-xs text-indigo-600 mb-2">{msg}</div>}

      {tasks.length === 0 ? (
        <div className="text-sm text-gray-400 text-center py-10 border border-dashed border-gray-200 rounded-lg">
          暂无定时任务
        </div>
      ) : (
        <div className="space-y-2">
          {tasks.map(t => (
            <div key={t.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${t.enabled ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{t.name}</div>
                <div className="text-xs text-gray-400 truncate">
                  <code className="bg-gray-50 px-1 rounded">{t.cron}</code>
                  {' '}→ {t.targetType === 'agent' ? '智能体' : '技能'} {t.targetId}
                  {t.nextRunAt && t.enabled && <> · 下次 {new Date(t.nextRunAt).toLocaleString('zh-CN')}</>}
                  {t.lastRunAt && <> · 最近 {new Date(t.lastRunAt).toLocaleString('zh-CN')}</>}
                </div>
              </div>
              <button onClick={() => setHistoryTask(t)} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0" title="执行历史">🕘</button>
              <button onClick={() => runNow(t)} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0" title="立即执行">▶</button>
              <button onClick={() => setEditing(t)} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0" title="编辑">✏️</button>
              <button onClick={() => remove(t)} className="text-xs text-gray-400 hover:text-red-500 shrink-0" title="删除">🗑️</button>
              <button onClick={() => toggle(t)}
                className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${t.enabled ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${t.enabled ? 'left-[18px]' : 'left-0.5'}`} />
              </button>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <TaskEditor
          task={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }}
        />
      )}
      {historyTask && (
        <RunHistoryDrawer task={historyTask} onClose={() => { setHistoryTask(null); load(); }} />
      )}
    </div>
  );
}

function TaskEditor({ task, onClose, onSaved }: { task: ScheduledTask | null; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ ...emptyForm,
    ...(task ? {
      name: task.name, cron: task.cron, timezone: task.timezone,
      targetType: task.targetType, targetId: task.targetId,
      prompt: task.payload?.prompt ?? '', paramsText: JSON.stringify(task.payload?.params ?? {}, null, 2),
      runAsUserId: task.runAsUserId, onConfirm: task.onConfirm,
      timeoutSec: task.timeoutSec, maxRetries: task.maxRetries, enabled: task.enabled,
    } : {}),
  });
  const [preview, setPreview] = useState<Date[] | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const update = (patch: Partial<typeof form>) => setForm(prev => ({ ...prev, ...patch }));

  const checkCron = async () => {
    setPreview(null); setError('');
    const resp = await fetch(`${MAIN_URL}/api/scheduler/tasks/cron-preview`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ cron: form.cron, timezone: form.timezone }),
    }).catch(() => null);
    if (!resp) { setError('预览服务不可用'); return; }
    if (!resp.ok) { setError('非法 cron 表达式'); return; }
    const data = await resp.json();
    setPreview((data.nextRuns ?? []).map((s: string) => new Date(s)));
  };

  const save = async () => {
    setError(''); setSaving(true);
    let params: Record<string, any> | undefined;
    if (form.paramsText.trim()) {
      try { params = JSON.parse(form.paramsText); }
      catch { setError('参数 JSON 格式错误'); setSaving(false); return; }
    }
    const body = {
      name: form.name, cron: form.cron, timezone: form.timezone,
      targetType: form.targetType, targetId: form.targetId,
      payload: form.targetType === 'agent' ? { prompt: form.prompt } : { params: params ?? {} },
      runAsUserId: form.runAsUserId, onConfirm: form.onConfirm,
      timeoutSec: Number(form.timeoutSec) || 300, maxRetries: Number(form.maxRetries) || 0,
      enabled: form.enabled,
    };
    const url = task ? `${MAIN_URL}/api/scheduler/tasks/${task.id}` : `${MAIN_URL}/api/scheduler/tasks`;
    const resp = await fetch(url, {
      method: task ? 'PUT' : 'POST', headers: authHeaders(), body: JSON.stringify(body),
    });
    setSaving(false);
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      setError(data.message || `保存失败（${resp.status}）`);
      return;
    }
    onSaved();
  };

  const inputCls = 'w-full text-sm border border-gray-300 rounded px-2 py-1.5';
  const labelCls = 'block text-xs text-gray-500 mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-[560px] max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-medium">{task ? '编辑定时任务' : '新建定时任务'}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>任务名称</label>
            <input className={inputCls} value={form.name} onChange={e => update({ name: e.target.value })} placeholder="每日晨报" />
          </div>
          <div>
            <label className={labelCls}>cron 表达式</label>
            <div className="flex gap-1.5">
              <input className={inputCls} value={form.cron} onChange={e => update({ cron: e.target.value })} />
              <button onClick={checkCron} className="text-xs px-2 border border-gray-300 rounded text-gray-600 hover:border-indigo-300 shrink-0">预览</button>
            </div>
            <select className={`${inputCls} mt-1`} value=""
              onChange={e => { if (e.target.value) update({ cron: e.target.value }); }}>
              <option value="">常用模板…</option>
              {CRON_TEMPLATES.map(t => <option key={t.value} value={t.value}>{t.label}（{t.value}）</option>)}
            </select>
          </div>
          <div>
            <label className={labelCls}>时区</label>
            <input className={inputCls} value={form.timezone} onChange={e => update({ timezone: e.target.value })} />
          </div>
          {preview && (
            <div className="col-span-2 text-xs text-gray-500 bg-gray-50 rounded p-2">
              未来 3 次触发：{preview.map(d => d.toLocaleString('zh-CN')).join('；')}
            </div>
          )}
          <div>
            <label className={labelCls}>目标类型</label>
            <select className={inputCls} value={form.targetType} onChange={e => update({ targetType: e.target.value as any })}>
              <option value="agent">智能体</option>
              <option value="skill">技能</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{form.targetType === 'agent' ? '智能体 ID' : '技能名'}</label>
            <input className={inputCls} value={form.targetId} onChange={e => update({ targetId: e.target.value })} placeholder="main" />
          </div>
          {form.targetType === 'agent' ? (
            <div className="col-span-2">
              <label className={labelCls}>提示词</label>
              <textarea className={inputCls} rows={3} value={form.prompt} onChange={e => update({ prompt: e.target.value })} placeholder="生成今日晨报并总结要点" />
            </div>
          ) : (
            <div className="col-span-2">
              <label className={labelCls}>参数（JSON）</label>
              <textarea className={`${inputCls} font-mono`} rows={3} value={form.paramsText}
                onChange={e => update({ paramsText: e.target.value })} placeholder='{"key": "value"}' />
            </div>
          )}
          <div>
            <label className={labelCls}>以谁的身份执行（用户 ID）</label>
            <input className={inputCls} value={form.runAsUserId} onChange={e => update({ runAsUserId: e.target.value })} />
          </div>
          <div>
            <label className={labelCls}>遇到需确认的操作</label>
            <select className={inputCls} value={form.onConfirm} onChange={e => update({ onConfirm: e.target.value as any })}>
              <option value="reject">自动拒绝（推荐）</option>
              <option value="skip_tool">隐藏需确认的工具</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>超时（秒）</label>
            <input className={inputCls} type="number" value={form.timeoutSec} onChange={e => update({ timeoutSec: Number(e.target.value) })} />
          </div>
          <div>
            <label className={labelCls}>失败重试次数</label>
            <input className={inputCls} type="number" min={0} max={5} value={form.maxRetries} onChange={e => update({ maxRetries: Number(e.target.value) })} />
          </div>
          {error && <div className="col-span-2 text-xs text-red-500">{error}</div>}
        </div>
        <div className="px-4 py-3 border-t border-gray-200 flex justify-end gap-2">
          <button onClick={onClose} className="text-xs px-3 py-1.5 border border-gray-300 rounded text-gray-600 hover:bg-gray-50">取消</button>
          <button onClick={save} disabled={saving}
            className="text-xs px-3 py-1.5 bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RunHistoryDrawer({ task, onClose }: { task: ScheduledTask; onClose: () => void }) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);

  const load = useCallback(async (off: number) => {
    const data = await fetch(`${MAIN_URL}/api/scheduler/tasks/${task.id}/runs?limit=20&offset=${off}`, { headers: authHeaders() })
      .then(r => (r.ok ? r.json() : null)).catch(() => null);
    if (data) { setRuns(data.runs ?? []); setTotal(data.total ?? 0); setOffset(off); }
  }, [task.id]);

  useEffect(() => { load(0); }, [load]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20" onClick={onClose}>
      <div className="bg-white w-[480px] h-full shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="px-4 py-3 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-medium">执行历史 · {task.name}</span>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-lg leading-none">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2">
          {runs.length === 0 && <div className="text-xs text-gray-400 text-center py-10">暂无执行记录</div>}
          {runs.map(r => (
            <div key={r.id} className="border border-gray-200 rounded-lg p-3">
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${STATUS_STYLE[r.status] ?? 'bg-gray-100 text-gray-500'}`}>{r.status}</span>
                <span className="text-[10px] text-gray-400">{r.trigger === 'manual' ? '手动' : '定时'}</span>
                <span className="text-[10px] text-gray-400 ml-auto">{new Date(r.startedAt).toLocaleString('zh-CN')}</span>
                {r.durationMs != null && <span className="text-[10px] text-gray-400">{r.durationMs}ms</span>}
              </div>
              {r.output && <pre className="text-[11px] text-gray-600 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{r.output}</pre>}
              {r.error && <pre className="text-[11px] text-red-500 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">{r.error}</pre>}
            </div>
          ))}
        </div>
        {total > 20 && (
          <div className="px-4 py-2 border-t border-gray-200 flex items-center justify-between text-xs">
            <button disabled={offset === 0} onClick={() => load(offset - 20)} className="text-indigo-600 disabled:text-gray-300">上一页</button>
            <span className="text-gray-400">{offset + 1}–{Math.min(offset + 20, total)} / {total}</span>
            <button disabled={offset + 20 >= total} onClick={() => load(offset + 20)} className="text-indigo-600 disabled:text-gray-300">下一页</button>
          </div>
        )}
      </div>
    </div>
  );
}
