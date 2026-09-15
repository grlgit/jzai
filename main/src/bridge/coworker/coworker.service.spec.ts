import { Test, TestingModule } from '@nestjs/testing';
import { CoWorkerService } from './coworker.service';
import { DbService } from '../../db/db.service';
import { EditionService } from '../../edition/edition.service';

describe('CoWorkerService', () => {
  let service: CoWorkerService;
  let mockDb: { query: jest.Mock };

  beforeEach(async () => {
    mockDb = { query: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CoWorkerService,
        { provide: DbService, useValue: mockDb },
        { provide: EditionService, useValue: {} },
      ],
    }).compile();

    service = module.get<CoWorkerService>(CoWorkerService);
  });

  describe('getAuthorizedTools / invalidateToolsCache', () => {
    it('缓存未命中时查询数据库并写入缓存', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ coworker_id: 'cw-1', tools: JSON.stringify(['tool:a', 'tool:b']) }],
      });

      const tools = await service.getAuthorizedTools('assign-1');
      expect(tools).toEqual(['tool:a', 'tool:b']);
      expect(mockDb.query).toHaveBeenCalledTimes(1);

      const cached = await service.getAuthorizedTools('assign-1');
      expect(cached).toEqual(['tool:a', 'tool:b']);
      expect(mockDb.query).toHaveBeenCalledTimes(1); // 命中缓存
    });

    it('按 coworkerId 精准失效，不影响其它 CoWorker 的缓存', async () => {
      // Seed cache for two coworkers
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ coworker_id: 'cw-1', tools: JSON.stringify(['tool:a']) }] })
        .mockResolvedValueOnce({ rows: [{ coworker_id: 'cw-2', tools: JSON.stringify(['tool:b']) }] });

      await service.getAuthorizedTools('assign-1'); // cw-1
      await service.getAuthorizedTools('assign-2'); // cw-2
      expect(mockDb.query).toHaveBeenCalledTimes(2);

      service.invalidateToolsCache('cw-1');

      // cw-1 cache should be gone
      mockDb.query.mockResolvedValueOnce({ rows: [{ coworker_id: 'cw-1', tools: JSON.stringify(['tool:a2']) }] });
      const tools1 = await service.getAuthorizedTools('assign-1');
      expect(tools1).toEqual(['tool:a2']);
      expect(mockDb.query).toHaveBeenCalledTimes(3);

      // cw-2 cache should still be valid
      const tools2 = await service.getAuthorizedTools('assign-2');
      expect(tools2).toEqual(['tool:b']);
      expect(mockDb.query).toHaveBeenCalledTimes(3); // 未再次查询
    });

    it('无 coworkerId 时清空全部缓存', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ coworker_id: 'cw-1', tools: JSON.stringify(['tool:a']) }] })
        .mockResolvedValueOnce({ rows: [{ coworker_id: 'cw-2', tools: JSON.stringify(['tool:b']) }] });

      await service.getAuthorizedTools('assign-1');
      await service.getAuthorizedTools('assign-2');

      service.invalidateToolsCache();

      mockDb.query
        .mockResolvedValueOnce({ rows: [{ coworker_id: 'cw-1', tools: JSON.stringify(['tool:a']) }] })
        .mockResolvedValueOnce({ rows: [{ coworker_id: 'cw-2', tools: JSON.stringify(['tool:b']) }] });

      await service.getAuthorizedTools('assign-1');
      await service.getAuthorizedTools('assign-2');
      expect(mockDb.query).toHaveBeenCalledTimes(4);
    });

    it('失效不存在的 coworkerId 不报错', async () => {
      expect(() => service.invalidateToolsCache('non-existent')).not.toThrow();
    });
  });
});
