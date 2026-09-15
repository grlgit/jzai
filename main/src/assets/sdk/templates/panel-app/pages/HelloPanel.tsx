import { useState } from 'react';
import type { PanelProps } from '../../types/panel';

export const panelMeta = { id: 'paMain', minWidth: 480, minHeight: 360 };

export default function HelloPanel({ initialData, onMessage }: PanelProps) {
  const [count, setCount] = useState(0);
  const data = initialData as { text?: string } | undefined;

  return (
    <div className="h-full flex flex-col items-center justify-center gap-3 p-6">
      <h2 className="text-base font-semibold text-gray-800">你好，见智</h2>
      <p className="text-xs text-gray-400">这是一个最小面板型 APP</p>
      {data?.text && <p className="text-xs text-indigo-600">agent 说：{data.text}</p>}
      <div className="flex items-center gap-2">
        <button
          className="px-3 py-1 text-xs bg-gray-100 text-gray-600 rounded hover:bg-gray-200"
          onClick={() => setCount(c => c + 1)}
        >
          点击了 {count} 次
        </button>
        <button
          className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700"
          onClick={() => onMessage?.({ type: 'greet', text: `面板已点击 ${count + 1} 次` })}
        >
          告诉 agent
        </button>
      </div>
    </div>
  );
}
