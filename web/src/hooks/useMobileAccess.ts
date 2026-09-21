'use client';

import { useState, useEffect } from 'react';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

interface MobileAccessInfo {
  /** 生效的移动访问地址（已配置值或后端自动探测的 IP+端口） */
  url: string;
  /** 是否为管理员显式配置（false = 自动探测默认值） */
  configured: boolean;
  /** 当前页面正是通过移动地址访问 → 始终强制手机模式 */
  forceMobile: boolean;
  loading: boolean;
}

export function useMobileAccess(token: string | null): MobileAccessInfo {
  const [info, setInfo] = useState<MobileAccessInfo>({ url: '', configured: false, forceMobile: false, loading: true });

  useEffect(() => {
    if (!token) { setInfo({ url: '', configured: false, forceMobile: false, loading: false }); return; }
    let cancelled = false;
    fetch(`${MAIN_URL}/api/mobile-access`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled || !data?.url) { if (!cancelled) setInfo({ url: '', configured: false, forceMobile: false, loading: false }); return; }
        let forceMobile = false;
        try {
          // host(主机:端口) 一致即视为从移动地址访问
          forceMobile = new URL(data.url).host.toLowerCase() === window.location.host.toLowerCase();
        } catch {}
        setInfo({ url: data.url, configured: !!data.configured, forceMobile, loading: false });
      })
      .catch(() => { if (!cancelled) setInfo({ url: '', configured: false, forceMobile: false, loading: false }); });
    return () => { cancelled = true; };
  }, [token]);

  return info;
}
