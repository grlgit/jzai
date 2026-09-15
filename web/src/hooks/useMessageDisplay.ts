'use client';

import { useState, useEffect, useCallback } from 'react';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

export interface MessageDisplayConfig {
  toolProcess: boolean;
  toolResult: boolean;
  sourceRef: boolean;
  modelUsage: boolean;
}

const DEFAULT_CONFIG: MessageDisplayConfig = { toolProcess: true, toolResult: true, sourceRef: true, modelUsage: false };
const ALL_KEYS: (keyof MessageDisplayConfig)[] = ['toolProcess', 'toolResult', 'sourceRef', 'modelUsage'];

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export function useMessageDisplay(activeAgent: string = 'main') {
  const [global, setGlobal] = useState<MessageDisplayConfig>(DEFAULT_CONFIG);
  const [agents, setAgents] = useState<Record<string, Partial<MessageDisplayConfig>>>({});
  const [user, setUser] = useState<Record<string, Partial<MessageDisplayConfig>>>({});
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetch(`${MAIN_URL}/api/message-display`, { headers: authHeaders() }).then(r => r.json());
      if (data.global) setGlobal(data.global);
      if (data.agents) setAgents(data.agents);
      if (data.user) setUser(data.user);
    } catch {}
    setLoaded(true);
  }, []);

  useEffect(() => { load(); }, [load]);

  // Listen for cross-instance config changes
  useEffect(() => {
    const handler = () => { load(); };
    window.addEventListener('jianzhi:msgdisplay-changed', handler);
    return () => window.removeEventListener('jianzhi:msgdisplay-changed', handler);
  }, [load]);

  /**
   * Check if a message type should be displayed.
   * Two-level cascade: default (global merged with agent) → user override.
   * Agent-level config overrides global default for that agent.
   * User-level config overrides everything.
   */
  const shouldShow = useCallback((type: keyof MessageDisplayConfig) => {
    // Default: agent-specific setting overrides global, fallback to global, then per-key default
    const defaultVal = agents[activeAgent]?.[type] ?? global[type] ?? DEFAULT_CONFIG[type];
    // User override: per-agent first, then '_all', then default
    const userVal = user[activeAgent]?.[type] ?? user['_all']?.[type];
    return userVal !== undefined ? userVal : defaultVal;
  }, [global, agents, user, activeAgent]);

  /** Check if the effective default (global + agent) disables this type */
  const isDisabledByDefault = useCallback((type: keyof MessageDisplayConfig) => {
    const defaultVal = agents[activeAgent]?.[type] ?? global[type] ?? DEFAULT_CONFIG[type];
    return !defaultVal;
  }, [global, agents, activeAgent]);

  // Keep old names as aliases for backward compatibility in UI
  const isDisabledByGlobal = isDisabledByDefault;
  const isDisabledByAgent = useCallback((_type: keyof MessageDisplayConfig) => false, []);

  const notifyChanged = () => window.dispatchEvent(new Event('jianzhi:msgdisplay-changed'));

  const saveGlobal = useCallback(async (config: Partial<MessageDisplayConfig>) => {
    setGlobal(prev => ({ ...prev, ...config }));
    await fetch(`${MAIN_URL}/api/message-display/global`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify(config),
    }).catch(() => {});
    notifyChanged();
  }, []);

  const saveUser = useCallback(async (agentId: string, config: Partial<MessageDisplayConfig>) => {
    setUser(prev => ({ ...prev, [agentId]: { ...prev[agentId], ...config } }));
    await fetch(`${MAIN_URL}/api/message-display/user`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ agentId, config }),
    }).catch(() => {});
    notifyChanged();
  }, []);

  return { global, agents, user, shouldShow, isDisabledByGlobal, isDisabledByAgent, saveGlobal, saveUser, loaded, reload: load, ALL_KEYS };
}
