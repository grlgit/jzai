import { Controller, Post, Get, Delete, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { Public } from '../../platform/auth/public.decorator';
import { CoWorkerVerifyService } from './coworker-verify.service';

/**
 * 本地验证测试 CoWorker API 端点
 *
 * 提供测试 CoWorker 的创建、查询和清理功能。
 * 这些端点用于 OpenClaw 本地验证功能。
 *
 * 注意：这些端点设为公开访问，仅用于本地开发/测试环境。
 */
@Public() // 允许公开访问（本地验证需要）
@Controller('api/coworkers/verify')
export class CoWorkerVerifyController {
  private readonly logger = new Logger(CoWorkerVerifyController.name);

  constructor(private readonly verifyService: CoWorkerVerifyService) {}

  /**
   * 创建测试 CoWorker
   *
   * POST /api/coworkers/verify/create
   *
   * 创建一个用于本地验证的测试 CoWorker，包括：
   * - 测试用户
   * - 测试 CoWorker
   * - 分配关系
   * - enroll token
   *
   * 返回：
   * - coworkerId: CoWorker ID
   * - userId: 测试用户 ID
   * - assignmentId: 分配 ID
   * - token: enroll token（用于激活）
   * - expiresAt: 过期时间（24 小时后）
   */
  @Post('create')
  @HttpCode(HttpStatus.OK)
  async createTestCoWorker() {
    try {
      const result = await this.verifyService.createTestCoWorker();

      this.logger.log(`测试 CoWorker 创建成功: ${result.coworkerId}`);

      return {
        success: true,
        coworkerId: result.coworkerId,
        userId: result.userId,
        assignmentId: result.assignmentId,
        token: result.enrollToken,
        expiresAt: result.expiresAt,
      };
    } catch (error) {
      this.logger.error('创建测试 CoWorker 失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '创建失败',
      };
    }
  }

  /**
   * 获取测试 CoWorker 状态
   *
   * GET /api/coworkers/verify/status/:id
   *
   * 查询测试 CoWorker 的状态信息：
   * - 是否是测试数据
   * - 过期时间
   * - 剩余小时数
   * - CoWorker 基本信息
   */
  @Get('status/:id')
  async getTestCoWorkerStatus({ params }: { params: { id: string } }) {
    try {
      const { coworker, isTestData, expiresAt, remainingHours } =
        await this.verifyService.getTestCoWorkerStatus(params.id);

      return {
        success: true,
        coworker: coworker ? {
          id: coworker.id,
          name: coworker.name,
          status: coworker.status,
          createdAt: coworker.createdAt,
        } : null,
        isTestData,
        expiresAt,
        remainingHours,
      };
    } catch (error) {
      this.logger.error(`获取测试 CoWorker 状态失败: ${params.id}`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '查询失败',
      };
    }
  }

  /**
   * 获取所有测试 CoWorker 列表
   *
   * GET /api/coworkers/verify/list
   */
  @Get('list')
  async listTestCoWorkers() {
    try {
      const list = await this.verifyService.listTestCoWorkers();

      return {
        success: true,
        list,
      };
    } catch (error) {
      this.logger.error('获取测试 CoWorker 列表失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '查询失败',
      };
    }
  }

  /**
   * 清理所有过期测试数据
   *
   * DELETE /api/coworkers/verify
   */
  @Delete()
  @HttpCode(HttpStatus.OK)
  async cleanupAllExpired() {
    try {
      const { cleaned } = await this.verifyService.cleanupTestCoWorker();

      this.logger.log(`过期测试数据清理完成，清理数量: ${cleaned}`);

      return {
        success: true,
        cleaned,
      };
    } catch (error) {
      this.logger.error('清理测试数据失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '清理失败',
      };
    }
  }

  /**
   * 清理指定的测试 CoWorker
   *
   * DELETE /api/coworkers/verify/:id
   */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cleanupTestCoWorker({ params }: { params: { id: string } }) {
    try {
      const { cleaned } = await this.verifyService.cleanupTestCoWorker(params.id);

      this.logger.log(`测试数据清理完成，清理数量: ${cleaned}`);

      return {
        success: true,
        cleaned,
      };
    } catch (error) {
      this.logger.error('清理测试数据失败', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : '清理失败',
      };
    }
  }
}
