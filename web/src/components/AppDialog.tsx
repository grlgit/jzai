'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

/**
 * 全局弹出小部件（替代原生 alert/confirm）。
 *
 * - confirmDialog(message, opts?) — Promise<boolean> 确认弹窗（替代 confirm）
 * - alertInfo / alertError / alertSuccess — toast 提示（替代 alert）
 *
 * 宿主 <AppDialogHost /> 已在根布局挂载，任意组件内直接调用上述函数即可。
 */

export interface ConfirmOptions {
  title?: string;
  confirmText?: string;
  cancelText?: string;
  /** 危险操作（删除/吊销等）：确认按钮红色 */
  danger?: boolean;
}

interface ConfirmRequest extends ConfirmOptions {
  message: string;
  resolve: (ok: boolean) => void;
}

const EVENT = 'jz:app-confirm';

/** 确认弹窗（Promise 化，替代原生 confirm） */
export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    window.dispatchEvent(new CustomEvent<ConfirmRequest>(EVENT, {
      detail: { ...opts, message, resolve },
    }));
  });
}

/** 提示 toast（替代原生 alert） */
export function alertInfo(message: string) { toast.message(message); }
export function alertSuccess(message: string) { toast.success(message); }
export function alertError(message: string) { toast.error(message); }

/** 宿主组件：渲染确认弹窗。挂载一次（根布局）。 */
export function AppDialogHost() {
  const [current, setCurrent] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      const req = (e as CustomEvent<ConfirmRequest>).detail;
      setCurrent(req);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  const close = (ok: boolean) => {
    current?.resolve(ok);
    setCurrent(null);
  };

  if (!current) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30"
      onClick={() => close(false)}
    >
      <div
        className="bg-white rounded-lg shadow-xl border border-gray-200 w-[360px] max-w-[90vw] p-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="text-sm font-semibold text-gray-800 mb-2">
          {current.title ?? '确认操作'}
        </div>
        <div className="text-xs text-gray-600 leading-relaxed whitespace-pre-wrap break-words mb-4">
          {current.message}
        </div>
        <div className="flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-xs font-medium text-gray-600 bg-gray-100 rounded hover:bg-gray-200 transition-colors"
            onClick={() => close(false)}
            autoFocus
          >
            {current.cancelText ?? '取消'}
          </button>
          <button
            className={`px-3 py-1.5 text-xs font-medium text-white rounded transition-colors ${
              current.danger ? 'bg-red-600 hover:bg-red-700' : 'bg-indigo-600 hover:bg-indigo-700'
            }`}
            onClick={() => close(true)}
          >
            {current.confirmText ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
