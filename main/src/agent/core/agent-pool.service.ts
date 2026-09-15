import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

const MAX_AGENTS = 100;
const TTL_MS = 30 * 60 * 1000; // 30 minutes

@Injectable()
export class AgentPoolService implements OnModuleDestroy {
  private readonly logger = new Logger(AgentPoolService.name);
  private agents = new Map<string, any>();
  private agentSessions = new Map<string, string>();
  private lastActivity = new Map<string, number>();
  private cleanupTimer: ReturnType<typeof setInterval>;
  private expireListeners: Array<(sessionId: string, userId: string) => void> = [];

  /** Register callback for session expiry (used for knowledge extraction) */
  onExpire(fn: (sessionId: string, userId: string) => void) {
    this.expireListeners.push(fn);
  }

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  onModuleDestroy() {
    clearInterval(this.cleanupTimer);
  }

  get(key: string): any | undefined {
    const agent = this.agents.get(key);
    if (agent) this.lastActivity.set(key, Date.now());
    return agent;
  }

  has(key: string): boolean {
    return this.agents.has(key);
  }

  set(key: string, agent: any, sessionId: string) {
    // LRU eviction if at capacity
    if (this.agents.size >= MAX_AGENTS && !this.agents.has(key)) {
      this.evictOldest();
    }
    this.agents.set(key, agent);
    this.agentSessions.set(key, sessionId);
    this.lastActivity.set(key, Date.now());
    this.logger.log(`Agent pooled: ${key} (total: ${this.agents.size})`);
  }

  remove(key: string) {
    this.agents.delete(key);
    this.agentSessions.delete(key);
    this.lastActivity.delete(key);
  }

  getSessionId(key: string): string | undefined {
    return this.agentSessions.get(key);
  }

  /** Clear all agents (e.g. on model config change) */
  clear() {
    const count = this.agents.size;
    this.agents.clear();
    this.agentSessions.clear();
    this.lastActivity.clear();
    if (count > 0) this.logger.log(`Cleared ${count} agents`);
  }

  /** Clear all agents except the specified key (preserve current session) */
  clearExcept(keepKey: string) {
    let removed = 0;
    for (const key of [...this.agents.keys()]) {
      if (key !== keepKey) { this.remove(key); removed++; }
    }
    if (removed > 0) this.logger.log(`Cleared ${removed} agents (kept: ${keepKey})`);
  }

  /** Iterate all agent session keys */
  keys(): IterableIterator<string> {
    return this.agentSessions.keys();
  }

  private cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [key, ts] of this.lastActivity) {
      if (now - ts > TTL_MS) {
        const sessionId = this.agentSessions.get(key);
        // Extract userId from key format: "{agentId}_{sessionId}"
        // The agent may store userId — pass sessionId for knowledge extraction
        if (sessionId) {
          for (const fn of this.expireListeners) {
            try { fn(sessionId, key); } catch { /* ignore */ }
          }
        }
        this.remove(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.log(`Cleaned up ${removed} idle agents (remaining: ${this.agents.size})`);
    }
  }

  private evictOldest() {
    let oldestKey: string | null = null;
    let oldestTs = Infinity;
    for (const [key, ts] of this.lastActivity) {
      if (ts < oldestTs) { oldestTs = ts; oldestKey = key; }
    }
    if (oldestKey) {
      this.remove(oldestKey);
      this.logger.log(`Evicted oldest agent: ${oldestKey}`);
    }
  }
}
