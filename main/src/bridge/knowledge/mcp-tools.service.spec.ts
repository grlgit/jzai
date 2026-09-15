import { Test, TestingModule } from '@nestjs/testing';
import { McpToolsService } from './mcp-tools.service';
import { AppConfigService } from '../../config/app-config.service';

describe('McpToolsService', () => {
  let service: McpToolsService;
  let mockClient: { callTool: jest.Mock };

  const mockAppConfig = {
    get: jest.fn((key: string, fallback?: any) => {
      if (key === 'knowledgeBase.slug') return 'default';
      return fallback;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        McpToolsService,
        { provide: AppConfigService, useValue: mockAppConfig },
      ],
    }).compile();

    service = module.get<McpToolsService>(McpToolsService);
    mockClient = { callTool: jest.fn() };
    (service as any).mcpClient = mockClient;
    (service as any).connected = true;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('knowledge layer cache', () => {
    it('fetchKnowledgeDigest 缓存命中时不调用 MCP', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'digest content' }],
      });

      const r1 = await service.fetchKnowledgeDigest();
      expect(r1).toBe('digest content');
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);

      const r2 = await service.fetchKnowledgeDigest();
      expect(r2).toBe('digest content');
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);
    });

    it('fetchCharacterLayer 缓存命中时不调用 MCP', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'character content' }],
      });

      const r1 = await service.fetchCharacterLayer();
      expect(r1).toBe('character content');
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);

      const r2 = await service.fetchCharacterLayer();
      expect(r2).toBe('character content');
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);
    });

    it('fetchRulesLayer 缓存命中时不调用 MCP', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'rules content' }],
      });

      const r1 = await service.fetchRulesLayer();
      expect(r1).toBe('rules content');
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);

      const r2 = await service.fetchRulesLayer();
      expect(r2).toBe('rules content');
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);
    });

    it('缓存过期后重新请求', async () => {
      mockClient.callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'old digest' }],
      });
      await service.fetchKnowledgeDigest();

      jest.advanceTimersByTime(5 * 60 * 1000 + 1);

      mockClient.callTool.mockResolvedValueOnce({
        content: [{ type: 'text', text: 'new digest' }],
      });
      const r = await service.fetchKnowledgeDigest();
      expect(r).toBe('new digest');
      expect(mockClient.callTool).toHaveBeenCalledTimes(2);
    });

    it('写入 wiki 路径后自动清空缓存', async () => {
      mockClient.callTool
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'digest' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'written' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'digest' }] });

      await service.fetchKnowledgeDigest();
      expect(mockClient.callTool).toHaveBeenCalledTimes(1);

      await service.callTool('write', { path: '/wiki/_rules/test.md', content: 'x' });

      const r = await service.fetchKnowledgeDigest();
      expect(r).toBe('digest');
      expect(mockClient.callTool).toHaveBeenCalledTimes(3);
    });

    it('写入非 wiki 路径不清空缓存', async () => {
      mockClient.callTool
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'digest' }] })
        .mockResolvedValueOnce({ content: [{ type: 'text', text: 'written' }] });

      await service.fetchKnowledgeDigest();
      await service.callTool('write', { path: '/sources/doc.md', content: 'x' });

      const r = await service.fetchKnowledgeDigest();
      expect(r).toBe('digest');
      expect(mockClient.callTool).toHaveBeenCalledTimes(2);
    });

    it('显式调用 invalidateKnowledgeLayerCache 清空缓存', async () => {
      mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'digest' }] });
      await service.fetchKnowledgeDigest();
      service.invalidateKnowledgeLayerCache();
      await service.fetchKnowledgeDigest();
      expect(mockClient.callTool).toHaveBeenCalledTimes(2);
    });

    it('callTool 将 scopes 作为 arguments.scopes 传给 MCP', async () => {
      mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      await service.callTool('search', { query: 'x' }, ['cat-1']);
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: 'search',
        arguments: { query: 'x', scopes: ['cat-1'] },
      });
    });

    it('callTool 将 ADMIN_ALL 包装为单元素数组传给 MCP', async () => {
      mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      await service.callTool('search', { query: 'x' }, 'ADMIN_ALL');
      expect(mockClient.callTool).toHaveBeenCalledWith({
        name: 'search',
        arguments: { query: 'x', scopes: ['ADMIN_ALL'] },
      });
    });
  });
});
