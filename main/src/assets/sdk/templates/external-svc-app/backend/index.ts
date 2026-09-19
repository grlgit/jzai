/**
 * external-svc-app 后端入口 —— 外部服务模式（CP-SAT 排程）。
 * 三层形态：lib/ 服务层（SolverClient + JobManager）→ controller（面板通道）→ tools（agent 通道）。
 * 求解伴侣服务（solver/ 目录）独立于本 .jzapp 部署，地址经 configSchema 配置注入。
 */
import type {
  AppContext, AppModuleShape,
  ToolProvider, ToolCatalogEntry, ToolContext, ToolInstance,
} from '../types/backend';
import { SolverClient } from './lib/solver-client';
import { JobManager } from './lib/job-manager';

// ── ToolProvider：交互式调优工具族（catalog 描述即 LLM 使用说明）──
class ScheduleToolProvider implements ToolProvider {
  readonly toolIds = ['es_submit', 'es_metrics', 'es_whatif', 'es_impact', 'es_apply'];

  constructor(private readonly jobs: JobManager) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      {
        id: 'es_submit',
        label: '创建排程',
        group: '生产排程',
        description: '对已确认的资源与订单做 CP-SAT 初排，立即返回 jobId（异步求解，用 es_metrics 查询进度与结果）',
        parameters: {
          type: 'object',
          properties: { horizon: { type: 'string', description: '排程范围，如 next-week' } },
        },
      },
      {
        id: 'es_metrics',
        label: '排程结果分析',
        group: '生产排程',
        description: '返回 KPI 摘要：交期违约订单、换模/换线时间损失、最大 LeadTime、平均 WIP/CT。全量甘特请到面板查看',
        parameters: {
          type: 'object',
          properties: { jobId: { type: 'string', description: 'es_submit 返回的任务 id' } },
          required: ['jobId'],
        },
      },
      {
        id: 'es_whatif',
        label: '排程调整预演',
        group: '生产排程',
        description:
          '对某 baseline 应用调整操作做预演求解，返回 scenarioJobId。ops 为原子操作数组：' +
          'insert_order{orderId} / change_due{orderId,dueDate} / change_priority{orderIds[]} / ' +
          'lock_resource{resourceId,window} / disable_resource{resourceId,window}',
        parameters: {
          type: 'object',
          properties: {
            baselineJobId: { type: 'string' },
            ops: { type: 'array', items: { type: 'object' }, description: '原子调整操作集' },
          },
          required: ['baselineJobId', 'ops'],
        },
      },
      {
        id: 'es_impact',
        label: '查看调整冲击',
        group: '生产排程',
        description:
          '对比 scenario 与 baseline，返回受冲击订单及程度（交期变化、损失增减），并签发 confirmToken（10 分钟有效）。' +
          '落库前必须先把冲击如实告知用户',
        parameters: {
          type: 'object',
          properties: { scenarioJobId: { type: 'string' } },
          required: ['scenarioJobId'],
        },
      },
      {
        id: 'es_apply',
        label: '确认落库',
        group: '生产排程',
        description:
          '将预演方案落库为正式计划。必须携带 es_impact 签发的 confirmToken；未经用户明确同意不得调用',
        parameters: {
          type: 'object',
          properties: {
            scenarioJobId: { type: 'string' },
            confirmToken: { type: 'string', description: 'es_impact 签发、10 分钟有效' },
          },
          required: ['scenarioJobId', 'confirmToken'],
        },
      },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const entry = (name: string, description: string, parameters: unknown,
      run: (args: any) => Promise<any>): ToolInstance =>
      ({ name, description, parameters, execute: async (_id, args) => run(args) });

    return [
      entry('es_submit', '对已确认的资源与订单做 CP-SAT 初排，立即返回 jobId',
        { type: 'object', properties: { horizon: { type: 'string' } } },
        async (args) => ({ jobId: await this.jobs.create('baseline', { horizon: args?.horizon ?? 'next-week' }) })),

      entry('es_metrics', '返回排程 KPI 摘要（聚合指标，非全量解）',
        { type: 'object', properties: { jobId: { type: 'string' } }, required: ['jobId'] },
        async (args) => this.jobs.metrics(args.jobId)),

      entry('es_whatif', '对 baseline 应用原子调整操作做预演，返回 scenarioJobId',
        {
          type: 'object',
          properties: { baselineJobId: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } },
          required: ['baselineJobId', 'ops'],
        },
        async (args) => ({
          scenarioJobId: await this.jobs.create('scenario',
            { baselineJobId: args.baselineJobId, ops: args.ops }, args.baselineJobId, args.ops),
        })),

      entry('es_impact', '对比 scenario 与 baseline 的冲击，并签发 confirmToken',
        { type: 'object', properties: { scenarioJobId: { type: 'string' } }, required: ['scenarioJobId'] },
        async (args) => this.jobs.impact(args.scenarioJobId)),

      entry('es_apply', '持 confirmToken 将预演方案落库为正式计划',
        {
          type: 'object',
          properties: { scenarioJobId: { type: 'string' }, confirmToken: { type: 'string' } },
          required: ['scenarioJobId', 'confirmToken'],
        },
        async (args) => this.jobs.apply(args.scenarioJobId, args.confirmToken, ctx.userId)),
    ];
  }
}

// ── Controller：面板主通道（方法须在 manifest handlers 白名单）──
class ScheduleController {
  constructor(private readonly app: AppContext, private readonly jobs: JobManager) {}

  /** 创建 baseline 排程任务（异步），返回 jobId */
  async createJob(body: { horizon?: string }) {
    const jobId = await this.jobs.create('baseline', { horizon: body?.horizon ?? 'next-week' });
    return { jobId };
  }

  /** 面板轮询：含全量 solution（面板专用，不经 LLM） */
  async getJob(body: { jobId?: string }) {
    if (!body?.jobId) throw new Error('jobId 不能为空');
    const { rows: [job] } = await this.app.query(
      `SELECT id, type, status, progress, solution, metrics, created_at, finished_at
       FROM jobs WHERE id=$1`, [body.jobId],
    );
    return job ?? { error: 'job not found' };
  }

  /**
   * 调整预演（两阶段，面板侧与 agent es_whatif/es_impact 走同一机制）：
   * ① 传 baselineJobId+ops → 创建 scenario 任务，返回 scenarioId（异步求解）；
   * ② 传 scenarioId → 返回冲击分析并签发 confirmToken（scenario 完成时）。
   */
  async previewImpact(body: { baselineJobId?: string; ops?: any[]; scenarioId?: string }) {
    if (body?.scenarioId) return this.jobs.impact(body.scenarioId);
    if (!body?.baselineJobId || !Array.isArray(body?.ops)) throw new Error('baselineJobId 与 ops 不能为空');
    const scenarioId = await this.jobs.create('scenario',
      { baselineJobId: body.baselineJobId, ops: body.ops }, body.baselineJobId, body.ops);
    return { scenarioId };
  }

  /** 确认落库：面板弹窗收集用户确认后调用（confirmToken 来自 jobs.impact） */
  async applyResult(body: { scenarioId?: string; confirmToken?: string }) {
    if (!body?.scenarioId || !body?.confirmToken) throw new Error('scenarioId 与 confirmToken 不能为空');
    return this.jobs.apply(body.scenarioId, body.confirmToken, this.app.userId);
  }

  async listOrders(_body: unknown) {
    const { rows: orders } = await this.app.query(
      `SELECT id, payload, confirmed, synced_at FROM orders ORDER BY id LIMIT 200`);
    return { orders };
  }

  /** 订单确认：只有 confirmed=TRUE 的订单参与排程 */
  async confirmOrders(body: { orderIds?: string[] }) {
    const ids = body?.orderIds ?? [];
    if (ids.length === 0) throw new Error('orderIds 不能为空');
    await this.app.query(
      `UPDATE orders SET confirmed = (id = ANY($1::text[]))`, [ids]);
    return { ok: true, confirmed: ids.length };
  }

  /**
   * 资源同步：经平台 MCP 连接器读 ERP（通道②，须在 manifest usesPlatformTools 声明 "mcp"）。
   * 真实项目中把 mcp 工具名/参数换成你的 ERP 连接器（配置项可加到 configSchema）。
   */
  async syncResources(_body: unknown) {
    const erpRows = await this.app.tools.call('mcp', {
      connector: 'erp',
      action: 'list_resources',
    }) as Array<{ id: string; kind: string; payload: unknown }>;
    let n = 0;
    for (const r of erpRows ?? []) {
      await this.app.query(
        `INSERT INTO resources (id, kind, payload, synced_at) VALUES ($1,$2,$3,NOW())
         ON CONFLICT (id) DO UPDATE SET kind=$2, payload=$3, synced_at=NOW()`,
        [r.id, r.kind, JSON.stringify(r.payload)]);
      n++;
    }
    this.app.logger.log(`syncResources: ${n} rows from ERP`);
    return { ok: true, synced: n };
  }
}

export class ScheduleModule {
  static forApp(ctx: AppContext): AppModuleShape {
    // configSchema 注入：secret 字段已解密为真值
    const solver = new SolverClient(
      String(ctx.config.solverEndpoint ?? 'http://sched-solver:8100'),
      String(ctx.config.solverApiKey ?? ''),
    );
    const jobs = new JobManager(ctx, solver);
    return {
      toolProviders: [new ScheduleToolProvider(jobs)],
      controllers: { ScheduleController: new ScheduleController(ctx, jobs) },
    };
  }
}

export default ScheduleModule;
