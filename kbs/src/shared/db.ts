/**
 * pg 连接池封装（裸 SQL，风格对齐 main/src/db/db.service.ts）。
 */
import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export class Db {
  private readonly pool: Pool;

  constructor(connectionString: string, max = 5) {
    this.pool = new Pool({ connectionString, max });
  }

  query<T extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
