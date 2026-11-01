import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { DynamicAgentService, StreamChunk } from '../../agent/core/dynamic-agent.service';
import { ConfirmationBridgeService, ConfirmRequest } from '../../agent/support/confirmation-bridge.service';
import { createSystemPrincipal } from '../app-store/runtime/invocation-principal';
import { ScheduledTask } from './scheduled-task.service';
import { TaskRunnerService } from './task-runner.service';

/**
 * P2 无人值守智能体执行器（docs/rework-2026H2/design-p2-scheduler.md §4.4）。
 * - 消费 processMessage AsyncGenerator，丢弃流式 chunk，仅累积 text_delta 为最终输出
 * - sessionId = sched_{taskId}_{runId}（独立会话，不污染用户会话；列表按前缀过滤）
 * - principal = createSystemPrincipal(runAsUserId, 'scheduler')：P1 buildForAgent 对
 *   origin='scheduler' 跳过资源过滤；confirm 策略经 scopes 传递（confirm:skip_tool）
 * - confirm 处理：reject（默认）注册 headless 自动应答器，立即拒绝不挂起；
 *   skip_tool 由 tool-adapter 在创建期剔除 confirm:true 工具（LLM 看不到）
 */
@Injectable()
export class HeadlessAgentRunner implements OnModuleInit {
  private readonly logger = new Logger(HeadlessAgentRunner.name);

  constructor(
    private readonly dynamicAgent: DynamicAgentService,
    private readonly taskRunner: TaskRunnerService,
    @Optional() private readonly confirmBridge?: ConfirmationBridgeService,
  ) {}

  onModuleInit() {
    this.taskRunner.registerAgentRunner((task, runId) => this.run(task, runId));
  }

  async run(task: ScheduledTask, runId: number): Promise<{ output: string; sessionId: string }> {
    const sessionId = `sched_${task.id}_${runId}`;
    // origin='scheduler'：P1 buildForAgent 跳过资源过滤；run_as_user 经 processMessage userId 参数锚定
    const principal = createSystemPrincipal('scheduler',
      task.onConfirm === 'skip_tool' ? ['confirm:skip_tool'] : []);

    // reject 模式：无人值守自动应答（立即拒绝，避免挂到超时）
    let autoReject: ((req: ConfirmRequest) => void) | null = null;
    if (task.onConfirm === 'reject' && this.confirmBridge) {
      autoReject = (req: ConfirmRequest) => {
        this.logger.log(`无人值守自动拒绝确认请求 ${req.confirmId}（${req.toolName}），任务 ${task.id}`);
        this.confirmBridge!.handleReply(req.confirmId, false);
      };
      this.confirmBridge.events.on('confirm_request', autoReject);
    }

    try {
      const prompt = task.payload?.prompt ?? '';
      const gen = this.dynamicAgent.processMessage(
        task.targetId, sessionId, task.runAsUserId, prompt,
        undefined, undefined, undefined, principal,
      );
      let text = '';
      try {
        for await (const chunk of gen as AsyncGenerator<StreamChunk>) {
          if (chunk.type === 'error') throw new Error(chunk.error || '智能体执行出错');
          if (chunk.type === 'text_delta') text += chunk.text ?? '';
        }
      } catch (err) {
        // 超时/中断场景显式释放 generator（设计 §4.3：须显式 .return()）
        try { await gen.return(undefined as never); } catch { /* already closed */ }
        throw err;
      }
      return { output: text.trim(), sessionId };
    } finally {
      if (autoReject && this.confirmBridge) {
        this.confirmBridge.events.off('confirm_request', autoReject);
      }
    }
  }
}
