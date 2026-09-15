import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import { FileCleanupService } from '../../workspace/file-cleanup.service';
import type { PoolClient } from 'pg';

/** 内置补偿动作：删除步骤产出的导出文件。 */
export const COMPENSATION_DELETE_FILE = '__delete_file';

/**
 * 工具名 → 补偿动作的静态映射（服务端唯一来源）。
 * 客户端传入的 compensation_tool 一律丢弃：它是未校验的 HTTP body，
 * 可被用来指使服务端执行任意工具。
 */
const COMPENSATION_BY_TOOL: Record<string, string> = {
  export_excel: COMPENSATION_DELETE_FILE,
  generate_pdf: COMPENSATION_DELETE_FILE,
  update_pdf: COMPENSATION_DELETE_FILE,
};

/** 卡在 running/compensating 的工作流超过该时长即视为过期。 */
const STALE_WORKFLOW_MS = 30 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * 工作流状态枚举
 */
export enum WorkflowStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  COMPENSATING = 'compensating',
  COMPENSATED = 'compensated',
}

/**
 * 步骤状态枚举
 */
export enum StepStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  SKIPPED = 'skipped',
  COMPENSATING = 'compensating',
  COMPENSATED = 'compensated',
}

/**
 * 工作流步骤定义
 */
export interface WorkflowStep {
  stepNumber: number;
  stepName: string;
  toolName: string;
  inputParams: Record<string, any>;
}

/**
 * 工作流创建选项
 */
export interface CreateWorkflowOptions {
  workflowType: string;
  description?: string;
  steps: WorkflowStep[];
  initialContext?: Record<string, any>;
}

/**
 * 工作流事务信息
 */
export interface WorkflowTransaction {
  id: string;
  workflowId: string;
  assignmentId: string;
  coworkerId: string;
  userId: string;
  status: WorkflowStatus;
  workflowType: string;
  description: string;
  context: Record<string, any>;
  errorMessage?: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * 工作流步骤信息
 */
export interface WorkflowStepInfo {
  id: string;
  workflowId: string;
  stepNumber: number;
  stepName: string;
  toolName: string;
  status: StepStatus;
  inputParams: Record<string, any>;
  outputResult?: Record<string, any>;
  outputFileId?: string;
  errorMessage?: string;
  compensationTool?: string;
  compensationParams?: Record<string, any>;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * WorkflowTransactionService - 工作流事务管理服务
 *
 * 功能：
 * - 工作流创建与启动
 * - 步骤顺序执行
 * - 失败自动补偿
 * - 状态持久化
 * - 乐观锁并发控制
 */
@Injectable()
export class WorkflowTransactionService implements OnModuleDestroy {
  private readonly logger = new Logger(WorkflowTransactionService.name);
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly db: DbService,
    private readonly fileCleanup: FileCleanupService,
  ) {
    this.sweepTimer = setInterval(() => {
      this.sweepStaleWorkflows().catch(err => this.logger.warn(`过期工作流清理失败: ${err.message}`));
    }, STALE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweepTimer);
  }

  /**
   * 创建新的工作流事务
   */
  async createWorkflow(
    assignmentId: string,
    coworkerId: string,
    userId: string,
    options: CreateWorkflowOptions,
  ): Promise<WorkflowTransaction> {
    const workflowId = this.generateWorkflowId();

    // 使用 DbService.transaction 方法确保原子性
    return await this.db.transaction(async (client) => {
      // 插入工作流事务记录
      const insertResult = await client.query(`
        INSERT INTO jz_workflow_transactions
          (workflow_id, assignment_id, coworker_id, user_id, status, workflow_type, description, context)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING *
      `, [workflowId, assignmentId, coworkerId, userId, WorkflowStatus.PENDING, options.workflowType, options.description || '', JSON.stringify(options.initialContext || {})]);

      const workflow = this.mapWorkflowTransaction(insertResult.rows[0]);

      // 插入步骤记录（补偿动作由服务端按工具名推导，忽略调用方传入的值）
      for (const step of options.steps) {
        await client.query(`
          INSERT INTO jz_workflow_steps
            (workflow_id, step_number, step_name, tool_name, input_params, compensation_tool, compensation_params)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [workflowId, step.stepNumber, step.stepName, step.toolName, JSON.stringify(step.inputParams), this.deriveCompensationTool(step.toolName), null]);
      }

      this.logger.log(`Workflow created: ${workflowId} (${options.steps.length} steps)`);
      return workflow;
    });
  }

  /**
   * 启动工作流执行
   */
  async startWorkflow(workflowId: string): Promise<WorkflowTransaction> {
    // 使用乐观锁更新状态
    const result = await this.db.query(`
      UPDATE jz_workflow_transactions
      SET status = $2,
          started_at = NOW(),
          updated_at = NOW(),
          version = version + 1
      WHERE workflow_id = $1 AND status = $3
      RETURNING *
    `, [workflowId, WorkflowStatus.RUNNING, WorkflowStatus.PENDING]);

    if (result.rows.length === 0) {
      throw new Error(`Workflow ${workflowId} not found or not in PENDING status`);
    }

    this.logger.log(`Workflow started: ${workflowId}`);
    return this.mapWorkflowTransaction(result.rows[0]);
  }

  /**
   * 执行工作流的所有步骤
   * 顺序执行每个步骤，失败时触发补偿
   */
  async executeWorkflow(workflowId: string, stepExecutor: (toolName: string, params: any, context: any) => Promise<any>): Promise<WorkflowTransaction> {
    const workflow = await this.getWorkflow(workflowId);
    if (workflow.status !== WorkflowStatus.RUNNING) {
      throw new Error(`Workflow ${workflowId} is not in RUNNING status`);
    }

    const steps = await this.getSteps(workflowId);
    const completedSteps: WorkflowStepInfo[] = [];
    let lastError: any = null;

    try {
      // 顺序执行每个步骤
      for (const step of steps) {
        this.logger.log(`Executing step ${step.stepNumber}: ${step.stepName}`);

        // 更新步骤状态为 RUNNING
        await this.updateStepStatus(step.id, StepStatus.RUNNING);

        try {
          // 执行工具
          const result = await stepExecutor(step.toolName, step.inputParams, workflow.context);

          // 更新步骤状态为 COMPLETED
          await this.completeStep(step.id, result);

          // 更新工作流上下文
          if (result && typeof result === 'object') {
            workflow.context[`${step.stepName}_result`] = result;
            if (result.fileId) {
              workflow.context[`${step.stepName}_fileId`] = result.fileId;
            }
          }

          completedSteps.push(step);
          this.logger.log(`Step ${step.stepNumber} completed: ${step.stepName}`);

        } catch (err: any) {
          lastError = err;
          this.logger.error(`Step ${step.stepNumber} failed: ${step.stepName} - ${err.message}`);

          // 更新步骤状态为 FAILED
          await this.failStep(step.id, err);

          // 触发补偿
          await this.compensateWorkflow(workflowId, `步骤 ${step.stepNumber} (${step.stepName}) 失败: ${err.message}`, step.stepNumber);
          throw err;
        }
      }

      // 所有步骤成功完成
      return await this.completeWorkflow(workflowId);

    } catch (err: any) {
      // 工作流失败
      return await this.failWorkflow(workflowId, err.message);
    }
  }

  /**
   * 补偿工作流
   * 按相反顺序撤销已完成的步骤（当前唯一补偿动作是删除步骤产出的文件）。
   * 整个过程在单个事务内完成并对工作流行加锁，重复调用是幂等的。
   *
   * @param failedStepNumber 只补偿该步骤之前的步骤；省略则补偿全部已完成步骤
   * @returns 实际被补偿的步骤数
   */
  async compensateWorkflow(workflowId: string, reason: string, failedStepNumber?: number): Promise<number> {
    this.logger.log(`Starting compensation for workflow ${workflowId} (${reason})`);

    return await this.db.transaction(async (client) => {
      const wfResult = await client.query(`
        SELECT * FROM jz_workflow_transactions WHERE workflow_id = $1 FOR UPDATE
      `, [workflowId]);

      if (wfResult.rows.length === 0) throw new Error(`Workflow ${workflowId} not found`);
      const wf = wfResult.rows[0];

      // 幂等：已补偿或正在补偿的工作流直接返回
      if (wf.status === WorkflowStatus.COMPENSATED || wf.status === WorkflowStatus.COMPENSATING) {
        this.logger.log(`Workflow ${workflowId} already ${wf.status}, skipping compensation`);
        return 0;
      }

      await client.query(`
        UPDATE jz_workflow_transactions
        SET status = $2, compensating_at = NOW(), version = version + 1
        WHERE workflow_id = $1
      `, [workflowId, WorkflowStatus.COMPENSATING]);

      // 只补偿已完成且有补偿动作的步骤，按相反顺序；锁行防止与 executeWorkflow 并发写
      const stepsResult = await client.query(`
        SELECT * FROM jz_workflow_steps
        WHERE workflow_id = $1
          AND ($2::int IS NULL OR step_number < $2)
          AND status = $3
          AND compensation_tool IS NOT NULL
        ORDER BY step_number DESC
        FOR UPDATE
      `, [workflowId, failedStepNumber ?? null, StepStatus.COMPLETED]);

      let compensated = 0;
      for (const step of stepsResult.rows) {
        this.logger.log(`Compensating step ${step.step_number}: ${step.step_name}`);

        await client.query(`
          UPDATE jz_workflow_steps SET status = $2 WHERE id = $1
        `, [step.id, StepStatus.COMPENSATING]);

        const note = await this.runCompensation(client, wf.user_id, step);

        await client.query(`
          UPDATE jz_workflow_steps
          SET status = $2, error_message = COALESCE($3, error_message)
          WHERE id = $1
        `, [step.id, StepStatus.COMPENSATED, note]);

        compensated++;
      }

      await client.query(`
        UPDATE jz_workflow_transactions
        SET status = $2, compensated_at = NOW(), compensation_reason = $3, version = version + 1
        WHERE workflow_id = $1
      `, [workflowId, WorkflowStatus.COMPENSATED, reason]);

      this.logger.log(`Workflow compensation completed: ${workflowId} (${compensated} steps)`);
      return compensated;
    });
  }

  /** 按工具名推导补偿动作；无对应动作的步骤不可补偿。 */
  private deriveCompensationTool(toolName: string): string | null {
    return COMPENSATION_BY_TOOL[toolName] || null;
  }

  /**
   * 执行单个步骤的补偿动作。
   * 返回 null 表示成功，否则返回写入 error_message 的说明。
   */
  private async runCompensation(client: PoolClient, userId: string, step: any): Promise<string | null> {
    if (step.compensation_tool !== COMPENSATION_DELETE_FILE) {
      return `未知补偿动作: ${step.compensation_tool}`;
    }

    const fileIds = await this.collectStepFileIds(client, step);
    if (!fileIds.length) return '无可删除的产出文件';

    const failed = fileIds.filter(fileId => !this.fileCleanup.deleteExportFile(userId, fileId));
    return failed.length ? `以下文件未能删除: ${failed.join(', ')}` : null;
  }

  /**
   * 收集步骤产出的文件 id。
   * 只读持久化数据：workflow.context 从未落库（executeWorkflow 只改内存副本）。
   */
  private async collectStepFileIds(client: PoolClient, step: any): Promise<string[]> {
    const fileIds = new Set<string>();
    if (step.output_file_id) fileIds.add(step.output_file_id);

    const attachments = await client.query(`
      SELECT file_id FROM jz_workflow_attachments
      WHERE step_id = $1 AND role = 'output'
    `, [step.id]);
    for (const row of attachments.rows) if (row.file_id) fileIds.add(row.file_id);

    return Array.from(fileIds);
  }

  /**
   * 清理过期工作流：卡在 running/compensating 超过阈值的，走补偿并标记失败。
   * 用 setInterval 而非 @nestjs/schedule（未安装），与 agent-pool.service.ts 一致。
   */
  private async sweepStaleWorkflows(): Promise<void> {
    const cutoff = new Date(Date.now() - STALE_WORKFLOW_MS);
    const { rows } = await this.db.query(`
      SELECT workflow_id FROM jz_workflow_transactions
      WHERE status IN ($1, $2) AND COALESCE(started_at, created_at) < $3
      LIMIT 20
    `, [WorkflowStatus.RUNNING, WorkflowStatus.COMPENSATING, cutoff]);

    for (const row of rows) {
      try {
        await this.compensateWorkflow(row.workflow_id, '工作流超时未完成，已自动补偿');
        await this.failWorkflow(row.workflow_id, '工作流超时未完成');
      } catch (err: any) {
        this.logger.warn(`清理过期工作流 ${row.workflow_id} 失败: ${err.message}`);
      }
    }
  }

  /**
   * 完成工作流
   */
  async completeWorkflow(workflowId: string): Promise<WorkflowTransaction> {
    const result = await this.db.query(`
      UPDATE jz_workflow_transactions
      SET status = $2,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE workflow_id = $1
      RETURNING *
    `, [workflowId, WorkflowStatus.COMPLETED]);

    this.logger.log(`Workflow completed: ${workflowId}`);
    return this.mapWorkflowTransaction(result.rows[0]);
  }

  /**
   * 工作流失败
   */
  async failWorkflow(workflowId: string, errorMessage: string): Promise<WorkflowTransaction> {
    const result = await this.db.query(`
      UPDATE jz_workflow_transactions
      SET status = $2,
          error_message = $3,
          completed_at = NOW(),
          version = version + 1
      WHERE workflow_id = $1 AND status NOT IN ($4, $5)
      RETURNING *
    `, [workflowId, WorkflowStatus.FAILED, errorMessage, WorkflowStatus.COMPENSATED, WorkflowStatus.COMPLETED]);

    // 终态不可被覆盖：补偿成功的工作流不应回退成 failed
    if (result.rows.length === 0) {
      this.logger.warn(`Workflow ${workflowId} already terminal, keeping status: ${errorMessage}`);
      return this.getWorkflow(workflowId);
    }

    this.logger.error(`Workflow failed: ${workflowId} - ${errorMessage}`);
    return this.mapWorkflowTransaction(result.rows[0]);
  }

  /**
   * 获取工作流信息
   */
  async getWorkflow(workflowId: string): Promise<WorkflowTransaction> {
    const result = await this.db.query(`
      SELECT * FROM jz_workflow_transactions
      WHERE workflow_id = $1
    `, [workflowId]);

    if (result.rows.length === 0) {
      throw new Error(`Workflow ${workflowId} not found`);
    }

    return this.mapWorkflowTransaction(result.rows[0]);
  }

  /**
   * 获取工作流的所有步骤
   */
  async getSteps(workflowId: string): Promise<WorkflowStepInfo[]> {
    const result = await this.db.query(`
      SELECT * FROM jz_workflow_steps
      WHERE workflow_id = $1
      ORDER BY step_number ASC
    `, [workflowId]);

    return result.rows.map(row => this.mapWorkflowStep(row));
  }

  /**
   * 更新步骤状态为 COMPLETED
   */
  private async completeStep(stepId: string, result: any): Promise<void> {
    const outputFileId = result?.fileId || result?.details?.fileId || null;

    await this.db.query(`
      UPDATE jz_workflow_steps
      SET status = $2,
          output_result = $3,
          output_file_id = $4,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [stepId, StepStatus.COMPLETED, JSON.stringify(result), outputFileId]);
  }

  /**
   * 更新步骤状态为 FAILED
   */
  private async failStep(stepId: string, error: any): Promise<void> {
    await this.db.query(`
      UPDATE jz_workflow_steps
      SET status = $2,
          error_message = $3,
          error_code = $4,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
    `, [stepId, StepStatus.FAILED, error.message, error.code || 'EXECUTION_ERROR']);
  }

  /**
   * 更新步骤状态
   */
  private async updateStepStatus(stepId: string, status: StepStatus): Promise<void> {
    const runningClause = status === StepStatus.RUNNING ? ', started_at = NOW()' : '';
    await this.db.query(`
      UPDATE jz_workflow_steps
      SET status = $2${runningClause}, updated_at = NOW()
      WHERE id = $1
    `, [stepId, status]);
  }

  /**
   * 添加附件到工作流
   */
  async addAttachment(
    workflowId: string,
    fileId: string,
    filename: string,
    fileType: string,
    role: 'input' | 'output' | 'attachment',
    stepId?: string,
    metadata?: Record<string, any>,
  ): Promise<void> {
    await this.db.query(`
      INSERT INTO jz_workflow_attachments
        (workflow_id, step_id, file_id, filename, file_type, role, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [workflowId, stepId || null, fileId, filename, fileType, role, JSON.stringify(metadata || {})]);
  }

  /**
   * 获取工作流的附件列表
   */
  async getAttachments(workflowId: string, role?: string): Promise<any[]> {
    const query = role
      ? `SELECT * FROM jz_workflow_attachments WHERE workflow_id = $1 AND role = $2 ORDER BY created_at ASC`
      : `SELECT * FROM jz_workflow_attachments WHERE workflow_id = $1 ORDER BY created_at ASC`;

    const params = role ? [workflowId, role] : [workflowId];
    const result = await this.db.query(query, params);
    return result.rows;
  }

  /**
   * 生成唯一的工作流ID
   */
  private generateWorkflowId(): string {
    return `wf_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
  }

  /**
   * 映射数据库行到 WorkflowTransaction
   */
  private mapWorkflowTransaction(row: any): WorkflowTransaction {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      assignmentId: row.assignment_id,
      coworkerId: row.coworker_id,
      userId: row.user_id,
      status: row.status as WorkflowStatus,
      workflowType: row.workflow_type,
      description: row.description,
      context: typeof row.context === 'string' ? JSON.parse(row.context) : row.context,
      errorMessage: row.error_message,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }

  /**
   * 映射数据库行到 WorkflowStepInfo
   */
  private mapWorkflowStep(row: any): WorkflowStepInfo {
    return {
      id: row.id,
      workflowId: row.workflow_id,
      stepNumber: row.step_number,
      stepName: row.step_name,
      toolName: row.tool_name,
      status: row.status as StepStatus,
      inputParams: typeof row.input_params === 'string' ? JSON.parse(row.input_params) : row.input_params,
      outputResult: row.output_result ? (typeof row.output_result === 'string' ? JSON.parse(row.output_result) : row.output_result) : undefined,
      outputFileId: row.output_file_id,
      errorMessage: row.error_message,
      compensationTool: row.compensation_tool,
      compensationParams: row.compensation_params
        ? (typeof row.compensation_params === 'string' ? JSON.parse(row.compensation_params) : row.compensation_params)
        : undefined,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  }
}
