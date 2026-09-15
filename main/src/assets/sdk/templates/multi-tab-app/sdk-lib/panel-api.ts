/**
 * 面板端平台 API 助手。
 * 面板与主台同源，直接相对路径 fetch；凭据复用主台登录态（localStorage jz_token）。
 */

export function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

/**
 * 调用本 APP 的 backend controller 方法（invoke 入口）。
 * handler 格式 "ClassName.methodName"，必须在 manifest backend.controllers[].handlers 中声明。
 */
export async function invoke<T = any>(appId: string, handler: string, body: unknown = {}): Promise<T> {
  const resp = await fetch(`/api/app-store/apps/${encodeURIComponent(appId)}/invoke/${handler}`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`invoke ${handler} failed: ${resp.status} ${text}`);
  }
  return resp.json();
}

/** 调用平台其他 REST（如 /api/files/upload）。 */
export async function platformFetch<T = any>(url: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers ?? {}) },
  });
  if (!resp.ok) throw new Error(`${url} failed: ${resp.status}`);
  return resp.json();
}
