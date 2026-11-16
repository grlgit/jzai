'use client';

import { useState, useCallback, useEffect, useRef } from 'react';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();
const TOKEN_KEY = 'jz_token';
const USER_KEY = 'jz_user';

export interface AuthUser {
  id: string;
  name: string;
  username: string;
  email: string;
  role: { id: string; name: string; permissions: string[] } | string;
  passwordChanged?: boolean;
}

function getRoleName(role: any): string {
  if (typeof role === 'string') return role;
  return role?.name || role?.id || 'user';
}

function isAdmin(user: AuthUser | null): boolean {
  if (!user) return false;
  if (typeof user.role === 'string') return user.role === 'admin';
  return user.role?.id === 'admin' || user.role?.permissions?.includes('sys:admin');
}

/** 是否处于钉钉 WebView 环境（UA 含 DingTalk，或 URL 带钉钉注入的 corpId 参数） */
function isDingtalkEnv(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/DingTalk/i.test(navigator.userAgent)) return true;
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('corpId')) return true;
  return false;
}

/** 动态加载钉钉 JSAPI（免登 requestAuthCode 需要） */
function loadDingtalkJsapi(): Promise<any> {
  if (typeof window !== 'undefined' && (window as any).dd) return Promise.resolve((window as any).dd);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js';
    script.onload = () => resolve((window as any).dd);
    script.onerror = () => reject(new Error('钉钉 JSAPI 加载失败'));
    document.head.appendChild(script);
  });
}

/** 是否处于飞书 WebView 环境（UA 含 Lark/Feishu） */
function isFeishuEnv(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Lark|Feishu/i.test(navigator.userAgent);
}

/** 是否为飞书 OAuth 授权重定向回跳（带 state=jz_feishu 标记 + code） */
function isFeishuRedirect(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get('state') === 'jz_feishu' && params.has('code');
}

/** 动态加载飞书 JSSDK（免登 getAuthCode 需要） */
function loadFeishuJsapi(): Promise<any> {
  if (typeof window !== 'undefined' && (window as any).h5sdk) return Promise.resolve((window as any).h5sdk);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://lf-package-lark.skg-if.feishucdn.com/obj/feishu-lark-open/lark-h5-sdk-2.1.0/h5-js-sdk-2.1.0.js';
    script.onload = () => resolve((window as any).h5sdk);
    script.onerror = () => reject(new Error('飞书 JSSDK 加载失败'));
    document.head.appendChild(script);
  });
}

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // 钉钉免登状态：authenticating 期间页面显示加载态而不是登录表单
  const [dingtalkState, setDingtalkState] = useState<'idle' | 'authenticating' | 'failed'>('idle');
  // 飞书免登状态：同上
  const [feishuState, setFeishuState] = useState<'idle' | 'authenticating' | 'failed'>('idle');

  const doLogout = useRef(() => {
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem('jz_refresh_token');
  });

  useEffect(() => {
    if (typeof window === 'undefined') { setLoading(false); return; }
    let hasSavedToken = false;
    try {
      const savedToken = localStorage.getItem(TOKEN_KEY);
      const savedUser = localStorage.getItem(USER_KEY);
      if (savedToken && savedUser) {
        hasSavedToken = true;
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
        fetch(`${MAIN_URL}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${savedToken}` },
        })
          .then(r => { if (!r.ok) throw new Error(); return r.json(); })
          .then(u => { setUser(u); localStorage.setItem(USER_KEY, JSON.stringify(u)); })
          .catch(() => { 
            doLogout.current();
            // 本地 token 已被服务端失效（如账号被删除、JWT_SECRET 更换）：钉钉/飞书环境自动重新免登
            if (isDingtalkEnv()) {
              loginWithDingtalk();
            } else if (isFeishuEnv() || isFeishuRedirect()) {
              loginWithFeishu();
            }
           });
      }
    } catch { /* ignore SSR or parse errors */ }
    // 钉钉/飞书环境且本地无 token：自动发起免登
    if (!hasSavedToken && isDingtalkEnv()) {
      loginWithDingtalk().finally(() => setLoading(false));
    } else if (!hasSavedToken && (isFeishuEnv() || isFeishuRedirect())) {
      loginWithFeishu().finally(() => setLoading(false));
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (account: string, password: string): Promise<string | null> => {
    try {
      const res = await fetch(`${MAIN_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, password }),
      });
      if (!res.ok) {
        const data = await res.json();
        return data.message || '登录失败';
      }
      const data = await res.json();
      const userData = { ...data.user, passwordChanged: data.passwordChanged };
      const accessToken = data.accessToken || data.token;
      setToken(accessToken);
      setUser(userData);
      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(USER_KEY, JSON.stringify(userData));
      if (data.refreshToken) {
        localStorage.setItem('jz_refresh_token', data.refreshToken);
      }
      return null;
    } catch {
      return '无法连接服务器';
    }
  }, []);

  /** 钉钉免登：JSAPI 取临时授权码 → 后端换取系统 token（首次登录自动建号） */
  const loginWithDingtalk = useCallback(async (): Promise<string | null> => {
    setDingtalkState('authenticating');
    try {
      const dd = await loadDingtalkJsapi();

      // corpId：优先取钉钉注入到 URL 的参数，否则读后端配置（DINGTALK_CORP_ID）
      let corpId = new URLSearchParams(window.location.search).get('corpId') || '';
      if (!corpId) {
        const res = await fetch(`${MAIN_URL}/api/auth/dingtalk/corpId`);
        if (res.ok) corpId = (await res.json()).corpId || '';
      }
      if (!corpId) throw new Error('缺少 corpId 配置');

      const authCode = await new Promise<string>((resolve, reject) => {
        dd.ready(() => {
          dd.runtime.permission.requestAuthCode({
            corpId,
            onSuccess: (result: any) => resolve(result.code),
            onFail: (err: any) => reject(new Error(err?.message || '获取钉钉授权码失败')),
          });
        });
        dd.error((err: any) => reject(new Error(err?.message || '钉钉 JSAPI 初始化失败')));
      });

      const res = await fetch(`${MAIN_URL}/api/auth/dingtalk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authCode }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || '钉钉免登失败');
      }
      const data = await res.json();
      const userData = { ...data.user, passwordChanged: data.passwordChanged };
      const accessToken = data.accessToken || data.token;
      setToken(accessToken);
      setUser(userData);
      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(USER_KEY, JSON.stringify(userData));
      if (data.refreshToken) {
        localStorage.setItem('jz_refresh_token', data.refreshToken);
      }
      setDingtalkState('idle');
      return null;
    } catch (e: any) {
      setDingtalkState('failed');
      return e?.message || '钉钉免登失败';
    }
  }, []);

  /** 飞书免登：h5sdk getAuthCode（客户端内）或 OAuth 重定向（兜底）取临时授权码 → 后端换取系统 token（首次登录自动建号） */
  const loginWithFeishu = useCallback(async (): Promise<string | null> => {
    setFeishuState('authenticating');
    try {
      // OAuth 重定向回跳：URL 带 state=jz_feishu + code，直接复用
      const params = new URLSearchParams(window.location.search);
      let authCode = isFeishuRedirect() ? params.get('code') || '' : '';

      if (!authCode) {
        // app_id 非敏感，从后端读取（FEISHU_APP_ID）
        const res = await fetch(`${MAIN_URL}/api/auth/feishu/appId`);
        if (!res.ok) throw new Error('无法获取飞书登录配置');
        const appId = (await res.json()).appId || '';
        if (!appId) throw new Error('飞书登录未配置');

        try {
          const h5sdk = await loadFeishuJsapi();
          authCode = await new Promise<string>((resolve, reject) => {
            h5sdk.ready(() => {
              (window as any).tt.getAuthCode({
                app_id: appId,
                success: (result: any) => resolve(result.code),
                fail: (err: any) => reject(new Error(err?.errMsg || '获取飞书授权码失败')),
              });
            });
            h5sdk.error((err: any) => reject(new Error(err?.errMsg || '飞书 JSSDK 初始化失败')));
          });
        } catch {
          // JSSDK 不可用（非客户端内浏览器等）：退回 OAuth 网页授权跳转
          const redirectUri = encodeURIComponent(window.location.origin + window.location.pathname);
          window.location.href = `https://open.feishu.cn/open-apis/authen/v1/authorize?app_id=${appId}&redirect_uri=${redirectUri}&response_type=code&state=jz_feishu`;
          return null; // 正在跳转，后续登录由回跳流程接管
        }
      }

      // 清理 URL 上的授权码残留
      if (params.has('code')) {
        params.delete('code'); params.delete('state');
        const clean = params.toString();
        window.history.replaceState({}, '', `${window.location.pathname}${clean ? `?${clean}` : ''}`);
      }

      const res = await fetch(`${MAIN_URL}/api/auth/feishu`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authCode, redirectUri: window.location.origin + window.location.pathname }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message || '飞书免登失败');
      }
      const data = await res.json();
      const userData = { ...data.user, passwordChanged: data.passwordChanged };
      const accessToken = data.accessToken || data.token;
      setToken(accessToken);
      setUser(userData);
      localStorage.setItem(TOKEN_KEY, accessToken);
      localStorage.setItem(USER_KEY, JSON.stringify(userData));
      if (data.refreshToken) {
        localStorage.setItem('jz_refresh_token', data.refreshToken);
      }
      setFeishuState('idle');
      return null;
    } catch (e: any) {
      setFeishuState('failed');
      return e?.message || '飞书免登失败';
    }
  }, []);

  const logout = useCallback(() => {
    doLogout.current();
  }, []);

  return {
    user, token, loading,
    /** 钉钉免登进行中（页面据此显示加载态，避免闪现登录表单） */
    dingtalkAuthenticating: dingtalkState === 'authenticating',
    /** 飞书免登进行中（同上） */
    feishuAuthenticating: feishuState === 'authenticating',
    login, loginWithDingtalk, loginWithFeishu, logout, isAdmin: isAdmin(user), getRoleName,
  };
}
