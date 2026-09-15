import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EditionService } from './edition.service';
import { DbService } from '../db/db.service';
import { AnalyticsService } from '../platform/analytics/analytics.service';

describe('EditionService', () => {
  let service: EditionService;
  let fetchSpy: jest.SpyInstance;

  const mockConfig = {
    get: jest.fn((key: string, fallback?: any) => {
      if (key === 'JIANZHI_WEBSITE_URL') return 'http://test.example';
      return fallback;
    }),
  };

  const mockDb = {
    query: jest.fn().mockResolvedValue({ rows: [] }),
  };

  const mockAnalytics = {
    track: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EditionService,
        { provide: ConfigService, useValue: mockConfig },
        { provide: DbService, useValue: mockDb },
        { provide: AnalyticsService, useValue: mockAnalytics },
      ],
    }).compile();

    service = module.get<EditionService>(EditionService);
    (service as any).installation = { installationToken: 'test-token' };

    fetchSpy = jest.spyOn(global, 'fetch').mockReset();
    jest.useFakeTimers();
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
  });

  describe('syncCredits', () => {
    it('未注册时返回 0 且不请求网络', async () => {
      (service as any).installation = null;
      const balance = await service.syncCredits();
      expect(balance).toBe(0);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('首次调用请求网络并缓存结果', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 100 }),
      } as any);

      const balance1 = await service.syncCredits();
      expect(balance1).toBe(100);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const balance2 = await service.syncCredits();
      expect(balance2).toBe(100);
      expect(fetchSpy).toHaveBeenCalledTimes(1); // 命中缓存，不再请求
    });

    it('缓存过期后重新请求', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 100 }),
      } as any);

      await service.syncCredits();
      jest.advanceTimersByTime(61 * 1000); // 超过 60s TTL

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 50 }),
      } as any);

      const balance = await service.syncCredits();
      expect(balance).toBe(50);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('force=true 时跳过缓存直接请求', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 100 }),
      } as any);
      await service.syncCredits();

      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 80 }),
      } as any);

      const balance = await service.syncCredits(true);
      expect(balance).toBe(80);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('负余额使用更长缓存时间', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: -10 }),
      } as any);

      await service.syncCredits();
      jest.advanceTimersByTime(61 * 1000); // 超过正常 TTL，但未超过负余额 TTL

      const balance = await service.syncCredits();
      expect(balance).toBe(-10);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(4 * 60 * 1000); // 总计超过 5 分钟
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 20 }),
      } as any);

      const balance2 = await service.syncCredits();
      expect(balance2).toBe(20);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('网络失败时返回缓存值', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 100 }),
      } as any);
      await service.syncCredits();

      fetchSpy.mockRejectedValueOnce(new Error('network error'));
      const balance = await service.syncCredits(true);
      expect(balance).toBe(100); // 使用缓存值而不是 0
    });

    it('并发调用只发出一次网络请求', async () => {
      let resolveFetch: (value: any) => void;
      const fetchPromise = new Promise<any>(resolve => { resolveFetch = resolve; });
      fetchSpy.mockReturnValueOnce(fetchPromise);

      const promise1 = service.syncCredits();
      const promise2 = service.syncCredits();
      const promise3 = service.syncCredits(true);

      resolveFetch!({ ok: true, text: async () => JSON.stringify({ balance: 42 }) } as any);

      const [b1, b2, b3] = await Promise.all([promise1, promise2, promise3]);
      expect(b1).toBe(42);
      expect(b2).toBe(42);
      expect(b3).toBe(42);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('token 变更后清空缓存', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 100 }),
      } as any);
      await service.syncCredits();

      (service as any).installation = { installationToken: 'new-token' };
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ balance: 200 }),
      } as any);

      const balance = await service.syncCredits();
      expect(balance).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });
  });
});
