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

export function useAuth() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const doLogout = useRef(() => {
    setToken(null);
    setUser(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem('jz_refresh_token');
  });

  useEffect(() => {
    if (typeof window === 'undefined') { setLoading(false); return; }
    try {
      const savedToken = localStorage.getItem(TOKEN_KEY);
      const savedUser = localStorage.getItem(USER_KEY);
      if (savedToken && savedUser) {
        setToken(savedToken);
        setUser(JSON.parse(savedUser));
        fetch(`${MAIN_URL}/api/auth/me`, {
          headers: { 'Authorization': `Bearer ${savedToken}` },
        })
          .then(r => { if (!r.ok) throw new Error(); return r.json(); })
          .then(u => { setUser(u); localStorage.setItem(USER_KEY, JSON.stringify(u)); })
          .catch(() => { doLogout.current(); });
      }
    } catch { /* ignore SSR or parse errors */ }
    setLoading(false);
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

  const logout = useCallback(() => {
    doLogout.current();
  }, []);

  return { user, token, loading, login, logout, isAdmin: isAdmin(user), getRoleName };
}
