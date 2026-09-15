import { Injectable, Logger } from '@nestjs/common';
import { Pool as PgPool } from 'pg';

/**
 * Manages per-app PostgreSQL connection pools.
 * Each installed app gets an isolated pg.Pool using its dedicated role.
 */
@Injectable()
export class AppPoolService {
  private readonly logger = new Logger(AppPoolService.name);
  private readonly pools = new Map<string, PgPool>();

  /** Create or replace the connection pool for an app */
  async createPool(appId: string, opts: {
    host: string;
    port: number;
    database: string;
    user: string;    // app role name
    password: string;
    max: number;
  }): Promise<void> {
    await this.destroyPool(appId);

    const pool = new PgPool({
      host: opts.host,
      port: opts.port,
      database: opts.database,
      user: opts.user,
      password: opts.password,
      max: opts.max,
    });

    this.pools.set(appId, pool);
    this.logger.log(`Created pool for app ${appId} (max=${opts.max}, user=${opts.user})`);
  }

  /** Get the pool for an app, or throw if not found */
  getPool(appId: string): PgPool {
    const pool = this.pools.get(appId);
    if (!pool) throw new Error(`No connection pool for app ${appId}`);
    return pool;
  }

  /** Check if a pool exists for the app */
  hasPool(appId: string): boolean {
    return this.pools.has(appId);
  }

  /** Run a function in a transaction on the app's pool */
  async transaction<T>(appId: string, fn: (client: any) => Promise<T>): Promise<T> {
    const pool = this.getPool(appId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Gracefully drain and remove the pool for an app */
  async destroyPool(appId: string): Promise<void> {
    const existing = this.pools.get(appId);
    if (existing) {
      await existing.end().catch(err =>
        this.logger.warn(`Error draining pool for app ${appId}: ${err.message}`),
      );
      this.pools.delete(appId);
      this.logger.log(`Destroyed pool for app ${appId}`);
    }
  }

  /** Drain all pools (called on module destroy) */
  async destroyAll(): Promise<void> {
    for (const [appId] of this.pools) {
      await this.destroyPool(appId);
    }
  }
}
