import { Injectable } from '@nestjs/common';

export interface AppLogEntry {
  ts: number;
  level: 'log' | 'warn' | 'error';
  message: string;
}

/**
 * Per-app in-memory log ring buffer (debug facility, not persistence).
 * AppContext.logger writes here; read via GET /api/app-store/apps/:appId/logs (SSE)
 * or jd_tail_logs. Buffer is volatile by design — durable auditing goes to
 * jz_app_audit_log.
 */
@Injectable()
export class AppLogService {
  private readonly buffers = new Map<string, AppLogEntry[]>();
  private readonly limit = 1000;
  private readonly listeners = new Map<string, Set<(entry: AppLogEntry) => void>>();

  append(appId: string, level: AppLogEntry['level'], message: string): void {
    const entry: AppLogEntry = { ts: Date.now(), level, message };
    let buf = this.buffers.get(appId);
    if (!buf) {
      buf = [];
      this.buffers.set(appId, buf);
    }
    buf.push(entry);
    if (buf.length > this.limit) buf.splice(0, buf.length - this.limit);
    for (const fn of this.listeners.get(appId) ?? []) fn(entry);
  }

  /** Read entries since a timestamp (0 = all buffered). */
  read(appId: string, since = 0, limit = 200): AppLogEntry[] {
    const buf = this.buffers.get(appId) ?? [];
    return buf.filter(e => e.ts > since).slice(-limit);
  }

  /** Subscribe to new entries (SSE). Returns unsubscribe function. */
  subscribe(appId: string, fn: (entry: AppLogEntry) => void): () => void {
    let set = this.listeners.get(appId);
    if (!set) {
      set = new Set();
      this.listeners.set(appId, set);
    }
    set.add(fn);
    return () => set!.delete(fn);
  }

  removeApp(appId: string): void {
    this.buffers.delete(appId);
    this.listeners.delete(appId);
  }
}
