import { useState } from 'react';
import type { PanelProps } from '../../types/panel';

export const panelMeta = { id: 'mtMain', minWidth: 560, minHeight: 420 };

/**
 * 多页签在单面板组件内实现：不注册多个面板。
 * 三个页签共享同一个 store（useState），切页签不丢状态（keepAlive: true）。
 */
interface Store {
  projectName: string;
  budget: number;
  rows: Array<{ item: string; qty: number; price: number }>;
}

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'detail', label: '明细' },
  { key: 'settings', label: '设置' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function TabsPanel(_props: PanelProps) {
  const [tab, setTab] = useState<TabKey>('overview');
  // 页签共享 store：任一页签的修改，其他页签立即可见
  const [store, setStore] = useState<Store>({
    projectName: '示例项目',
    budget: 100000,
    rows: [
      { item: '服务器', qty: 2, price: 28000 },
      { item: '交换机', qty: 4, price: 3500 },
      { item: '实施服务', qty: 10, price: 1200 },
    ],
  });

  const total = store.rows.reduce((s, r) => s + r.qty * r.price, 0);

  return (
    <div className="h-full flex flex-col">
      {/* 页签条 */}
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
        {tab === 'overview' && (
          /* 概览：卡片 */
          <div className="grid grid-cols-2 gap-3">
            <div className="border border-gray-100 rounded-lg p-4">
              <p className="text-xs text-gray-400">项目</p>
              <p className="text-sm font-semibold text-gray-800 mt-1">{store.projectName}</p>
            </div>
            <div className="border border-gray-100 rounded-lg p-4">
              <p className="text-xs text-gray-400">预算</p>
              <p className="text-sm font-semibold text-gray-800 mt-1">¥{store.budget.toLocaleString()}</p>
            </div>
            <div className="border border-gray-100 rounded-lg p-4">
              <p className="text-xs text-gray-400">明细合计</p>
              <p className="text-sm font-semibold text-indigo-700 mt-1">¥{total.toLocaleString()}</p>
            </div>
            <div className="border border-gray-100 rounded-lg p-4">
              <p className="text-xs text-gray-400">预算余量</p>
              <p className={`text-sm font-semibold mt-1 ${store.budget - total >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
                ¥{(store.budget - total).toLocaleString()}
              </p>
            </div>
          </div>
        )}

        {tab === 'detail' && (
          /* 明细：表格 */
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-gray-400 border-b border-gray-100">
                <th className="py-1.5 font-normal">条目</th>
                <th className="py-1.5 font-normal text-right">数量</th>
                <th className="py-1.5 font-normal text-right">单价</th>
                <th className="py-1.5 font-normal text-right">小计</th>
              </tr>
            </thead>
            <tbody>
              {store.rows.map((r, i) => (
                <tr key={i} className="border-b border-gray-50">
                  <td className="py-1.5 text-gray-700">{r.item}</td>
                  <td className="py-1.5 text-right text-gray-500">{r.qty}</td>
                  <td className="py-1.5 text-right text-gray-500">¥{r.price.toLocaleString()}</td>
                  <td className="py-1.5 text-right text-gray-700">¥{(r.qty * r.price).toLocaleString()}</td>
                </tr>
              ))}
              <tr>
                <td colSpan={3} className="py-1.5 text-right font-medium text-gray-700">合计</td>
                <td className="py-1.5 text-right font-medium text-indigo-700">¥{total.toLocaleString()}</td>
              </tr>
            </tbody>
          </table>
        )}

        {tab === 'settings' && (
          /* 设置：表单（改动即反映到概览页签） */
          <div className="flex flex-col gap-3 max-w-xs">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-400">项目名称</span>
              <input
                className="px-3 py-1.5 text-sm border border-gray-200 rounded"
                value={store.projectName}
                onChange={e => setStore(s => ({ ...s, projectName: e.target.value }))}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-gray-400">预算（元）</span>
              <input
                className="px-3 py-1.5 text-sm border border-gray-200 rounded"
                type="number"
                value={store.budget}
                onChange={e => setStore(s => ({ ...s, budget: Number(e.target.value) || 0 }))}
              />
            </label>
            <p className="text-[11px] text-gray-400">
              修改后切到"概览"页签即可看到联动——三个页签共享同一 useState store。
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
