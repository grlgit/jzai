import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

/**
 * Wave 2: Redis cache service with graceful degradation.
 * Falls back to no-op when Redis is unavailable.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private redis: Redis | null = null;
  private available = false;

  constructor() {
    const host = process.env.REDIS_HOST || 'localhost';
    const port = Number(process.env.REDIS_PORT) || 6379;

    try {
      this.redis = new Redis({
        host,
        port,
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => Math.min(times * 200, 5000),
        lazyConnect: true,
      });

      this.redis.on('connect', () => {
        this.available = true;
        this.logger.log(`Redis connected (${host}:${port})`);
      });
      this.redis.on('error', (err) => {
        if (this.available) {
          this.logger.warn(`Redis error: ${err.message}`);
        }
        this.available = false;
      });
      this.redis.on('close', () => {
        this.available = false;
      });

      this.redis.connect().catch(() => {
        this.logger.warn(`Redis not available at ${host}:${port}, cache disabled`);
      });
    } catch {
      this.logger.warn('Redis initialization failed, cache disabled');
    }
  }

  get isAvailable(): boolean {
    return this.available;
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.available || !this.redis) return null;
    try {
      const val = await this.redis.get(key);
      return val ? JSON.parse(val) : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds = 300): Promise<void> {
    if (!this.available || !this.redis) return;
    try {
      await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch { /* non-critical */ }
  }

  async del(key: string): Promise<void> {
    if (!this.available || !this.redis) return;
    try {
      await this.redis.del(key);
    } catch { /* non-critical */ }
  }

  async onModuleDestroy() {
    if (this.redis) {
      await this.redis.quit().catch(() => {});
    }
  }
}
