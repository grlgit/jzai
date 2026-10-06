import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { KnowledgeToolsService } from '../../knowledge/tools/knowledge-tools.service';
import { SpacesService, ENTERPRISE_SPACE_SLUG } from '../../knowledge/spaces.service';

@Injectable()
export class AnalyticsService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsService.name);
  private userNames: Record<string, string> = {};

  constructor(
    private readonly db: DbService,
    private readonly mcpTools: KnowledgeToolsService,
    private readonly spaces: SpacesService,
  ) {}

  onModuleInit() {
    // Subscribe to KB search events for hit rate tracking
    this.mcpTools.onKbEvent((event) => {
      this.recordEvent({
        type: event.type,
        query: event.query,
        tags: event.tags,
        scope: event.scope,
        hit: event.hit,
      }).catch(() => {});
    });
    this.logger.log('KB analytics listener registered');
  }

  registerUser(userId: string, name: string) {
    this.userNames[userId] = name;
  }

  getUserName(userId: string): string | undefined {
    return this.userNames[userId];
  }

  private async resolveUserName(userId: string): Promise<string> {
    if (this.userNames[userId]) return this.userNames[userId];
    try {
      const { rows } = await this.db.query('SELECT username, name FROM jz_users WHERE id=$1', [userId]);
      if (rows[0]) {
        const name = rows[0].username || rows[0].name;
        this.userNames[userId] = name;
        return name;
      }
    } catch { /* ignore */ }
    return '未知用户';
  }

  private async resolveUserNames(userIds: string[]): Promise<void> {
    const missing = userIds.filter(id => !this.userNames[id]);
    if (missing.length === 0) return;
    try {
      const { rows } = await this.db.query(
        `SELECT id, username, name FROM jz_users WHERE id = ANY($1)`, [missing]
      );
      rows.forEach((r: any) => { this.userNames[r.id] = r.username || r.name; });
    } catch { /* ignore */ }
  }

  async recordEvent(event: Record<string, any> & { type: string }) {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
    const { type, userId, conversationId, ...rest } = event;
    await this.db.query(
      'INSERT INTO jz_events(id, type, user_id, conversation_id, payload) VALUES($1,$2,$3,$4,$5)',
      [id, type, userId || null, conversationId || null, rest],
    ).catch(err => this.logger.warn(`Event write failed: ${err.message}`));
  }

  async recordFeedback(feedback: { messageId: string; userId: string; rating: string; reason?: string }) {
    const id = Date.now().toString() + Math.random().toString(36).slice(2, 6);
    await this.db.query(
      'INSERT INTO jz_feedbacks(id, message_id, user_id, rating, reason) VALUES($1,$2,$3,$4,$5)',
      [id, feedback.messageId, feedback.userId, feedback.rating, feedback.reason || null],
    ).catch(err => this.logger.warn(`Feedback write failed: ${err.message}`));
  }

  async getDashboard() {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // Messages
    const msgRes = await this.db.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER(WHERE created_at >= $2) as week
       FROM jz_events WHERE type='conversation_message' AND created_at >= $1`, [monthStart, weekAgo]);
    const totalMessages = Number(msgRes.rows[0].total);
    const weekMessages = Number(msgRes.rows[0].week);

    // Completions
    const compRes = await this.db.query(
      `SELECT COUNT(*) as total,
              SUM((payload->>'cost')::float) as cost,
              SUM((payload->>'tokensInput')::int) as tokens_in,
              SUM((payload->>'tokensOutput')::int) as tokens_out,
              COUNT(*) FILTER(WHERE payload->>'routeType'='local') as local_count,
              COUNT(*) FILTER(WHERE payload->>'routeType'='cloud') as cloud_count
       FROM jz_events WHERE type='conversation_complete' AND created_at >= $1`, [monthStart]);
    const r = compRes.rows[0];
    const totalCost = Number(r.cost || 0);
    const totalTokensInput = Number(r.tokens_in || 0);
    const totalTokensOutput = Number(r.tokens_out || 0);
    const localCount = Number(r.local_count || 0);
    const cloudCount = Number(r.cloud_count || 0);
    const totalCompletions = localCount + cloudCount || 1;

    // Feedback
    const fbRes = await this.db.query(
      `SELECT COUNT(*) FILTER(WHERE rating='up') as up,
              COUNT(*) FILTER(WHERE rating='down') as down
       FROM jz_feedbacks WHERE created_at >= $1`, [monthStart]);
    const thumbsUp = Number(fbRes.rows[0].up);
    const thumbsDown = Number(fbRes.rows[0].down);
    const totalFeedback = thumbsUp + thumbsDown;

    const timeSavedMinutes = totalMessages * 3;

    // Daily trend
    const trendRes = await this.db.query(
      `SELECT date_trunc('day', created_at)::date as day, COUNT(*) as cnt
       FROM jz_events WHERE type='conversation_message' AND created_at >= $1
       GROUP BY day ORDER BY day`, [weekAgo]);
    const trendMap: Record<string, number> = {};
    trendRes.rows.forEach((r: any) => { trendMap[r.day.toISOString().slice(5, 10)] = Number(r.cnt); });
    const dailyTrend: { date: string; messages: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dailyTrend.push({ date: `${d.getMonth() + 1}/${d.getDate()}`, messages: trendMap[key] || 0 });
    }

    // Tool usage
    const toolRes = await this.db.query(
      `SELECT payload->>'toolName' as name, COUNT(*) as cnt
       FROM jz_events WHERE type='tool_call' AND created_at >= $1
       GROUP BY name ORDER BY cnt DESC LIMIT 5`, [monthStart]);
    const topTools = toolRes.rows.map((r: any) => ({ name: r.name, count: Number(r.cnt) }));

    // User stats
    const userRes = await this.db.query(
      `SELECT user_id, COUNT(*) as msgs,
              SUM(CASE WHEN type='conversation_complete' THEN (payload->>'cost')::float ELSE 0 END) as cost
       FROM jz_events WHERE created_at >= $1 AND user_id IS NOT NULL
       GROUP BY user_id ORDER BY msgs DESC`, [monthStart]);
    // Resolve user names from DB
    const userIds = userRes.rows.map((r: any) => r.user_id).filter(Boolean);
    await this.resolveUserNames(userIds);

    const userStats = userRes.rows.map((r: any) => ({
      userId: r.user_id,
      userName: this.userNames[r.user_id] || '未知用户',
      messages: Number(r.msgs),
      cost: Math.round(Number(r.cost || 0) * 10000) / 10000,
    }));

    // Knowledge base hit rate
    const kbRes = await this.db.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER(WHERE (payload->>'hit')::boolean = true) as hits
       FROM jz_events WHERE type='kb_search' AND created_at >= $1`, [monthStart]);
    const kbTotal = Number(kbRes.rows[0].total);
    const kbHits = Number(kbRes.rows[0].hits);

    // Top KB queries (missed)
    const kbMissRes = await this.db.query(
      `SELECT payload->>'query' as query, COUNT(*) as cnt
       FROM jz_events WHERE type='kb_search' AND (payload->>'hit')::boolean = false AND created_at >= $1
       GROUP BY query ORDER BY cnt DESC LIMIT 5`, [monthStart]);
    const topMissedQueries = kbMissRes.rows.map((r: any) => ({ query: r.query, count: Number(r.cnt) }));

    return {
      overview: {
        totalMessages, weekMessages,
        timeSavedHours: Math.round(timeSavedMinutes / 60 * 10) / 10,
        totalCost: Math.round(totalCost * 10000) / 10000,
        satisfactionRate: totalFeedback > 0 ? Math.round((thumbsUp / totalFeedback) * 100) : 0,
        feedbackCount: totalFeedback,
        localCount, cloudCount,
        localRate: Math.round((localCount / totalCompletions) * 100),
        totalTokens: totalTokensInput + totalTokensOutput,
        totalTokensInput, totalTokensOutput,
      },
      dailyTrend, topTools, userStats,
      knowledge: {
        totalSearches: kbTotal,
        hits: kbHits,
        hitRate: kbTotal > 0 ? Math.round((kbHits / kbTotal) * 100) : 0,
        topMissedQueries,
      },
      knowledgeHealth: await this.getKnowledgeHealth(),
      roi: {
        cost: Math.round(totalCost * 100) / 100,
        savedHours: Math.round(timeSavedMinutes / 60 * 10) / 10,
        ratio: totalCost > 0 ? Math.round((timeSavedMinutes / 60 * 50) / totalCost) : 0,
      },
    };
  }

  /**
   * P2-17 使用效能看板 — 面向管理员的「CoWorker 是否在创造价值」视角。
   * 仅基于真实可测的事件数据：采纳率、可靠性（无故障率/满意度）、常见失败、Agent 分布、知识库覆盖。
   */
  async getEfficiencyDashboard() {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    // ── 采纳率：本周活跃用户 / 总用户 ──
    const wauRes = await this.db.query(
      `SELECT COUNT(DISTINCT user_id) as cnt FROM jz_events
       WHERE type='conversation_message' AND user_id IS NOT NULL AND created_at >= $1`, [weekAgo]);
    const weeklyActiveUsers = Number(wauRes.rows[0].cnt || 0);
    const totalUsersRes = await this.db.query(`SELECT COUNT(*) as cnt FROM jz_users`).catch(() => ({ rows: [{ cnt: 0 }] }));
    const totalUsers = Number(totalUsersRes.rows[0].cnt || 0);
    const adoptionRate = totalUsers > 0 ? Math.round((weeklyActiveUsers / totalUsers) * 100) : 0;

    // ── 可靠性：无故障会话率（无 tool_error 的会话）+ 满意度 ──
    const convRes = await this.db.query(
      `SELECT COUNT(DISTINCT conversation_id) as total FROM jz_events
       WHERE type='conversation_message' AND conversation_id IS NOT NULL AND created_at >= $1`, [monthStart]);
    const totalConversations = Number(convRes.rows[0].total || 0);
    const failedConvRes = await this.db.query(
      `SELECT COUNT(DISTINCT conversation_id) as cnt FROM jz_events
       WHERE type='tool_error' AND conversation_id IS NOT NULL AND created_at >= $1`, [monthStart]);
    const conversationsWithFailure = Number(failedConvRes.rows[0].cnt || 0);
    const cleanConversations = Math.max(0, totalConversations - conversationsWithFailure);
    const cleanRate = totalConversations > 0 ? Math.round((cleanConversations / totalConversations) * 100) : 0;

    const fbRes = await this.db.query(
      `SELECT COUNT(*) FILTER(WHERE rating='up') as up, COUNT(*) FILTER(WHERE rating='down') as down
       FROM jz_feedbacks WHERE created_at >= $1`, [monthStart]);
    const thumbsUp = Number(fbRes.rows[0].up || 0);
    const thumbsDown = Number(fbRes.rows[0].down || 0);
    const feedbackCount = thumbsUp + thumbsDown;
    const satisfactionRate = feedbackCount > 0 ? Math.round((thumbsUp / feedbackCount) * 100) : 0;

    // ── 常见失败工具（依赖 P0-5 的 errorCode）──
    const failRes = await this.db.query(
      `SELECT payload->>'toolName' as name, COUNT(*) as cnt,
              (array_agg(payload->>'errorCode' ORDER BY created_at DESC))[1] as last_code,
              (array_agg(payload->>'errorMessage' ORDER BY created_at DESC))[1] as last_msg
       FROM jz_events WHERE type='tool_error' AND created_at >= $1
       GROUP BY name ORDER BY cnt DESC LIMIT 8`, [monthStart]);
    const topFailedTools = failRes.rows.map((r: any) => ({
      toolName: r.name, failCount: Number(r.cnt),
      lastErrorCode: r.last_code || 'UNKNOWN', lastErrorMessage: r.last_msg || '',
    }));

    // ── Agent 使用分布（依赖 gateway 写入 agentId）──
    const agentRes = await this.db.query(
      `SELECT payload->>'agentId' as agent_id,
              COUNT(*) FILTER(WHERE type='conversation_message') as msgs,
              AVG(CASE WHEN type='conversation_complete' THEN (payload->>'durationMs')::float END) as avg_ms
       FROM jz_events WHERE created_at >= $1 AND payload->>'agentId' IS NOT NULL
       GROUP BY agent_id ORDER BY msgs DESC`, [monthStart]);
    const agentUsageBreakdown = agentRes.rows
      .filter((r: any) => Number(r.msgs) > 0)
      .map((r: any) => ({
        agentId: r.agent_id,
        messageCount: Number(r.msgs),
        avgResponseTimeSec: r.avg_ms ? Math.round((Number(r.avg_ms) / 1000) * 10) / 10 : 0,
      }));

    // ── 知识库覆盖（复用 kb_search 事件）──
    const kbRes = await this.db.query(
      `SELECT COUNT(*) as total, COUNT(*) FILTER(WHERE (payload->>'hit')::boolean = true) as hits
       FROM jz_events WHERE type='kb_search' AND created_at >= $1`, [monthStart]);
    const kbTotal = Number(kbRes.rows[0].total || 0);
    const kbHits = Number(kbRes.rows[0].hits || 0);
    const kbMissRes = await this.db.query(
      `SELECT payload->>'query' as query, COUNT(*) as cnt
       FROM jz_events WHERE type='kb_search' AND (payload->>'hit')::boolean = false AND created_at >= $1
       GROUP BY query ORDER BY cnt DESC LIMIT 5`, [monthStart]);

    return {
      adoption: { weeklyActiveUsers, totalUsers, adoptionRate },
      reliability: {
        totalConversations, cleanConversations, cleanRate,
        satisfactionRate, feedbackCount,
      },
      topFailedTools,
      agentUsageBreakdown,
      knowledge: {
        hitRate: kbTotal > 0 ? Math.round((kbHits / kbTotal) * 100) : 0,
        coverage: kbTotal > 0 ? Math.round((kbHits / kbTotal) * 100) : 0,
        totalSearches: kbTotal,
        topMissedQueries: kbMissRes.rows.map((r: any) => ({ query: r.query, count: Number(r.cnt) })),
      },
    };
  }

  async getUserDetail(userId: string) {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();

    const compRes = await this.db.query(
      `SELECT COUNT(*) FILTER(WHERE type='conversation_message') as msgs,
              SUM(CASE WHEN type='conversation_complete' THEN (payload->>'cost')::float ELSE 0 END) as cost,
              SUM(CASE WHEN type='conversation_complete' THEN (payload->>'tokensInput')::int ELSE 0 END) as t_in,
              SUM(CASE WHEN type='conversation_complete' THEN (payload->>'tokensOutput')::int ELSE 0 END) as t_out,
              COUNT(*) FILTER(WHERE type='conversation_complete' AND payload->>'routeType'='local') as local_c,
              COUNT(*) FILTER(WHERE type='conversation_complete' AND payload->>'routeType'='cloud') as cloud_c
       FROM jz_events WHERE user_id=$1 AND created_at >= $2`, [userId, monthStart]);
    const r = compRes.rows[0];

    const fbRes = await this.db.query(
      `SELECT COUNT(*) FILTER(WHERE rating='up') as up, COUNT(*) FILTER(WHERE rating='down') as down
       FROM jz_feedbacks WHERE user_id=$1 AND created_at >= $2`, [userId, monthStart]);

    const toolRes = await this.db.query(
      `SELECT payload->>'toolName' as name, COUNT(*) as cnt
       FROM jz_events WHERE type='tool_call' AND user_id=$1 AND created_at >= $2
       GROUP BY name ORDER BY cnt DESC`, [userId, monthStart]);

    const trendRes = await this.db.query(
      `SELECT date_trunc('day', created_at)::date as day, COUNT(*) as cnt
       FROM jz_events WHERE type='conversation_message' AND user_id=$1 AND created_at >= $2
       GROUP BY day ORDER BY day`, [userId, weekAgo]);
    const trendMap: Record<string, number> = {};
    trendRes.rows.forEach((row: any) => { trendMap[row.day.toISOString().slice(5, 10)] = Number(row.cnt); });
    const dailyTrend: { date: string; messages: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000);
      const key = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      dailyTrend.push({ date: `${d.getMonth() + 1}/${d.getDate()}`, messages: trendMap[key] || 0 });
    }

    return {
      userId,
      userName: await this.resolveUserName(userId),
      messages: Number(r.msgs),
      cost: Math.round(Number(r.cost || 0) * 10000) / 10000,
      tokensInput: Number(r.t_in || 0),
      tokensOutput: Number(r.t_out || 0),
      tokensTotal: Number(r.t_in || 0) + Number(r.t_out || 0),
      localCount: Number(r.local_c || 0),
      cloudCount: Number(r.cloud_c || 0),
      thumbsUp: Number(fbRes.rows[0].up),
      thumbsDown: Number(fbRes.rows[0].down),
      tools: toolRes.rows.map((t: any) => ({ name: t.name, count: Number(t.cnt) })),
      dailyTrend,
    };
  }
  async getKnowledgeHealth(): Promise<Record<string, any>> {
    // 知识库已并入主台：直接查询 DB（企业空间）
    try {
      const space = await this.spaces.resolve(ENTERPRISE_SPACE_SLUG);
      if (!space) return { connected: true, status: 'empty', documents: 0 };

      const { rows: docs } = await this.db.query(
        'SELECT status, path, content FROM jz_kb_documents WHERE space_id = $1',
        [space.id],
      );

      const byStatus: Record<string, number> = {};
      for (const d of docs) {
        byStatus[d.status] = (byStatus[d.status] || 0) + 1;
      }

      // Check prompt layer sizes
      const characterDocs = docs.filter((d: any) => d.path?.includes('_character'));
      const rulesDocs = docs.filter((d: any) => d.path?.includes('_rules'));
      const characterTokens = characterDocs.reduce((sum: number, d: any) => sum + Math.ceil((d.content?.length || 0) / 4), 0);
      const rulesTokens = rulesDocs.reduce((sum: number, d: any) => sum + Math.ceil((d.content?.length || 0) / 4), 0);

      return {
        connected: true,
        status: 'healthy',
        documents: docs.length,
        byStatus,
        failedCount: byStatus['failed'] || 0,
        promptLayers: {
          characterDocs: characterDocs.length,
          characterTokens,
          rulesDocs: rulesDocs.length,
          rulesTokens,
          totalPromptTokens: characterTokens + rulesTokens,
          limit: 5000,
        },
      };
    } catch (err: any) {
      return { connected: true, status: 'error', detail: err.message };
    }
  }
}

export interface AnalyticsEvent {
  id: string; type: string; timestamp: Date; [key: string]: any;
}

export interface Feedback {
  id: string; messageId: string; userId: string; rating: 'up' | 'down'; reason?: string; timestamp: Date;
}
