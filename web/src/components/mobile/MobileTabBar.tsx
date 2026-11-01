'use client';

/**
 * P4 移动端底部 TAB 条：对话 / 应用。含刘海屏底部安全区（env(safe-area-inset-bottom)）。
 */
interface Props {
  active: 'chat' | 'apps';
  onChange: (tab: 'chat' | 'apps') => void;
}

export default function MobileTabBar({ active, onChange }: Props) {
  const tabCls = (tab: 'chat' | 'apps') =>
    `flex-1 flex flex-col items-center gap-0.5 py-1.5 text-[10px] transition-colors ${
      active === tab ? 'text-indigo-600' : 'text-gray-400'
    }`;
  // 图标与 sidebar 同源：对话=chat.svg（侧边栏「ABC」主对话图标），应用=apps.svg（侧边栏「应用」图标）
  const iconCls = (tab: 'chat' | 'apps') =>
    `w-5 h-5 transition-opacity ${active === tab ? 'opacity-100' : 'opacity-40 grayscale'}`;
  return (
    <div className="flex items-stretch border-t border-gray-200 bg-white shrink-0 pb-[env(safe-area-inset-bottom)]">
      <button onClick={() => onChange('chat')} className={tabCls('chat')}>
        <img src="/icons/chat.svg" alt="" className={iconCls('chat')} />
        <span>对话</span>
      </button>
      <button onClick={() => onChange('apps')} className={tabCls('apps')}>
        <img src="/icons/apps.svg" alt="" className={iconCls('apps')} />
        <span>应用</span>
      </button>
    </div>
  );
}
