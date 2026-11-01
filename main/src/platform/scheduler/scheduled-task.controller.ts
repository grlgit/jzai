import { Controller, Get, Post, Put, Delete, Param, Body, Req, Query, BadRequestException, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { ScheduledTaskService } from './scheduled-task.service';
import type { TaskInput } from './scheduled-task.service';
import { TaskRunnerService } from './task-runner.service';
import { RequireAdmin } from '../authz/require-permission.decorator';
import { ResourceAccessService } from '../authz/resource-access.service';
import { AgentRegistryService } from '../../agent/core/agent-registry.service';
import { SkillRegistryService } from '../../capability/skill/skill-registry.service';
import { createInvocationPrincipal } from '../app-store/runtime/invocation-principal';
import type { InvocationPrincipal } from '../app-store/runtime/invocation-principal';

/**
 * P2 定时任务 API（docs/rework-2026H2/design-p2-scheduler.md §4.6），全部 @RequireAdmin。
 * 创建/更新校验：cron 合法性（service 层）、target 存在、run_as_user 存在且对 target 有 canView
 * （防 admin 替无权用户配置越权任务——执行期 principal 是 system，授权链锚点在创建时校验）。
 */
@Controller('api/scheduler/tasks')
@RequireAdmin()
export class ScheduledTaskController {
  private readonly logger = new Logger(ScheduledTaskController.name);

  constructor(
    private readonly tasks: ScheduledTaskService,
    private readonly runner: TaskRunnerService,
    private readonly access: ResourceAccessService,
    private readonly agentRegistry: AgentRegistryService,
    private readonly skillRegistry: SkillRegistryService,
    private readonly db: DbService,
  ) {}

  @Get()
  list() {
    return this.tasks.list();
  }

  /** cron 校验 + 未来 3 次触发预览（前端编辑弹窗用）；非法表达式 400 */
  @Post('cron-preview')
  preview(@Body() body: { cron?: string; timezone?: string }) {
    if (!body?.cron) throw new BadRequestException('cron 不能为空');
    return this.tasks.validateCron(body.cron, body.timezone);
  }

  @Post()
  async create(@Body() body: TaskInput, @Req() req: any) {
    await this.validateTarget(body);
    return this.tasks.create(body, req.user?.id);
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: Partial<TaskInput>) {
    const existing = await this.tasks.get(id);
    if (!existing) throw new BadRequestException(`定时任务 ${id} 不存在`);
    const merged: TaskInput = {
      name: body.name ?? existing.name,
      cron: body.cron ?? existing.cron,
      timezone: body.timezone ?? existing.timezone,
      targetType: body.targetType ?? existing.targetType,
      targetId: body.targetId ?? existing.targetId,
      payload: body.payload ?? existing.payload,
      runAsUserId: body.runAsUserId ?? existing.runAsUserId,
      onConfirm: body.onConfirm ?? existing.onConfirm,
      timeoutSec: body.timeoutSec ?? existing.timeoutSec,
      maxRetries: body.maxRetries ?? existing.maxRetries,
      enabled: body.enabled ?? existing.enabled,
    };
    await this.validateTarget(merged);
    return this.tasks.update(id, merged);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    await this.tasks.remove(id);
    return { success: true };
  }

  @Post(':id/run')
  async run(@Param('id') id: string) {
    const runId = await this.runner.runTask(id, 'manual');
    if (runId === null) throw new BadRequestException(`定时任务 ${id} 不存在`);
    return { success: true, runId };
  }

  @Post(':id/toggle')
  async toggle(@Param('id') id: string, @Body() body: { enabled?: boolean }) {
    if (typeof body?.enabled !== 'boolean') throw new BadRequestException('enabled 必须是布尔值');
    return this.tasks.setEnabled(id, body.enabled);
  }

  @Get(':id/runs')
  async runs(@Param('id') id: string, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const lim = Math.min(Number(limit) || 20, 100);
    const off = Number(offset) || 0;
    const { rows } = await this.db.query(
      `SELECT id, task_id as "taskId", started_at as "startedAt", finished_at as "finishedAt",
              status, trigger, output, error, duration_ms as "durationMs", session_id as "sessionId"
       FROM jz_scheduled_task_runs WHERE task_id=$1
       ORDER BY started_at DESC LIMIT $2 OFFSET $3`,
      [id, lim, off],
    );
    const { rows: countRows } = await this.db.query(
      `SELECT COUNT(*)::int AS count FROM jz_scheduled_task_runs WHERE task_id=$1`, [id]);
    return { runs: rows, total: countRows[0]?.count ?? 0 };
  }

  /** cron 校验（400）+ target 存在（400）+ run_as_user 存在且 canView（400） */
  private async validateTarget(input: TaskInput): Promise<void> {
    this.tasks.validateCron(input.cron, input.timezone); // 非法抛 BadRequestException

    if (input.targetType === 'agent') {
      if (!this.agentRegistry.get(input.targetId)) {
        throw new BadRequestException(`智能体 ${input.targetId} 不存在`);
      }
    } else if (!this.skillRegistry.get(input.targetId)) {
      throw new BadRequestException(`技能 ${input.targetId} 不存在`);
    }

    const principal = await this.principalFor(input.runAsUserId);
    if (!principal) throw new BadRequestException(`run_as_user ${input.runAsUserId} 不存在`);
    const ok = await this.access.canView(input.targetType, input.targetId, principal);
    if (!ok) {
      this.logger.warn(`scheduler 创建校验拒绝：${input.runAsUserId} 对 ${input.targetType}:${input.targetId} 无 canView`);
      throw new BadRequestException(`run_as_user 对该目标无访问权限`);
    }
  }

  /** 以 run_as_user 身份构造判定 principal（role/department/permissions 取 DB） */
  private async principalFor(userId: string): Promise<InvocationPrincipal | null> {
    const { rows } = await this.db.query(
      `SELECT u.id, u.role_id, r.permissions
       FROM jz_users u LEFT JOIN jz_roles r ON r.id = u.role_id WHERE u.id = $1`, [userId]);
    if (!rows[0]) return null;
    const dm = await this.db.query(
      `SELECT department_id FROM jz_department_members WHERE user_id=$1`, [userId]);
    return createInvocationPrincipal({
      type: 'user', principalId: `user:${userId}`, userId,
      roleIds: rows[0].role_id ? [rows[0].role_id] : [],
      departmentIds: dm.rows.map(r => r.department_id),
      permissions: rows[0].permissions ?? [],
      origin: 'http:scheduler-config',
      issuedAt: Date.now(),
    });
  }
}
