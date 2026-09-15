'use client';

import { useRef, useCallback, useState, useEffect } from 'react';
import { useI18n } from '@/i18n';

interface FloatingPanelProps {
  visible: boolean;
  onClose: () => void;
  onDock?: () => void;
  children: React.ReactNode;
  defaultWidth?: number;
  defaultHeight?: number;
  minWidth?: number;
  minHeight?: number;
}

export default function FloatingPanel({
  visible, onClose, onDock, children,
  defaultWidth = 380, defaultHeight = 500,
  minWidth = 280, minHeight = 260,
}: FloatingPanelProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: defaultWidth, h: defaultHeight });
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null); // null = default (right-5 bottom-5)

  // Reset on hide
  useEffect(() => {
    if (!visible) {
      setPos(null);
      setSize({ w: defaultWidth, h: defaultHeight });
    }
  }, [visible, defaultWidth, defaultHeight]);

  // Drag
  const dragState = useRef<{ startX: number; startY: number; startPosX: number; startPosY: number; active: boolean }>({ startX: 0, startY: 0, startPosX: 0, startPosY: 0, active: false });

  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, input, textarea, select')) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
    dragState.current = {
      startX: e.clientX,
      startY: e.clientY,
      startPosX: rect.left - parentRect.left,
      startPosY: rect.top - parentRect.top,
      active: false,
    };

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - dragState.current.startX;
      const dy = ev.clientY - dragState.current.startY;
      if (!dragState.current.active && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        dragState.current.active = true;
        document.body.style.userSelect = 'none';
      }
      if (dragState.current.active) {
        setPos({ x: dragState.current.startPosX + dx, y: dragState.current.startPosY + dy });
      }
    };
    const onUp = () => {
      dragState.current.active = false;
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, []);

  // Resize (top-left handle)
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parentRect = panel.offsetParent?.getBoundingClientRect() || { left: 0, top: 0 };
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = size.w;
    const startH = size.h;
    const startLeft = rect.left - parentRect.left;
    const startTop = rect.top - parentRect.top;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'nw-resize';

    const onMove = (ev: MouseEvent) => {
      const dx = startX - ev.clientX;
      const dy = startY - ev.clientY;
      const newW = Math.max(minWidth, startW + dx);
      const newH = Math.max(minHeight, startH + dy);
      setSize({ w: newW, h: newH });
      setPos({ x: startLeft - (newW - startW), y: startTop - (newH - startH) });
    };
    const onUp = () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    e.preventDefault();
  }, [size, minWidth, minHeight]);

  if (!visible) return null;

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, width: size.w, height: size.h }
    : { right: 20, bottom: 20, width: size.w, height: size.h };

  return (
    <div
      ref={panelRef}
      className="absolute flex flex-col bg-white rounded-2xl shadow-[0_8px_32px_rgba(26,22,37,0.18),0_0_0_1px_#e8e5f0] z-50 overflow-hidden"
      style={style}
    >
      {/* Resize handle (top-left) */}
      <div
        onMouseDown={onResizeStart}
        className="absolute left-0 top-0 w-5 h-5 cursor-nw-resize z-10 opacity-0 hover:opacity-100 transition-opacity"
        style={{ touchAction: 'none' }}
      >
        <span className="absolute left-1.5 top-1 text-xs text-gray-400">↖</span>
      </div>

      {/* Draggable header */}
      <div
        onMouseDown={onDragStart}
        className="h-10 flex items-center px-3 border-b border-gray-200 shrink-0 cursor-move select-none"
      >
        <span className="text-xs text-gray-400 flex-1">{t('float.chat')}</span>
        {onDock && <button onClick={onDock} className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded w-6 h-6 flex items-center justify-center text-sm" title={t('float.dock')}>⬡</button>}
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded w-6 h-6 flex items-center justify-center text-sm">✕</button>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>
    </div>
  );
}
