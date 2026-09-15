import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool, PoolClient } from 'pg';
import { loadMigrations } from './migrations';

@Injectable()
export class DbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DbService.name);
  private pool: Pool;

  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      host: this.config.get('PG_HOST', 'localhost'),
      port: Number(this.config.get('PG_PORT', '5432')),
      database: this.config.get('PG_DATABASE', 'jianzhi'),
      user: this.config.get('PG_USER', 'postgres'),
      password: this.config.get('PG_PASSWORD', 'postgres'),
      max: 10,
      ssl: this.config.get('PG_SSL') === 'true'
        ? { rejectUnauthorized: this.config.get('PG_SSL_REJECT_UNAUTHORIZED') !== 'false' }
        : undefined,
    });
  }

  async onModuleInit() {
    // Migrations already ran in initDatabase() before NestJS started.
    // Just verify connection.
    await this.pool.query('SELECT 1');
    this.logger.log('PostgreSQL connected');
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async query(text: string, params?: any[]) {
    return this.pool.query(text, params);
  }

  /** Run a set of queries inside a single transaction */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
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

  private async runMigrations() {
    // Ensure migration tracking table exists
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS jz_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Get already-applied versions
    const { rows } = await this.pool.query('SELECT version FROM jz_migrations ORDER BY version');
    const applied = new Set(rows.map(r => r.version));

    const migrations = loadMigrations();
    let count = 0;

    for (const m of migrations) {
      if (applied.has(m.version)) continue;

      this.logger.log(`Applying migration ${m.name}...`);
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO jz_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
        await client.query('COMMIT');
        count++;
        this.logger.log(`Migration ${m.name} applied`);
      } catch (err: any) {
        await client.query('ROLLBACK');
        this.logger.error(`Migration ${m.name} failed: ${err.message}`);
        throw err;
      } finally {
        client.release();
      }
    }

    if (count > 0) {
      this.logger.log(`${count} migration(s) applied`);
    } else {
      this.logger.log('Database schema up to date');
    }
  }
}
