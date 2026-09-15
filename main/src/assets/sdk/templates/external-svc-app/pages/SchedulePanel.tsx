import { useEffect, useRef, useState } from 'react';
import type { PanelProps } from '../../types/panel';
import { invoke } from '../sdk-lib/panel-api';

export const panelMeta = { id: 'esMain', minWidth: 720, minHeight: 480 };

const APP_ID = 'com.example.external-svc-app';

const TABS = [
  { key: 'params', label: '排程设定' },
  { key: 'resources', label: '资源确认' },
  { key: 'orders', label: '订单确认' },
  { key: 'schedule', label: '排程' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

interface Job {
  id: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  progress: number;
  metrics?: any;
}

export default function SchedulePanel(_props: PanelProps) {
  const [tab, setTab] = useState<TabKey>('params');

  return (
    <div className="h-full flex flex-col">
      <div className="flex gap-1 border-b border-gray-200 px-3 pt-2">
        {TABS.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-3 py-1.5 text-xs rounded-t ${tab === t.key
              ? 'bg-indigo-50 text-indigo-700 font-medium'
              : 'text-gray-500 hover:bg-gray-50'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {tab === 'params' && <ParamsTab />}
        {tab === 'resources' && <ResourcesTab />}
        {tab === 'orders' && <OrdersTab />}
        {tab === 'schedule' && <ScheduleTab />}
      </div>
    </div>
  );
}

/* ── 排程设定：参数说明骨架（真实项目在此读写 params 表） ── */
function ParamsTab() {
  return (
    <div className="flex flex-col gap-3 max-w-md text-xs text-gray-500">
      <h3 className="text-sm font-semibold text-gray-800">排程参数</h3>
      <p>滚动周期、锁定规则、优先级权重等参数存于 params 表（骨架，按需扩展表单）。</p>
      <label className="flex flex-col gap-1">
        <span className="text-gray-400">排程范围</span>
        <select className="px-3 py-1.5 border border-gray-200 rounded text-gray-700">
          <option>下周（next-week）</option>
          <option>未来两周</option>
          <option>本月</option>
        </select>
      </label>
    </div>
  );
}

/* ── 资源确认：经平台 MCP 连接器从 ERP 同步 ── */
function ResourcesTab() {
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const sync = async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await invoke<{ synced: number }>(APP_ID, 'ScheduleController.syncResources');
      setMsg(`已同步 ${r.synced} 条资源（经平台 MCP 连接器读 ERP）`);
    } catch (e: any) {
      setMsg(`同步失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 max-w-md">
      <h3 className="text-sm font-semibold text-gray-800">资源确认</h3>
      <p className="text-xs text-gray-500">从 ERP 拉取机器/模具/日历资源并确认（骨架展示同步入口）。</p>
      <button
        className="self-start px-4 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50"
        onClick={sync}
        disabled={busy}
      >
        {busy ? '同步中…' : '从 ERP 同步资源'}
      </button>
      {msg && <p className="text-xs text-gray-500">{msg}</p>}
    </div>
  );
}

/* ── 订单确认：勾选参与排程的订单 ── */
function OrdersTab() {
  const [orders, setOrders] = useState<Array<{ id: string; confirmed: boolean }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');

  const reload = async () => {
    const r = await invoke<{ orders: any[] }>(APP_ID, 'ScheduleController.listOrders');
    setOrders(r.orders);
    setSelected(new Set(r.orders.filter((o: any) => o.confirmed).map((o: any) => o.id)));
  };

  useEffect(() => { void reload().catch(e => setMsg(e.message)); }, []);

  const confirm = async () => {
    try {
      await invoke(APP_ID, 'ScheduleController.confirmOrders', { orderIds: [...selected] });
      setMsg(`已确认 ${selected.size} 张订单参与排程`);
      await reload();
    } catch (e: any) {
      setMsg(`确认失败：${e.message}`);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-800">订单确认</h3>
        <button
          className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
          onClick={confirm}
        >
          确认所选
        </button>
      </div>
      {msg && <p className="text-xs text-gray-500">{msg}</p>}
      <ul className="divide-y divide-gray-100 border border-gray-100 rounded max-h-80 overflow-auto">
        {orders.map(o => (
          <li key={o.id} className="flex items-center gap-2 px-3 py-2 text-xs">
            <input
              type="checkbox"
              checked={selected.has(o.id)}
              onChange={e => {
                const next = new Set(selected);
                if (e.target.checked) next.add(o.id); else next.delete(o.id);
                setSelected(next);
              }}
            />
            <span className="font-mono text-gray-600">{o.id}</span>
            {o.confirmed && <span className="text-emerald-600">已确认</span>}
          </li>
        ))}
        {orders.length === 0 && (
          <li className="px-3 py-6 text-center text-xs text-gray-400">暂无订单（请先在资源确认页签同步数据）</li>
        )}
      </ul>
    </div>
  );
}

/* ── 排程：创建 → 轮询 → 指标卡片 → 调整预演 → 确认落库 ── */
function ScheduleTab() {
  const [job, setJob] = useState<Job | null>(null);
  const [impact, setImpact] = useState<any>(null);
  const [confirmToken, setConfirmToken] = useState('');
  const [showConfirm, setShowConfirm] = useState(false);
  const [msg, setMsg] = useState('');
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { if (timer.current) clearInterval(timer.current); }, []);

  /** 轮询某个 job 直到终态 */
  const poll = (jobId: string, onDone: (j: Job) => void) => {
    if (timer.current) clearInterval(timer.current);
    timer.current = setInterval(async () => {
      const j = await invoke<Job>(APP_ID, 'ScheduleController.getJob', { jobId });
      setJob(j);
      if (j.status === 'done' || j.status === 'failed') {
        if (timer.current) clearInterval(timer.current);
        timer.current = null;
        onDone(j);
      }
    }, 2000);
  };

  const createJob = async () => {
    setMsg('');
    setImpact(null);
    try {
      const { jobId } = await invoke<{ jobId: string }>(APP_ID, 'ScheduleController.createJob', {});
      poll(jobId, () => {});
    } catch (e: any) {
      setMsg(`创建失败：${e.message}`);
    }
  };

  /** 调整预演：创建 scenario → 轮询 → 取冲击 + confirmToken */
  const preview = async () => {
    if (!job?.id) return;
    setMsg('');
    try {
      // 示例 ops：真实项目由面板上的手工调整（插单/改交期）生成
      const ops = [{ op: 'change_priority', orderIds: ['PO-1042'] }];
      const { scenarioId } = await invoke<{ scenarioId: string }>(
        APP_ID, 'ScheduleController.previewImpact', { baselineJobId: job.id, ops });
      poll(scenarioId, async () => {
        const r = await invoke<{ impact?: any; confirmToken?: string }>(
          APP_ID, 'ScheduleController.previewImpact', { scenarioId });
        setImpact(r.impact);
        setConfirmToken(r.confirmToken ?? '');
        setShowConfirm(true); // 弹窗：先如实告知冲击，用户确认后才落库
      });
    } catch (e: any) {
      setMsg(`预演失败：${e.message}`);
    }
  };

  const apply = async () => {
    if (!job?.id || !confirmToken) return;
    try {
      await invoke(APP_ID, 'ScheduleController.applyResult', {
        scenarioId: job.id, // job 此时为 scenario 任务
        confirmToken,
      });
      setShowConfirm(false);
      setImpact(null);
      setMsg('已落库为正式计划');
    } catch (e: any) {
      setMsg(`落库失败：${e.message}`);
    }
  };

  const m = job?.metrics;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-800 flex-1">排程</h3>
        <button
          className="px-4 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
          onClick={createJob}
        >
          创建排程
        </button>
        <button
          className="px-4 py-1.5 text-xs border border-indigo-200 text-indigo-700 rounded hover:bg-indigo-50 disabled:opacity-50"
          onClick={preview}
          disabled={!job || job.status !== 'done'}
        >
          调整预演
        </button>
      </div>
      {msg && <p className="text-xs text-gray-500">{msg}</p>}

      {/* 进度条 */}
      {job && (
        <div>
          <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
            <span className="font-mono">{job.id}</span>
            <span>{job.status} · {job.progress}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded overflow-hidden">
            <div className="h-full bg-indigo-500 transition-all" style={{ width: `${job.progress}%` }} />
          </div>
        </div>
      )}

      {/* 指标卡片（聚合摘要；全量甘特骨架略） */}
      {job?.status === 'done' && m && (
        <div className="grid grid-cols-2 gap-3">
          <MetricCard label="违约订单" value={`${m.lateCount ?? 0} 单`} warn={(m.lateCount ?? 0) > 0} />
          <MetricCard label="换模损失" value={`${m.changeoverLossPct ?? 0}%`} warn={(m.changeoverLossPct ?? 0) > 12} />
          <MetricCard label="最大 LeadTime" value={`${m.maxLeadTimeDays ?? 0} 天`} />
          <MetricCard label="平均 WIP / CT" value={`${m.avgWip ?? 0} / ${m.avgCt ?? 0}`} />
        </div>
      )}

      {/* confirmToken 确认弹窗：冲击如实告知 → 用户确认 → 落库 */}
      {showConfirm && impact && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-5 w-96 shadow-xl">
            <h4 className="text-sm font-semibold text-gray-800 mb-2">确认应用调整方案？</h4>
            <div className="text-xs text-gray-600 space-y-1 mb-4">
              <p>违约变化：{impact.lateDelta > 0 ? `+${impact.lateDelta}` : impact.lateDelta} 单</p>
              <p>换模损失变化：{Number(impact.changeoverLossPctDelta ?? 0).toFixed(1)}%</p>
              {(impact.newlyLateOrders ?? []).length > 0 && (
                <p className="text-red-500">
                  新增违约：{impact.newlyLateOrders.map((o: any) => o.orderId).join('、')}
                </p>
              )}
              <p className="text-gray-400">confirmToken 10 分钟内有效，确认后立即落库。</p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs text-gray-500 border border-gray-200 rounded hover:bg-gray-50"
                onClick={() => setShowConfirm(false)}
              >
                取消
              </button>
              <button
                className="px-3 py-1.5 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
                onClick={apply}
              >
                确认落库
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="border border-gray-100 rounded-lg p-3">
      <p className="text-xs text-gray-400">{label}</p>
      <p className={`text-sm font-semibold mt-1 ${warn ? 'text-amber-600' : 'text-gray-800'}`}>{value}</p>
    </div>
  );
}
