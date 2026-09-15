'use client';

import { useState, useEffect, useCallback } from 'react';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

export interface Shortcut {
  id: string;
  name: string;
  icon: string;
  type: 'panel' | 'url';
  target: string;
  sortOrder: number;
}

export function useShortcuts(token?: string | null) {
  const [shortcuts, setShortcuts] = useState<Shortcut[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!token) { setShortcuts([]); setLoading(false); return; }
    try {
      const resp = await fetch(`${MAIN_URL}/api/shortcuts`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await resp.json();
      if (Array.isArray(data)) setShortcuts(data);
    } catch {}
    setLoading(false);
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const save = useCallback(async (items: Shortcut[]) => {
    if (!token) return;
    setShortcuts(items);
    await fetch(`${MAIN_URL}/api/shortcuts`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
  }, [token]);

  const reset = useCallback(async () => {
    if (!token) return;
    await fetch(`${MAIN_URL}/api/shortcuts`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    await load();
  }, [token, load]);

  return { shortcuts, loading, save, reset, reload: load };
}
