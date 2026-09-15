import { getMainUrl } from './env';

class ApiClient {
  private get baseUrl() { return getMainUrl(); }
  private refreshing: Promise<boolean> | null = null;

  private getToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('jz_token');
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    const token = this.getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  /** Attempt to refresh the access token using the stored refresh token */
  private async tryRefresh(): Promise<boolean> {
    if (typeof window === 'undefined') return false;
    const refreshToken = localStorage.getItem('jz_refresh_token');
    if (!refreshToken) return false;
    try {
      const res = await fetch(`${this.baseUrl}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return false;
      const data = await res.json();
      localStorage.setItem('jz_token', data.accessToken);
      localStorage.setItem('jz_refresh_token', data.refreshToken);
      return true;
    } catch {
      return false;
    }
  }

  private async handleResponse<T>(resp: Response, retryFn?: () => Promise<Response>): Promise<T> {
    if (resp.status === 401 && retryFn) {
      // Try refresh once (deduplicate concurrent refreshes)
      if (!this.refreshing) {
        this.refreshing = this.tryRefresh().finally(() => { this.refreshing = null; });
      }
      const refreshed = await this.refreshing;
      if (refreshed) {
        // Retry the original request with new token
        const retryResp = await retryFn();
        return this.handleResponse<T>(retryResp);
      }
      // Refresh failed — force logout
      if (typeof window !== 'undefined') {
        localStorage.removeItem('jz_token');
        localStorage.removeItem('jz_user');
        localStorage.removeItem('jz_refresh_token');
        window.location.reload();
      }
      throw new ApiError('登录已过期，请重新登录', 401);
    }

    if (resp.status === 401) {
      // Already retried, give up
      if (typeof window !== 'undefined') {
        localStorage.removeItem('jz_token');
        localStorage.removeItem('jz_user');
        localStorage.removeItem('jz_refresh_token');
        window.location.reload();
      }
      throw new ApiError('登录已过期，请重新登录', 401);
    }

    if (!resp.ok) {
      let message = `请求失败 (${resp.status})`;
      try {
        const body = await resp.json();
        message = body.message || body.error || message;
      } catch {}
      throw new ApiError(message, resp.status);
    }

    const text = await resp.text();
    if (!text) return undefined as T;
    return JSON.parse(text);
  }

  async get<T = any>(path: string): Promise<T> {
    const doFetch = () => fetch(`${this.baseUrl}${path}`, { headers: this.headers() });
    return this.handleResponse<T>(await doFetch(), doFetch);
  }

  async post<T = any>(path: string, body?: any): Promise<T> {
    const doFetch = () => fetch(`${this.baseUrl}${path}`, {
      method: 'POST', headers: this.headers(), body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(await doFetch(), doFetch);
  }

  async put<T = any>(path: string, body?: any): Promise<T> {
    const doFetch = () => fetch(`${this.baseUrl}${path}`, {
      method: 'PUT', headers: this.headers(), body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(await doFetch(), doFetch);
  }

  async patch<T = any>(path: string, body?: any): Promise<T> {
    const doFetch = () => fetch(`${this.baseUrl}${path}`, {
      method: 'PATCH', headers: this.headers(), body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(await doFetch(), doFetch);
  }

  async delete<T = any>(path: string): Promise<T> {
    const doFetch = () => fetch(`${this.baseUrl}${path}`, { method: 'DELETE', headers: this.headers() });
    return this.handleResponse<T>(await doFetch(), doFetch);
  }

  /** Upload a file via multipart form data */
  async upload<T = any>(path: string, formData: FormData): Promise<T> {
    const h: Record<string, string> = {};
    const token = this.getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    // Don't set Content-Type — browser will add multipart boundary
    const resp = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: h, body: formData });
    return this.handleResponse<T>(resp);
  }
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Singleton API client instance */
export const api = new ApiClient();
