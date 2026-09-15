import * as http from 'http';
import * as https from 'https';
import * as url from 'url';

/**
 * Per-user HTTP client for MCP handlers.
 * Each user gets their own cookie jar, ensuring session isolation
 * when multiple users call the same MCP server concurrently.
 */

// Per-user cookie storage: userId -> cookie[]
const userCookies = new Map<string, string[]>();

export class McpHttpClient {
  private readonly userId: string;

  constructor(userId?: string) {
    this.userId = userId || '_anonymous';
    if (!userCookies.has(this.userId)) {
      userCookies.set(this.userId, []);
    }
  }

  private get cookies(): string[] {
    return userCookies.get(this.userId) || [];
  }

  private set cookies(val: string[]) {
    userCookies.set(this.userId, val);
  }

  async request(method: string, reqUrl: string, body?: any, headers?: Record<string, string>, _retried = false): Promise<{
    status: number;
    headers: Record<string, string>;
    data: any;
  }> {
    return new Promise((resolve, reject) => {
      const parsed = new url.URL(reqUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };
      if (this.cookies.length > 0) {
        reqHeaders['Cookie'] = this.cookies.join('; ');
      }

      let bodyStr = '';
      if (body) {
        if (typeof body === 'string') {
          bodyStr = body;
        } else if (reqHeaders['Content-Type'] === 'application/x-www-form-urlencoded') {
          // Format as URL-encoded string: key=value&key2=value2
          bodyStr = Object.entries(body)
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join('&');
        } else {
          bodyStr = JSON.stringify(body);
        }
        reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr).toString();
      }

      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: method.toUpperCase(),
        headers: reqHeaders,
        timeout: 30000,
      }, (res) => {
        const setCookies = res.headers['set-cookie'];
        if (setCookies) {
          let current = this.cookies;
          for (const c of setCookies) {
            const name = c.split('=')[0];
            current = current.filter(existing => !existing.startsWith(name + '='));
            current.push(c.split(';')[0]);
          }
          this.cookies = current;
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let parsed: any;
          try { parsed = JSON.parse(data.trim()); } catch {
            try {
              parsed = JSON.parse(data.trim().replace(/'/g, '"').replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":'));
            } catch { parsed = data; }
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, string>,
            data: parsed,
          });
        });
      });

      req.on('error', (err) => {
        // Retry once on socket hang up
        if (err.message === 'socket hang up' && !_retried) {
          this.request(method, reqUrl, body, headers, true).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时 (30s)')); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async get(reqUrl: string, headers?: Record<string, string>) {
    return this.request('GET', reqUrl, undefined, headers);
  }

  async post(reqUrl: string, body?: any, headers?: Record<string, string>) {
    return this.request('POST', reqUrl, body, headers);
  }

  async put(reqUrl: string, body?: any, headers?: Record<string, string>) {
    return this.request('PUT', reqUrl, body, headers);
  }

  async delete(reqUrl: string, headers?: Record<string, string>) {
    return this.request('DELETE', reqUrl, undefined, headers);
  }

  /** Clear this user's cached cookies/sessions */
  clearSession() {
    userCookies.set(this.userId, []);
  }

  /** Clear all users' cached sessions (for admin/maintenance) */
  static clearAllSessions() {
    userCookies.clear();
  }
}
