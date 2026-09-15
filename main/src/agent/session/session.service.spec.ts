import { Test, TestingModule } from '@nestjs/testing';
import { SessionService } from './session.service';
import { DbService } from '../../db/db.service';
import { ModelRouterService } from '../../model-router/model-router.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import { KbService } from '../../bridge/knowledge/kb.service';

describe('SessionService', () => {
  let service: SessionService;
  let mockDb: {
    query: jest.Mock;
    transaction: jest.Mock;
  };
  let transactionQueries: any[];

  beforeEach(async () => {
    transactionQueries = [];
    mockDb = {
      query: jest.fn().mockResolvedValue({ rows: [] }),
      transaction: jest.fn(async (fn: any) => {
        const client = {
          query: jest.fn(async (...args: any[]) => {
            transactionQueries.push(args);
            return { rows: [] };
          }),
        };
        return fn(client);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SessionService,
        { provide: DbService, useValue: mockDb },
        { provide: ModelRouterService, useValue: {} },
        { provide: WorkspaceService, useValue: {} },
        { provide: KbService, useValue: {} },
      ],
    }).compile();

    service = module.get<SessionService>(SessionService);
  });

  describe('saveUserMessage', () => {
    it('在事务中插入消息并更新会话 updated_at', async () => {
      await service.saveUserMessage('session-1', 'hello');
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(transactionQueries[0][0]).toMatch(/INSERT INTO jz_messages/);
      expect(transactionQueries[0][1]).toContain('user');
      expect(transactionQueries[1][0]).toMatch(/UPDATE jz_sessions SET updated_at/);
    });

    it('titleCandidate 存在时条件写入 title', async () => {
      const longTitle = 'a'.repeat(100);
      await service.saveUserMessage('session-1', 'hello world', longTitle);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      const updateQuery = transactionQueries[1][0];
      const updateParams = transactionQueries[1][1];
      expect(updateQuery).toMatch(/COALESCE\(title, \$1\)/);
      expect(updateParams[0]).toHaveLength(50);
      expect(updateParams[0]).toBe(longTitle.substring(0, 50));
    });

    it('titleCandidate 不存在时不尝试写入 title', async () => {
      await service.saveUserMessage('session-1', 'hello');
      const updateQuery = transactionQueries[1][0];
      expect(updateQuery).not.toMatch(/COALESCE/);
    });
  });
});
