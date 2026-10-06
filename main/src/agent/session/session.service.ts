import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import { SpacesService } from '../../knowledge/spaces.service';
import { ChunkRepository } from '../../knowledge/shared/repository';
import { chunkText } from '../../knowledge/shared/chunker';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export interface Session {
  id: string;
  userId: string;
  agentType: string;
  title: string | null;
  skillName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  metadata: any;
  createdAt: Date;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger(SessionService.name);

  constructor(
    private readonly db: DbService,
    private readonly modelRouter: ModelRouterService,
    private readonly workspace: WorkspaceService,
    private readonly spaces: SpacesService,
  ) {}

  // ===== Session CRUD =====

  async createSession(userId: string, agentType: string = 'main'): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO jz_sessions (id, user_id, agent_type) VALUES ($1, $2, $3)',
      [id, userId, agentType],
    );
    // Prune old sessions
    await this.pruneOldSessions(userId, agentType);
    this.logger.log(`Session created: ${id} (user=${userId}, agent=${agentType})`);
    return id;
  }

  /**
   * Find the most recent session for this user+agent within the reuse window.
   * #2: window is per-agent (default 10 min). make_interval keeps the minutes value
   * a bound parameter rather than string-interpolated SQL.
   */
  async getRecentSession(userId: string, agentType: string, reuseWindowMinutes = 10): Promise<string | null> {
    const windowMin = Number.isFinite(reuseWindowMinutes) && reuseWindowMinutes > 0 ? Math.floor(reuseWindowMinutes) : 10;
    const { rows } = await this.db.query(
      `SELECT id FROM jz_sessions WHERE user_id = $1 AND agent_type = $2 AND updated_at > NOW() - make_interval(mins => $3) ORDER BY updated_at DESC LIMIT 1`,
      [userId, agentType, windowMin],
    );
    return rows[0]?.id || null;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const { rows } = await this.db.query(
      'SELECT id, user_id as "userId", agent_type as "agentType", title, skill_name as "skillName", created_at as "createdAt", updated_at as "updatedAt" FROM jz_sessions WHERE id = $1',
      [sessionId],
    );
    return rows[0] || null;
  }

  async listSessions(userId: string, agentType: string = 'main', limit: number = 20, offset: number = 0): Promise<Session[]> {
    const { rows } = await this.db.query(
      'SELECT id, user_id as "userId", agent_type as "agentType", title, skill_name as "skillName", created_at as "createdAt", updated_at as "updatedAt" FROM jz_sessions WHERE user_id = $1 AND agent_type = $2 ORDER BY updated_at DESC LIMIT $3 OFFSET $4',
      [userId, agentType, limit, offset],
    );
    return rows;
  }

  async countSessions(userId: string, agentType: string = 'main'): Promise<number> {
    const { rows } = await this.db.query(
      'SELECT COUNT(*) FROM jz_sessions WHERE user_id = $1 AND agent_type = $2',
      [userId, agentType],
    );
    return parseInt(rows[0].count, 10);
  }

  async bindSkill(sessionId: string, skillName: string) {
    await this.db.query('UPDATE jz_sessions SET skill_name = $1 WHERE id = $2', [skillName, sessionId]);
  }

  async getSessionBySkill(skillName: string): Promise<Session | null> {
    // First try exact skill_name match
    const { rows } = await this.db.query(
      'SELECT id, user_id as "userId", agent_type as "agentType", title, skill_name as "skillName", created_at as "createdAt", updated_at as "updatedAt" FROM jz_sessions WHERE skill_name = $1 ORDER BY updated_at DESC LIMIT 1',
      [skillName],
    );
    if (rows[0]) return rows[0];

    // Fallback: find session whose messages mention this skill (e.g. during build)
    const { rows: msgRows } = await this.db.query(
      `SELECT DISTINCT s.id, s.user_id as "userId", s.agent_type as "agentType", s.title, s.skill_name as "skillName", s.created_at as "createdAt", s.updated_at as "updatedAt"
       FROM jz_sessions s JOIN jz_messages m ON m.session_id = s.id
       WHERE m.content LIKE $1 AND s.agent_type != 'main'
       ORDER BY s.updated_at DESC LIMIT 1`,
      [`%${skillName}%`],
    );
    return msgRows[0] || null;
  }

  async deleteSession(sessionId: string) {
    await this.db.transaction(async (client) => {
      await client.query('DELETE FROM jz_memories WHERE session_id = $1', [sessionId]);
      await client.query('DELETE FROM jz_messages WHERE session_id = $1', [sessionId]);
      await client.query('DELETE FROM jz_sessions WHERE id = $1', [sessionId]);
    });
  }

  async updateTitle(sessionId: string, title: string) {
    await this.db.query('UPDATE jz_sessions SET title = $1, updated_at = NOW() WHERE id = $2', [title, sessionId]);
  }

  // ===== Messages =====

  async saveMessage(sessionId: string, role: string, content: string, metadata?: any): Promise<string> {
    const id = randomUUID();
    await this.db.query(
      'INSERT INTO jz_messages (id, session_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5)',
      [id, sessionId, role, content, JSON.stringify(metadata || {})],
    );
    await this.db.query('UPDATE jz_sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
    return id;
  }

  /**
   * Save a user message and conditionally set the session title in a single transaction.
   * This avoids the extra DB round-trip previously spent on getSession + updateTitle.
   */
  async saveUserMessage(sessionId: string, content: string, titleCandidate?: string, metadata?: any): Promise<string> {
    const id = randomUUID();
    const title = titleCandidate ? titleCandidate.substring(0, 50) : null;
    await this.db.transaction(async (client) => {
      await client.query(
        'INSERT INTO jz_messages (id, session_id, role, content, metadata) VALUES ($1, $2, $3, $4, $5)',
        [id, sessionId, 'user', content, JSON.stringify(metadata || {})],
      );
      if (title) {
        await client.query(
          'UPDATE jz_sessions SET title = COALESCE(title, $1), updated_at = NOW() WHERE id = $2',
          [title, sessionId],
        );
      } else {
        await client.query('UPDATE jz_sessions SET updated_at = NOW() WHERE id = $1', [sessionId]);
      }
    });
    return id;
  }

  async getMessages(sessionId: string): Promise<SessionMessage[]> {
    const { rows } = await this.db.query(
      'SELECT id, session_id as "sessionId", role, content, metadata, created_at as "createdAt" FROM jz_messages WHERE session_id = $1 ORDER BY created_at ASC',
      [sessionId],
    );
    return rows;
  }

  // ===== Memory Compression =====

  async checkAndCompress(sessionId: string): Promise<boolean> {
    const messages = await this.getMessages(sessionId);
    if (messages.length < 6) return false; // Too few to compress

    // Check total chars — use maxContextChars from config
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    const maxChars = this.modelRouter.getMaxContextChars?.() || 200000;
    if (totalChars < maxChars * 0.5) return false; // below 50% of limit, skip

    this.logger.log(`Compressing session ${sessionId}: ${totalChars} chars > ${Math.round(maxChars * 0.5)} threshold`);

    // Take the first 70% of messages to compress
    const compressCount = Math.floor(messages.length * 0.7);
    const toCompress = messages.slice(0, compressCount);
    const toKeep = messages.slice(compressCount);

    // Build text for summarization
    const conversationText = toCompress
      .map(m => `[${m.role}]: ${m.content.substring(0, 500)}`)
      .join('\n');

    // Call LLM for summary
    const summary = await this.generateSummary(conversationText);

    // Delete compressed messages
    const idsToDelete = toCompress.map(m => m.id);
    await this.db.query(
      `DELETE FROM jz_messages WHERE id = ANY($1)`,
      [idsToDelete],
    );

    // Insert summary as system message (at the beginning)
    const summaryId = randomUUID();
    const firstKeepTime = toKeep[0]?.createdAt || new Date();
    await this.db.query(
      `INSERT INTO jz_messages (id, session_id, role, content, metadata, created_at) VALUES ($1, $2, 'system', $3, '{"type":"summary"}', $4)`,
      [summaryId, sessionId, `[对话摘要]\n${summary}`, new Date(new Date(firstKeepTime).getTime() - 1000)],
    );

    // Record in memories table
    await this.db.query(
      'INSERT INTO jz_memories (id, session_id, summary, original_count) VALUES ($1, $2, $3, $4)',
      [randomUUID(), sessionId, summary, compressCount],
    );

    this.logger.log(`Compressed ${compressCount} messages into summary for session ${sessionId}`);
    return true;
  }

  private async generateSummary(conversationText: string): Promise<string> {
    const model = this.modelRouter.resolveModel();
    const apiKey = this.modelRouter.getLlmAuthToken(model.provider);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    try {
      const resp = await fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: model.id,
          messages: [
            { role: 'system', content: '你是一个对话摘要助手。请将以下对话历史压缩为简明摘要，保留关键信息、决策和重要数据。摘要应该足够让人理解之前讨论了什么。用中文输出，不超过500字。' },
            { role: 'user', content: conversationText.substring(0, 6000) },
          ],
          temperature: 0.3,
          max_tokens: 1024,
        }),
      });
      const data = await resp.json() as any;
      return data.choices?.[0]?.message?.content || '(摘要生成失败)';
    } catch (err: any) {
      this.logger.error(`Summary generation failed: ${err.message}`);
      return `(摘要生成失败: ${err.message})`;
    }
  }

  // ===== Agent Stats =====

  async getAgentStats(): Promise<Record<string, { sessions: number; messages: number }>> {
    const { rows } = await this.db.query(`
      SELECT s.agent_type, COUNT(DISTINCT s.id) as sessions, COUNT(m.id) as messages
      FROM jz_sessions s LEFT JOIN jz_messages m ON m.session_id = s.id
      GROUP BY s.agent_type
    `);
    const result: Record<string, { sessions: number; messages: number }> = {};
    for (const r of rows) {
      result[r.agent_type] = { sessions: parseInt(r.sessions), messages: parseInt(r.messages) };
    }
    return result;
  }

  // ===== Session Pruning =====

  async pruneOldSessions(userId: string, agentType: string, maxKeep?: number) {
    const max = maxKeep || await this.getMaxSessions(userId);
    const { rows } = await this.db.query(
      'SELECT id FROM jz_sessions WHERE user_id = $1 AND agent_type = $2 ORDER BY updated_at DESC OFFSET $3',
      [userId, agentType, max],
    );
    for (const row of rows) {
      await this.deleteSession(row.id);
    }
    if (rows.length > 0) {
      this.logger.log(`Pruned ${rows.length} old sessions for user=${userId}, agent=${agentType}`);
    }
  }

  // ===== User Settings =====

  async getMaxSessions(userId: string): Promise<number> {
    const fs = await import('fs');
    const settingsPath = this.workspace.getUserFilePath(userId, 'settings.json');
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      return settings.maxSessions || 10;
    } catch {
      return 10;
    }
  }

  async setMaxSessions(userId: string, max: number) {
    const fs = await import('fs');
    const settingsPath = this.workspace.getUserFilePath(userId, 'settings.json');
    let settings: any = {};
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')); } catch {}
    settings.maxSessions = max;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
  }

  // ===== Auto-extract personal knowledge from session =====

  async extractKnowledge(sessionId: string): Promise<void> {
    try {
      // Get session and messages
      const { rows: sessions } = await this.db.query(
        'SELECT id, user_id as "userId" FROM jz_sessions WHERE id = $1', [sessionId],
      );
      if (!sessions[0]) return;
      const userId = sessions[0].userId;

      const messages = await this.getMessages(sessionId);
      if (messages.length < 4) return; // Too short to extract meaningful knowledge

      // Build conversation text (last 20 messages max)
      const recent = messages.slice(-20);
      const conversationText = recent
        .map(m => `${m.role === 'user' ? '用户' : 'AI'}: ${m.content.substring(0, 500)}`)
        .join('\n\n');

      if (conversationText.length < 200) return; // Too little content

      // Call LLM to extract knowledge points
      const model = this.modelRouter.resolveModelForLevel('summary');
      const apiKey = this.modelRouter.getLlmAuthToken(model.provider) || '';

      const resp = await fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model.id,
          messages: [{
            role: 'user',
            content: `从以下对话中提取有价值的知识点（事实、结论、决策、经验教训）。
如果没有值得提取的知识，只回复"无"。
如果有，用Markdown格式输出，每个知识点一个段落，不要包含对话过程本身。

---
${conversationText}`,
          }],
          max_tokens: 1024,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) return;
      const data = await resp.json();
      const extracted = data.choices?.[0]?.message?.content?.trim();

      if (!extracted || extracted === '无' || extracted.length < 30) return;

      // Save as personal knowledge（写入个人空间 raw/）
      const space = await this.spaces.ensurePersonalSpace(userId);

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const title = `会话笔记 ${timestamp.slice(0, 10)}`;
      const filename = `${timestamp}.md`;
      const dirPath = '/raw/';
      const content = `---\ntitle: ${title}\ntags:\n  - auto-extracted\n  - personal\n---\n\n${extracted}`;

      const relative = `raw/${filename}`;
      const filePath = path.join(this.spaces.rootFor(space.slug), relative);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');

      const docId = randomUUID();
      await this.db.query(
        'INSERT INTO jz_kb_documents ' +
          '(id, owner_user_id, filename, title, path, relative_path, source_kind, ' +
          "file_type, status, content, tags, version, space_id) " +
          "VALUES ($1, $2, $3, $4, $5, $6, 'source', 'md', 'ready', $7, $8, 0, $9)",
        [docId, userId, filename, title, dirPath, relative, content, ['auto-extracted', 'personal'], space.id],
      );
      await new ChunkRepository(this.db).storeChunks(docId, chunkText(content));

      this.logger.log(`Extracted knowledge from session ${sessionId.slice(0, 8)} for user ${userId}`);
    } catch (err: any) {
      this.logger.debug(`Knowledge extraction failed for session ${sessionId.slice(0, 8)}: ${err.message}`);
    }
  }
}
