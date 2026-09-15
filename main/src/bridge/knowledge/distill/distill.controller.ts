import { Controller, Get, Post, Delete, Body, Param, Query, Req, ForbiddenException, BadRequestException } from '@nestjs/common';
import { DistillService } from './distill.service';
import { DistillValidationService } from './distill-validation.service';

/**
 * DistillController — 知识蒸馏的 REST 面（W3）。
 * 主要服务于 CoWorker 演练模式的"模拟运用 + 打分卡"，以及待优化队列管理。
 * 全局 JwtAuthGuard 已注入 request.user。
 */
@Controller('api/distill')
export class DistillController {
  constructor(
    private readonly distill: DistillService,
    private readonly validation: DistillValidationService,
  ) {}

  @Get('runs')
  async listRuns() {
    return this.distill.listRuns();
  }

  @Get('runs/:runId/status')
  async status(@Param('runId') runId: string) {
    return this.distill.status(runId);
  }

  /** 演练模式：列出候选内容供模拟运用与打分 */
  @Get('runs/:runId/candidates')
  async candidates(@Param('runId') runId: string, @Query('lifecycle') lifecycle?: string) {
    return this.validation.listCandidates(runId, { lifecycle });
  }

  /** 问题树：返回全部节点（含 parent_id）供前端建树展示 */
  @Get('runs/:runId/tree')
  async tree(@Param('runId') runId: string) {
    return this.distill.getTree(runId);
  }

  /** 提交一次评分（任何登录用户均可，多人多轮） */
  @Post('nodes/:nodeId/feedback')
  async feedback(@Req() req: any, @Param('nodeId') nodeId: string, @Body() body: {
    scores: { accuracy?: number; usability?: number; effectiveness?: number; safety?: number };
    scenario?: string; round?: number; comment?: string;
    flaggedErrors?: { snippet: string; reason: string }[];
  }) {
    const user = req.user;
    if (!user?.id) throw new ForbiddenException();
    if (!body?.scores) throw new BadRequestException('缺少 scores');
    return this.validation.submitFeedback(nodeId, user.id, body);
  }

  /** 批量入库：一键把候选直发企业心智（需审核权限）。不传 nodeIds = 全部可发布候选。 */
  @Post('runs/:runId/batch-publish')
  async batchPublish(@Req() req: any, @Param('runId') runId: string, @Body() body: { nodeIds?: string[] }) {
    this.requireReview(req);
    return this.validation.batchPublish(runId, { nodeIds: body?.nodeIds });
  }

  /** LLM 整理精炼（两段式：逐篇精炼 + 按层合并）。后台异步、需审核权限；进度走 /ws/distill。 */
  @Post('runs/:runId/curate')
  async curate(@Req() req: any, @Param('runId') runId: string, @Body() body: { polish?: boolean; merge?: boolean }) {
    this.requireReview(req);
    return this.distill.startCurate(runId, { polish: body?.polish, merge: body?.merge });
  }

  /** 停止整理精炼 */
  @Post('runs/:runId/curate/stop')
  async curateStop(@Req() req: any, @Param('runId') runId: string) {
    this.requireReview(req);
    return this.distill.stopCurate(runId);
  }

  /** 待优化队列（需审核权限） */
  @Get('runs/:runId/fix-queue')
  async fixQueue(@Req() req: any, @Param('runId') runId: string) {
    this.requireReview(req);
    return this.validation.fixQueue(runId);
  }

  /** 触发回流重写（需审核权限；会产生模型调用） */
  @Post('nodes/:nodeId/refine')
  async refine(@Req() req: any, @Param('nodeId') nodeId: string) {
    this.requireReview(req);
    return this.validation.refine(nodeId);
  }

  /** 增量蒸馏：向已有任务追加根问题（需审核权限） */
  @Post('runs/:runId/extend')
  async extend(@Req() req: any, @Param('runId') runId: string, @Body() body: { questions: string[] }) {
    this.requireReview(req);
    if (!Array.isArray(body?.questions) || !body.questions.length) throw new BadRequestException('缺少 questions');
    return this.distill.extendRun(runId, body.questions);
  }

  /** 删除单个未生效节点（需审核权限） */
  @Delete('nodes/:nodeId')
  async deleteNode(@Req() req: any, @Param('nodeId') nodeId: string) {
    this.requireReview(req);
    return this.distill.deleteNode(nodeId);
  }

  /** 删除整个未生效蒸馏任务（需审核权限；有生效内容时拒绝） */
  @Delete('runs/:runId')
  async deleteRun(@Req() req: any, @Param('runId') runId: string) {
    this.requireReview(req);
    return this.distill.deleteRun(runId);
  }

  /** 评分者权重管理（需审核权限） */
  @Get('rater-weights')
  async listWeights(@Req() req: any) {
    this.requireReview(req);
    return this.validation.listRaterWeights();
  }

  @Post('rater-weights')
  async setWeight(@Req() req: any, @Body() body: { userId: string; weight: number; note?: string }) {
    this.requireReview(req);
    if (!body?.userId) throw new BadRequestException('缺少 userId');
    return this.validation.setRaterWeight(body.userId, body.weight, body.note);
  }

  private requireReview(req: any) {
    const perms: string[] = req.user?.role?.permissions || [];
    if (!perms.includes('kb:review') && !perms.includes('sys:admin')) {
      throw new ForbiddenException('需要知识审核权限');
    }
  }
}
