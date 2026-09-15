import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CacheService } from '../../cache/cache.service';

/**
 * CoWorker API Key authentication cache.
 * Two-level caching: in-memory LRU + Redis (if available).
 * Reduces database queries for high-frequency LLM proxy calls.
 */
@Injectable()
export class CoWorkerCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CoWorkerCacheService.name);

  // Level 1: In-memory LRU cache (process-local, fastest)
  private readonly memoryCache = new Map<string, AuthData>();
  private readonly MAX_MEMORY_CACHE_SIZE = 2000;
  private readonly MEMORY_CACHE_TTL = 3600000; // 1 hour

  // Level 2: Revocation set (fast rejection without cache lookup)
  private readonly revokedSet = new Set<string>();

  // Cache key prefix for Redis
  private readonly CACHE_PREFIX = 'coworker_auth:';

  constructor(private readonly cache: CacheService) {}

  onModuleDestroy() {
    this.memoryCache.clear();
    this.revokedSet.clear();
  }

  /**
   * Get authentication data from cache (memory → Redis → miss).
   * Returns null if not found in any cache layer.
   */
  async get(apiKey: string): Promise<AuthData | null> {
    // Fast path: check revoked first
    if (this.revokedSet.has(apiKey)) {
      this.logger.debug(`[Cache] API key revoked: ${apiKey.substring(0, 10)}...`);
      return null;
    }

    // Level 1: Memory cache (fastest, <1ms)
    const memData = this.memoryCache.get(apiKey);
    if (memData && Date.now() - (memData.cachedAt || 0) < this.MEMORY_CACHE_TTL) {
      return memData;
    }
    // Remove expired entry
    if (memData) {
      this.memoryCache.delete(apiKey);
    }

    // Level 2: Redis cache (fast, <5ms)
    if (this.cache.isAvailable) {
      try {
        const redisData = await this.cache.get<AuthData>(`${this.CACHE_PREFIX}${apiKey}`);
        if (redisData) {
          // Promote to memory cache
          this.setToMemory(apiKey, redisData);
          return redisData;
        }
      } catch (err) {
        this.logger.warn(`[Cache] Redis get failed: ${err.message}`);
      }
    }

    return null; // Cache miss
  }

  /**
   * Set authentication data in all cache layers.
   */
  async set(apiKey: string, data: AuthData): Promise<void> {
    // Set in memory cache
    this.setToMemory(apiKey, data);

    // Set in Redis cache
    if (this.cache.isAvailable) {
      try {
        await this.cache.set(`${this.CACHE_PREFIX}${apiKey}`, data, 3600); // 1 hour TTL
      } catch (err) {
        this.logger.warn(`[Cache] Redis set failed: ${err.message}`);
      }
    }
  }

  /**
   * Revoke an API key immediately (clear all caches).
   * Call when assignment is revoked or API key is rotated.
   */
  async revoke(apiKey: string): Promise<void> {
    // Add to revoked set (instant rejection)
    this.revokedSet.add(apiKey);

    // Clear memory cache
    this.memoryCache.delete(apiKey);

    // Clear Redis cache
    if (this.cache.isAvailable) {
      try {
        await this.cache.del(`${this.CACHE_PREFIX}${apiKey}`);
      } catch (err) {
        this.logger.warn(`[Cache] Redis del failed: ${err.message}`);
      }
    }

    this.logger.log(`[Cache] API key revoked: ${apiKey.substring(0, 10)}...`);
  }

  /**
   * Clean up revoked keys periodically (to prevent memory leak).
   * Call from a scheduled task.
   */
  cleanupRevokedSet(): void {
    if (this.revokedSet.size > 10000) {
      this.logger.warn(`[Cache] Revoked set too large (${this.revokedSet.size}), clearing...`);
      this.revokedSet.clear();
    }
  }

  /**
   * Get cache statistics for monitoring.
   */
  getStats(): { memorySize: number; revokedSize: number; redisAvailable: boolean } {
    return {
      memorySize: this.memoryCache.size,
      revokedSize: this.revokedSet.size,
      redisAvailable: this.cache.isAvailable,
    };
  }

  private setToMemory(apiKey: string, data: AuthData): void {
    // Evict oldest if cache is full
    if (this.memoryCache.size >= this.MAX_MEMORY_CACHE_SIZE) {
      const firstKey = this.memoryCache.keys().next().value;
      this.memoryCache.delete(firstKey);
    }

    this.memoryCache.set(apiKey, { ...data, cachedAt: Date.now() });
  }
}

/**
 * Authentication data cached for an API key.
 * Contains all necessary context for downstream use.
 */
export interface AuthData {
  assignmentId: string;
  userId: string;
  coworkerId: string;
  cachedAt?: number; // Timestamp for memory cache TTL
}
