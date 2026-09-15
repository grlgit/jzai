import { getMainUrl as getBaseUrl } from '@/lib/env'
const API_PREFIX = '/api/kb'

function getToken(): string {
  if (typeof window === 'undefined') return ''
  return localStorage.getItem('jz_token') || ''
}

export async function apiFetch<T>(
  path: string,
  _token?: string,
  options?: RequestInit,
): Promise<T> {
  const token = getToken()

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options?.headers as Record<string, string>,
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  const res = await fetch(`${getBaseUrl()}${API_PREFIX}${path}`, {
    ...options,
    headers,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.detail || `API error: ${res.status}`)
  }
  if (res.status === 204) return undefined as T
  return res.json()
}

export function getDocumentsWsUrl(kbId: string): string {
  if (typeof window !== 'undefined') {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${API_PREFIX}/v1/ws/documents/${kbId}`;
  }
  return `${getBaseUrl().replace(/^http/, 'ws')}${API_PREFIX}/v1/ws/documents/${kbId}`;
}

export function getMode(): 'local' {
  return 'local'
}
