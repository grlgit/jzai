import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { CoWorkerService, CoWorker } from './coworker.service';
import { UserService } from '../../user/user.service';
import { randomUUID, randomBytes } from 'crypto';

/**
 * 本地验证测试 CoWorker 管理服务
 *
 * 用于创建和管理功能测试用的测试 CoWorker。
 * 测试 CoWorker 会在 24 小时后自动清理。
 */
@Injectable()
export class CoWorkerVerifyService {
  private readonly logger = new Logger(CoWorkerVerifyService.name);

  // 测试 CoWorker 默认配置
  private readonly DEFAULT_CONFIG = {
    name: '本地验证测试',
    description: '用于 OpenClaw 本地验证功能的测试 CoWorker',
    soul: '你是一个测试用的 AI 助手，用于验证 OpenClaw 和 jianzhi-bridge 的集成功能。',
    modelLevel: 'default',
    tools: [
      'read', 'write', 'edit', 'exec',
      'web_search', 'web_fetch',
      'memory_search', 'memory_get',
      'message', 'image',
    ],
    skills: [],
    mcpServers: [],
    workScope: '本地测试',
  };

  constructor(
    private readonly db: DbService,
    private readonly cwService: CoWorkerService,
    private readonly userService: UserService,
  ) {}

  /**
   * 创建或复用测试 CoWorker
   *
   * 流程：
   * 1. 检查是否存在未过期的测试 CoWorker
   * 2. 如果存在且未过期，复用它并更新过期时间
   * 3. 如果不存在或已过期，创建新的测试 CoWorker
   *
   * @returns { coworkerId, userId, assignmentId, enrollToken, expiresAt }
   */
  async createTestCoWorker(): Promise<{
    coworkerId: string;
    userId: string;
    assignmentId: string;
    enrollToken: string;
    expiresAt: Date;
  }> {
    // 1. 检查是否存在未过期的测试 CoWorker
    const { rows: existing } = await this.db.query(
      `SELECT t.coworker_id, t.user_id, t.assignment_id, t.expires_at, c.status
       FROM jz_coworker_test_data t
       JOIN jz_coworkers c ON c.id = t.coworker_id
       WHERE t.expires_at > NOW()
       ORDER BY t.created_at DESC
       LIMIT 1`
    );

    if (existing.length > 0 && existing[0].status === 'published') {
      // 复用现有的测试 CoWorker
      const coworkerId = existing[0].coworker_id;
      const userId = existing[0].user_id;
      const assignmentId = existing[0].assignment_id;

      // 更新过期时间（延长 24 小时）
      const newExpiresAt = new Date();
      newExpiresAt.setHours(newExpiresAt.getHours() + 24);

      await this.db.query(
        'UPDATE jz_coworker_test_data SET expires_at = $1 WHERE coworker_id = $2',
        [newExpiresAt, coworkerId]
      );

      // 确保 enroll token 存在
      const enrollToken = await this.cwService.generateEnrollToken(assignmentId) || assignmentId;

      this.logger.log(`复用测试 CoWorker: ${coworkerId}, 新过期时间: ${newExpiresAt.toISOString()}`);

      return {
        coworkerId,
        userId,
        assignmentId,
        enrollToken,
        expiresAt: newExpiresAt,
      };
    }

    // 2. 创建新的测试 CoWorker
    return this.createNewTestCoWorker();
  }

  /**
   * 创建新的测试 CoWorker
   */
  private async createNewTestCoWorker(): Promise<{
    coworkerId: string;
    userId: string;
    assignmentId: string;
    enrollToken: string;
    expiresAt: Date;
  }> {
    // 1. 获取或创建测试用户
    const testUser = await this.getOrCreateTestUser();

    // 2. 创建测试 CoWorker
    const coworker = await this.cwService.create({
      ...this.DEFAULT_CONFIG,
      createdBy: testUser.id,
    });

    // 3. 发布 CoWorker（enroll 需要 published 状态）
    await this.cwService.publish(coworker.id);

    // 4. 创建分配关系
    const assignment = await this.cwService.assign(coworker.id, testUser.id);

    // 5. 生成 enroll token
    const enrollToken = await this.cwService.generateEnrollToken(assignment.id) || assignment.id;

    // 6. 计算过期时间（24 小时后）
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // 7. 记录测试数据（用于清理）
    await this.recordTestData(coworker.id, testUser.id, assignment.id, expiresAt);

    this.logger.log(`测试 CoWorker 创建成功: ${coworker.id}, 过期时间: ${expiresAt.toISOString()}`);

    return {
      coworkerId: coworker.id,
      userId: testUser.id,
      assignmentId: assignment.id,
      enrollToken,
      expiresAt,
    };
  }

  /**
   * 清理测试数据
   *
   * @param coworkerId 可选，如果不提供则清理所有过期测试数据
   */
  async cleanupTestCoWorker(coworkerId?: string): Promise<{ cleaned: number }> {
    let cleaned = 0;

    if (coworkerId) {
      // 清理指定的 CoWorker
      cleaned = await this.cleanupSingle(coworkerId);
    } else {
      // 清理所有过期的测试数据
      cleaned = await this.cleanupExpired();
    }

    this.logger.log(`测试数据清理完成，清理数量: ${cleaned}`);
    return { cleaned };
  }

  /**
   * 获取测试 CoWorker 状态
   */
  async getTestCoWorkerStatus(coworkerId: string): Promise<{
    coworker: CoWorker | null;
    isTestData: boolean;
    expiresAt: Date | null;
    remainingHours: number | null;
  }> {
    const coworker = await this.cwService.getById(coworkerId);
    if (!coworker) {
      return { coworker: null, isTestData: false, expiresAt: null, remainingHours: null };
    }

    // 检查是否是测试数据
    const { rows } = await this.db.query(
      'SELECT expires_at FROM jz_coworker_test_data WHERE coworker_id = $1',
      [coworkerId],
    );

    if (rows.length === 0) {
      return { coworker, isTestData: false, expiresAt: null, remainingHours: null };
    }

    const expiresAt = rows[0].expires_at;
    const remainingHours = Math.max(0, (new Date(expiresAt).getTime() - Date.now()) / (1000 * 60 * 60));

    return {
      coworker,
      isTestData: true,
      expiresAt,
      remainingHours,
    };
  }

  /**
   * 获取所有测试 CoWorker 列表
   */
  async listTestCoWorkers(): Promise<Array<{
    coworkerId: string;
    name: string;
    createdAt: Date;
    expiresAt: Date;
    remainingHours: number;
    status: string;
  }>> {
    const { rows } = await this.db.query(
      `SELECT t.coworker_id, c.name, c.created_at, t.expires_at, c.status
       FROM jz_coworker_test_data t
       JOIN jz_coworkers c ON c.id = t.coworker_id
       ORDER BY t.created_at DESC`,
    );

    return rows.map(row => ({
      coworkerId: row.coworker_id,
      name: row.name,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      remainingHours: Math.max(0, (new Date(row.expires_at).getTime() - Date.now()) / (1000 * 60 * 60)),
      status: row.status,
    }));
  }

  // ===== 私有方法 =====

  /**
   * 获取或创建测试用户
   */
  private async getOrCreateTestUser(): Promise<{ id: string; name: string; email: string }> {
    const testEmail = 'verify-test@jianzhi.local';

    // 尝试查找现有测试用户
    const { rows } = await this.db.query(
      'SELECT id, name, email FROM jz_users WHERE email = $1',
      [testEmail],
    );

    if (rows.length > 0) {
      return { id: rows[0].id, name: rows[0].name, email: rows[0].email };
    }

    // 创建新测试用户
    const userId = randomUUID();
    // 生成随机密码（32 字符 hex）
    const testPassword = randomBytes(32).toString('hex');

    await this.db.query(
      'INSERT INTO jz_users (id, name, email, password) VALUES ($1, $2, $3, $4)',
      [userId, '本地验证测试', testEmail, testPassword],
    );

    this.logger.log(`测试用户创建成功: ${userId}`);
    return { id: userId, name: '本地验证测试', email: testEmail };
  }

  /**
   * 记录测试数据
   */
  private async recordTestData(
    coworkerId: string,
    userId: string,
    assignmentId: string,
    expiresAt: Date,
  ): Promise<void> {
    // 确保测试数据表存在
    await this.ensureTestDataTable();

    await this.db.query(
      `INSERT INTO jz_coworker_test_data (coworker_id, user_id, assignment_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [coworkerId, userId, assignmentId, expiresAt],
    );
  }

  /**
   * 确保测试数据表存在
   */
  private async ensureTestDataTable(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS jz_coworker_test_data (
        coworker_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        assignment_id TEXT NOT NULL,
        expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);
  }

  /**
   * 清理单个测试 CoWorker
   */
  private async cleanupSingle(coworkerId: string): Promise<number> {
    let cleaned = 0;

    try {
      // 获取测试数据
      const { rows } = await this.db.query(
        'SELECT user_id, assignment_id FROM jz_coworker_test_data WHERE coworker_id = $1',
        [coworkerId],
      );

      if (rows.length === 0) {
        return 0; // 不是测试数据
      }

      const { user_id, assignment_id } = rows[0];

      // 删除分配
      await this.db.query(
        'DELETE FROM jz_coworker_assignments WHERE id = $1',
        [assignment_id],
      );

      // 删除 CoWorker
      await this.cwService.delete(coworkerId);

      // 删除测试数据记录
      await this.db.query(
        'DELETE FROM jz_coworker_test_data WHERE coworker_id = $1',
        [coworkerId],
      );

      // 清理测试用户（如果没有其他测试 CoWorker）
      const { rows: remainingTests } = await this.db.query(
        'SELECT COUNT(*)::int as cnt FROM jz_coworker_test_data WHERE user_id = $1',
        [user_id],
      );

      if (remainingTests[0].cnt === 0) {
        await this.db.query(
          'DELETE FROM jz_users WHERE email = $1',
          ['verify-test@jianzhi.local'],
        );
      }

      cleaned = 1;
      this.logger.log(`测试 CoWorker 已清理: ${coworkerId}`);
    } catch (error) {
      this.logger.error(`清理测试 CoWorker 失败: ${coworkerId}`, error);
    }

    return cleaned;
  }

  /**
   * 清理所有过期的测试数据
   */
  private async cleanupExpired(): Promise<number> {
    let cleaned = 0;

    // 确保测试数据表存在
    await this.ensureTestDataTable();

    // 查找过期的测试数据
    const { rows } = await this.db.query(
      'SELECT coworker_id FROM jz_coworker_test_data WHERE expires_at < NOW()',
    );

    for (const row of rows) {
      cleaned += await this.cleanupSingle(row.coworker_id);
    }

    return cleaned;
  }
}
