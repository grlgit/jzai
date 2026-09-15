import { Test, TestingModule } from '@nestjs/testing';
import { WorkflowTransactionService, WorkflowStatus, StepStatus, COMPENSATION_DELETE_FILE } from './workflow-transaction.service';
import { DbService } from '../../db/db.service';
import { FileCleanupService } from '../../workspace/file-cleanup.service';

type Call = { sql: string; params: any[] };

/** 按 SQL 片段依次返回结果的假 client。 */
function makeClient(responder: (sql: string, params: any[]) => any[]) {
  const calls: Call[] = [];
  const client = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: responder(sql, params) };
    },
  };
  return { client, calls };
}

describe('WorkflowTransactionService', () => {
  let service: WorkflowTransactionService;
  let db: { query: jest.Mock; transaction: jest.Mock };
  let cleanup: { deleteExportFile: jest.Mock };
  let calls: Call[];

  const build = async (responder: (sql: string, params: any[]) => any[]) => {
    const fake = makeClient(responder);
    calls = fake.calls;
    db = {
      query: jest.fn(async (sql: string, params: any[] = []) => ({ rows: responder(sql, params) })),
      transaction: jest.fn(async (fn: any) => fn(fake.client)),
    };
    cleanup = { deleteExportFile: jest.fn(() => true) };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        WorkflowTransactionService,
        { provide: DbService, useValue: db },
        { provide: FileCleanupService, useValue: cleanup },
      ],
    }).compile();
    service = mod.get(WorkflowTransactionService);
  };

  afterEach(() => service?.onModuleDestroy());

  describe('补偿动作服务端推导', () => {
    const stepInserts = () => calls.filter(c => c.sql.includes('INSERT INTO jz_workflow_steps'));

    it('已知产文件工具推导出删除补偿，未知工具无补偿', async () => {
      await build(() => [{ workflow_id: 'wf_1', status: WorkflowStatus.PENDING, context: {} }]);

      await service.createWorkflow('a1', 'cw1', 'u1', {
        workflowType: 'report',
        steps: [
          { stepNumber: 1, stepName: 's1', toolName: 'export_excel', inputParams: {} },
          { stepNumber: 2, stepName: 's2', toolName: 'generate_pdf', inputParams: {} },
          { stepNumber: 3, stepName: 's3', toolName: 'search_db_schema', inputParams: {} },
        ],
      });

      expect(stepInserts().map(c => c.params[5])).toEqual([
        COMPENSATION_DELETE_FILE,
        COMPENSATION_DELETE_FILE,
        null,
      ]);
    });

    it('忽略调用方传入的 compensation_tool', async () => {
      await build(() => [{ workflow_id: 'wf_1', status: WorkflowStatus.PENDING, context: {} }]);

      await service.createWorkflow('a1', 'cw1', 'u1', {
        workflowType: 'report',
        steps: [
          {
            stepNumber: 1,
            stepName: 's1',
            toolName: 'search_db_schema',
            inputParams: {},
            compensationTool: 'send_email',
            compensationParams: { to: 'attacker@example.com' },
          } as any,
        ],
      });

      const insert = stepInserts()[0];
      expect(insert.params[5]).toBeNull();
      expect(insert.params[6]).toBeNull();
    });
  });

  describe('compensateWorkflow', () => {
    const compensableStep = {
      id: 'st1',
      step_number: 2,
      step_name: 's2',
      status: StepStatus.COMPLETED,
      compensation_tool: COMPENSATION_DELETE_FILE,
      output_file_id: '1_ab_report.xlsx',
    };

    it('删除已完成步骤的产出文件并置为 compensated', async () => {
      await build((sql) => {
        if (sql.includes('FROM jz_workflow_transactions')) return [{ workflow_id: 'wf_1', user_id: 'u1', status: WorkflowStatus.RUNNING }];
        if (sql.includes('FROM jz_workflow_steps')) return [compensableStep];
        if (sql.includes('FROM jz_workflow_attachments')) return [{ file_id: '1_ab_doc.pdf' }];
        return [];
      });

      const count = await service.compensateWorkflow('wf_1', '步骤 3 失败', 3);

      expect(count).toBe(1);
      expect(cleanup.deleteExportFile.mock.calls).toEqual([
        ['u1', '1_ab_report.xlsx'],
        ['u1', '1_ab_doc.pdf'],
      ]);
      const final = calls.find(c => c.sql.includes('UPDATE jz_workflow_transactions') && c.sql.includes('compensated_at'));
      expect(final?.params[1]).toBe(WorkflowStatus.COMPENSATED);
    });

    it('步骤查询与工作流查询都在事务内加锁', async () => {
      await build((sql) => {
        if (sql.includes('FROM jz_workflow_transactions')) return [{ workflow_id: 'wf_1', user_id: 'u1', status: WorkflowStatus.RUNNING }];
        return [];
      });

      await service.compensateWorkflow('wf_1', 'x');

      expect(db.transaction).toHaveBeenCalledTimes(1);
      // 所有 SQL 都走事务 client，不得旁路 this.db
      expect(db.query).not.toHaveBeenCalled();
      const locked = calls.filter(c => c.sql.includes('FOR UPDATE'));
      expect(locked).toHaveLength(2);
    });

    it('已补偿的工作流重复调用是幂等的', async () => {
      await build((sql) => {
        if (sql.includes('FROM jz_workflow_transactions')) return [{ workflow_id: 'wf_1', user_id: 'u1', status: WorkflowStatus.COMPENSATED }];
        return [];
      });

      expect(await service.compensateWorkflow('wf_1', 'x')).toBe(0);
      expect(cleanup.deleteExportFile).not.toHaveBeenCalled();
      expect(calls.filter(c => c.sql.trim().startsWith('UPDATE'))).toHaveLength(0);
    });
  });

  describe('failWorkflow', () => {
    it('不覆盖已补偿的终态', async () => {
      await build((sql) => {
        // 守卫命中：UPDATE 不返回行；随后 getWorkflow 读到既有状态
        if (sql.includes('UPDATE jz_workflow_transactions')) return [];
        return [{ workflow_id: 'wf_1', status: WorkflowStatus.COMPENSATED, context: {} }];
      });

      const wf = await service.failWorkflow('wf_1', '步骤失败');

      expect(wf.status).toBe(WorkflowStatus.COMPENSATED);
      const update = db.query.mock.calls.find(c => c[0].includes('UPDATE jz_workflow_transactions'));
      expect(update[0]).toContain('status NOT IN');
    });
  });
});
