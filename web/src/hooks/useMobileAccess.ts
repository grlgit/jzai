'use client';

import { useState, useEffect } from 'react';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

/** 移动端 UA 判定：forceMobile 只在"移动地址 + 移动设备"同时成立时生效，
 *  避免 PC 经同一局域网地址访问时被强制为手机版式 */
const MOBILE_UA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i;

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
          // host(主机:端口) 一致 + 移动设备 UA，才视为从移动地址访问
          const hostMatch = new URL(data.url).host.toLowerCase() === window.location.host.toLowerCase();
          forceMobile = hostMatch && MOBILE_UA.test(window.navigator.userAgent);
        } catch {}
        setInfo({ url: data.url, configured: !!data.configured, forceMobile, loading: false });
      })
      .catch(() => { if (!cancelled) setInfo({ url: '', configured: false, forceMobile: false, loading: false }); });
    return () => { cancelled = true; };
  }, [token]);

  return info;
}
