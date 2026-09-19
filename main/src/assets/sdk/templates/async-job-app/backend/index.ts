/**
 * async-job-app 后端入口 —— 异步任务模式。
 * 同步工具/请求 ≤30s：提交类操作立即返回 jobId，长任务由 JobManager 后台驱动，
 * 面板与 agent 各自轮询状态。
 */
import type {
  AppContext, AppModuleShape,
  ToolProvider, ToolCatalogEntry, ToolContext, ToolInstance,
} from '../types/backend';
import { JobManager } from './lib/job-manager';

// ── ToolProvider：给 agent 的提交/查询工具 ──
class JobToolProvider implements ToolProvider {
  readonly toolIds = ['aj_job_submit', 'aj_job_status'];

  constructor(private readonly app: AppContext, private readonly jobs: JobManager) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      {
        id: 'aj_job_submit',
        label: '提交报表任务',
        group: '报表',
        description: '提交一批报表生成任务，立即返回 jobId；任务在后台执行，用 aj_job_status 查询进度',
        parameters: {
          type: 'object',
          properties: {
            type: { type: 'string', description: '报表类型，如 monthly-report' },
          },
          required: ['type'],
        },
      },
      {
        id: 'aj_job_status',
        label: '查询任务状态',
        group: '报表',
        description: '按 jobId 查询任务状态与进度；status 为 done 时返回聚合结果摘要',
        parameters: {
          type: 'object',
          properties: { jobId: { type: 'string', description: 'aj_job_submit 返回的任务 id' } },
          required: ['jobId'],
        },
      },
    ];
  }

  async createTools(_ctx: ToolContext): Promise<ToolInstance[]> {
    const queryStatus = async (jobId: string) => {
      const { rows: [job] } = await this.app.query(
        `SELECT id, type, status, progress, result FROM aj_jobs WHERE id=$1`, [jobId],
      );
      return job ?? { error: 'job not found' };
    };
    return [
      {
        name: 'aj_job_submit',
        description: '提交一批报表生成任务，立即返回 jobId',
        parameters: {
          type: 'object',
          properties: { type: { type: 'string' } },
          required: ['type'],
        },
        execute: async (_id: string, args: { type: string }) => {
          const jobId = await this.jobs.create(args.type);
          return { jobId, status: 'pending' }; // 立即返回，不等任务完成
        },
      },
      {
        name: 'aj_job_status',
        description: '按 jobId 查询任务状态与进度',
        parameters: {
          type: 'object',
          properties: { jobId: { type: 'string' } },
          required: ['jobId'],
        },
        execute: async (_id: string, args: { jobId: string }) => queryStatus(args.jobId),
      },
    ];
  }
}

// ── Controller：面板经 invoke 入口调用 ──
class JobController {
  constructor(private readonly app: AppContext, private readonly jobs: JobManager) {}

  async createJob(body: { type?: string }) {
    const jobId = await this.jobs.create(body?.type ?? 'monthly-report');
    return { jobId };
  }

  async getJob(body: { jobId?: string }) {
    if (!body?.jobId) throw new Error('jobId 不能为空');
    const { rows: [job] } = await this.app.query(
      `SELECT id, type, status, progress, result, created_at, finished_at
       FROM aj_jobs WHERE id=$1`, [body.jobId],
    );
    return job ?? { error: 'job not found' };
  }

  async listJobs(_body: unknown) {
    const { rows: jobs } = await this.app.query(
      `SELECT id, type, status, progress, created_at, finished_at
       FROM aj_jobs ORDER BY created_at DESC LIMIT 20`,
    );
    return { jobs };
  }
}

export class AsyncJobModule {
  static forApp(ctx: AppContext): AppModuleShape {
    const jobs = new JobManager(ctx);
    return {
      toolProviders: [new JobToolProvider(ctx, jobs)],
      controllers: { JobController: new JobController(ctx, jobs) },
    };
  }
}

export default AsyncJobModule;
