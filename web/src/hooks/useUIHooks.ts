'use client';

import { useEffect, useRef, useCallback } from 'react';

/**
 * useUIHooks — registers panel-specific hook handlers for agent → UI communication.
 *
 * Usage:
 *   useUIHooks('dashboard', {
 *     'refresh': ({ dashboardId }) => loadDashboard(dashboardId),
 *     'show-file': ({ fileId }) => selectFile(fileId),
 *   });
 *
 * The agent triggers hooks via __action with actionType='ui_hook'.
 * page.tsx dispatches 'jianzhi:ui-hook' events which this hook listens to.
 * Built-in debounce: same hook called multiple times within 300ms only fires once.
 */
export function useUIHooks(panel: string, hooks: Record<string, (params: any) => void>) {
  const hooksRef = useRef(hooks);
  hooksRef.current = hooks;

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const handler = useCallback((e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (!detail || detail.panel !== panel) return;

    const { hook, params } = detail;
    const fn = hooksRef.current[hook];
    if (!fn) return;

    // Debounce: same hook within 300ms only fires once (handles concurrent tool calls)
    const key = `${hook}:${JSON.stringify(params || {})}`;
    if (debounceTimers.current[key]) clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = setTimeout(() => {
      fn(params || {});
      delete debounceTimers.current[key];
    }, 300);
  }, [panel]);

  useEffect(() => {
    window.addEventListener('jianzhi:ui-hook', handler);
    return () => {
      window.removeEventListener('jianzhi:ui-hook', handler);
      // Clear pending debounce timers
      Object.values(debounceTimers.current).forEach(clearTimeout);
    };
  }, [handler]);
}
