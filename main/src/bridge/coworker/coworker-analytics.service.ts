import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';

export interface CoWorkerStats {
  coworkerId: string;
  coworkerName: string;
  totalMessages: number;
  inboundMessages: number;
  outboundMessages: number;
  totalEvents: number;
  toolCalls: number;
  llmUsage: { tokens: number; cost: number };
  assignmentCount: number;
  onlineCount: number;
  lastActive: string | null;
}

export interface CoWorkerDashboard {
  summary: {
    totalCoWorkers: number;
    publishedCoWorkers: number;
    totalAssignments: number;
    activeAssignments: number;
    totalMessages: number;
    totalTokens: number;
    totalCost: number;
  };
  coworkers: CoWorkerStats[];
  topTools: Array<{ tool: string; count: number }>;
  dailyMessages: Array<{ date: string; count: number }>;
}

@Injectable()
export class CoWorkerAnalyticsService {
  private readonly logger = new Logger(CoWorkerAnalyticsService.name);

  constructor(private readonly db: DbService) {}

  /**
   * Get full analytics dashboard for all CoWorkers.
   */
  async getDashboard(days: number = 30): Promise<CoWorkerDashboard> {
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Summary
    const [cwCount, pubCount, assignCount, activeCount, msgCount, tokenStats] = await Promise.all([
      this.countQuery('SELECT COUNT(*) FROM jz_coworkers'),
      this.countQuery("SELECT COUNT(*) FROM jz_coworkers WHERE status = 'published'"),
      this.countQuery('SELECT COUNT(*) FROM jz_coworker_assignments'),
      this.countQuery("SELECT COUNT(*) FROM jz_coworker_assignments WHERE last_seen > NOW() - INTERVAL '90 seconds'"),
      this.countQuery('SELECT COUNT(*) FROM jz_coworker_messages WHERE created_at > $1', [since]),
      this.getTokenStats(since),
    ]);

    // Per-CoWorker stats
    const coworkers = await this.getPerCoWorkerStats(since);

    // Top tools
    const topTools = await this.getTopTools(since);

    // Daily message volume
    const dailyMessages = await this.getDailyMessages(days);

    return {
      summary: {
        totalCoWorkers: cwCount,
        publishedCoWorkers: pubCount,
        totalAssignments: assignCount,
        activeAssignments: activeCount,
        totalMessages: msgCount,
        totalTokens: tokenStats.tokens,
        totalCost: tokenStats.cost,
      },
      coworkers,
      topTools,
      dailyMessages,
    };
  }

  /**
   * Get stats for a single CoWorker.
   */
  async getCoWorkerStats(coworkerId: string, days: number = 30): Promise<CoWorkerStats | null> {
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const { rows } = await this.db.query(
      `SELECT c.id, c.name,
              (SELECT COUNT(*) FROM jz_coworker_messages m
               JOIN jz_coworker_assignments a ON a.id = m.assignment_id
               WHERE a.coworker_id = c.id AND m.created_at > $2) as total_messages,
              (SELECT COUNT(*) FROM jz_coworker_messages m
               JOIN jz_coworker_assignments a ON a.id = m.assignment_id
               WHERE a.coworker_id = c.id AND m.direction = 'in' AND m.created_at > $2) as inbound,
              (SELECT COUNT(*) FROM jz_coworker_messages m
               JOIN jz_coworker_assignments a ON a.id = m.assignment_id
               WHERE a.coworker_id = c.id AND m.direction = 'out' AND m.created_at > $2) as outbound,
              (SELECT COUNT(*) FROM jz_coworker_events e
               JOIN jz_coworker_assignments a ON a.id = e.assignment_id
               WHERE a.coworker_id = c.id AND e.created_at > $2) as total_events,
              (SELECT COUNT(*) FROM jz_coworker_events e
               JOIN jz_coworker_assignments a ON a.id = e.assignment_id
               WHERE a.coworker_id = c.id AND e.event_type = 'tool_call' AND e.created_at > $2) as tool_calls,
              (SELECT COUNT(*) FROM jz_coworker_assignments WHERE coworker_id = c.id) as assignments,
              (SELECT COUNT(*) FROM jz_coworker_assignments WHERE coworker_id = c.id AND last_seen > NOW() - INTERVAL '90 seconds') as online,
              (SELECT MAX(last_seen) FROM jz_coworker_assignments WHERE coworker_id = c.id) as last_active
       FROM jz_coworkers c WHERE c.id = $1`,
      [coworkerId, since],
    );

    if (!rows[0]) return null;
    const r = rows[0];
    const llm = await this.getLLMUsage(coworkerId, since);

    return {
      coworkerId: r.id,
      coworkerName: r.name,
      totalMessages: parseInt(r.total_messages),
      inboundMessages: parseInt(r.inbound),
      outboundMessages: parseInt(r.outbound),
      totalEvents: parseInt(r.total_events),
      toolCalls: parseInt(r.tool_calls),
      llmUsage: llm,
      assignmentCount: parseInt(r.assignments),
      onlineCount: parseInt(r.online),
      lastActive: r.last_active,
    };
  }

  /**
   * Get message history for a CoWorker (admin view).
   */
  async getMessages(coworkerId: string, limit: number = 50, offset: number = 0) {
    const { rows } = await this.db.query(
      `SELECT m.*, a.user_id, u.name as user_name
       FROM jz_coworker_messages m
       JOIN jz_coworker_assignments a ON a.id = m.assignment_id
       JOIN jz_users u ON u.id = a.user_id
       WHERE a.coworker_id = $1
       ORDER BY m.created_at DESC
       LIMIT $2 OFFSET $3`,
      [coworkerId, limit, offset],
    );
    return rows;
  }

  // ===== Private helpers =====

  private async countQuery(sql: string, params: any[] = []): Promise<number> {
    const { rows } = await this.db.query(sql, params);
    return parseInt(rows[0]?.count || '0');
  }

  private async getTokenStats(since: string): Promise<{ tokens: number; cost: number }> {
    const { rows } = await this.db.query(
      `SELECT
         COALESCE(SUM((payload->>'tokens')::int), 0) as tokens,
         COALESCE(SUM((payload->>'cost')::float), 0) as cost
       FROM jz_coworker_events
       WHERE event_type = 'llm_usage' AND created_at > $1`,
      [since],
    );
    return { tokens: parseInt(rows[0]?.tokens || '0'), cost: parseFloat(rows[0]?.cost || '0') };
  }

  private async getLLMUsage(coworkerId: string, since: string): Promise<{ tokens: number; cost: number }> {
    const { rows } = await this.db.query(
      `SELECT
         COALESCE(SUM((e.payload->>'tokens')::int), 0) as tokens,
         COALESCE(SUM((e.payload->>'cost')::float), 0) as cost
       FROM jz_coworker_events e
       JOIN jz_coworker_assignments a ON a.id = e.assignment_id
       WHERE a.coworker_id = $1 AND e.event_type = 'llm_usage' AND e.created_at > $2`,
      [coworkerId, since],
    );
    return { tokens: parseInt(rows[0]?.tokens || '0'), cost: parseFloat(rows[0]?.cost || '0') };
  }

  private async getPerCoWorkerStats(since: string): Promise<CoWorkerStats[]> {
    const { rows } = await this.db.query('SELECT id FROM jz_coworkers ORDER BY updated_at DESC');
    const stats: CoWorkerStats[] = [];
    for (const r of rows) {
      const s = await this.getCoWorkerStats(r.id);
      if (s) stats.push(s);
    }
    return stats;
  }

  private async getTopTools(since: string): Promise<Array<{ tool: string; count: number }>> {
    const { rows } = await this.db.query(
      `SELECT payload->>'tool' as tool, COUNT(*) as count
       FROM jz_coworker_events
       WHERE event_type = 'tool_call' AND created_at > $1
       GROUP BY payload->>'tool'
       ORDER BY count DESC
       LIMIT 10`,
      [since],
    );
    return rows.map(r => ({ tool: r.tool || 'unknown', count: parseInt(r.count) }));
  }

  private async getDailyMessages(days: number): Promise<Array<{ date: string; count: number }>> {
    const { rows } = await this.db.query(
      `SELECT DATE(created_at) as date, COUNT(*) as count
       FROM jz_coworker_messages
       WHERE created_at > NOW() - INTERVAL '${days} days'
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
    );
    return rows.map(r => ({ date: r.date?.toISOString?.()?.slice(0, 10) || String(r.date), count: parseInt(r.count) }));
  }
}
