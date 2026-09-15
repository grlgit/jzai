import { ConnectorToolProvider } from './connector.tools';

const mockType = {
  Object: (props: any) => ({ type: 'object', properties: props }),
  String: (opts?: any) => ({ type: 'string', ...opts }),
  Number: () => ({ type: 'number' }),
  Boolean: () => ({ type: 'boolean' }),
  Any: () => ({ type: 'any' }),
  Optional: (t: any) => ({ ...t, optional: true }),
  Record: (k: any, v: any) => ({ type: 'record' }),
};

const mockToolRegistry = {
  get: jest.fn(),
  getAll: jest.fn().mockReturnValue([]),
  loadAll: jest.fn(),
};

const mockMcpRegistry = {
  get: jest.fn(),
  getAll: jest.fn().mockReturnValue([]),
  getManifestYaml: jest.fn(),
  loadAll: jest.fn(),
};

const mockCredentialService = {
  resolveCredentials: jest.fn().mockReturnValue({}),
};

const mockHarAnalyzer = {
  analyze: jest.fn(),
};

const mockAgentPool = {
  keys: jest.fn().mockReturnValue([]),
  getSessionId: jest.fn(),
  clear: jest.fn(),
  clearExcept: jest.fn(),
};

const mockSessionService = {
  bindSkill: jest.fn(),
};

describe('ConnectorToolProvider', () => {
  let provider: ConnectorToolProvider;

  beforeEach(() => {
    provider = new ConnectorToolProvider(
      mockToolRegistry as any,
      mockMcpRegistry as any,
      mockCredentialService as any,
      mockHarAnalyzer as any,
      mockAgentPool as any,
      mockSessionService as any,
    );
  });

  test('toolIds lists all six tool factory IDs', () => {
    expect(provider.toolIds).toEqual([
      'test_connector', 'reload_connectors', 'mcp_health_check',
      'analyze_har', 'github', 'webhooks',
    ]);
  });

  test('getCatalog returns entries with group "连接"', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(6);
    expect(catalog.every(c => c.group === '连接')).toBe(true);
    expect(catalog.map(c => c.id)).toEqual([
      'test_connector', 'reload_connectors', 'mcp_health_check',
      'analyze_har', 'github', 'webhooks',
    ]);
  });

  test('createTools returns empty when no Type in context', async () => {
    const tools = await provider.createTools({ userId: 'u1' });
    expect(tools).toEqual([]);
  });

  test('createTools builds all expected tool instances', async () => {
    const tools = await provider.createTools({ userId: 'u1', piAi: { Type: mockType } });
    const names = tools.map(t => t.name);
    expect(names).toContain('test_connector');
    expect(names).toContain('reload_connectors');
    expect(names).toContain('mcp_health_check');
    expect(names).toContain('analyze_har');
    expect(names).toContain('github_action');
    expect(names).toContain('webhook_register');
    for (const t of tools) {
      expect(typeof t.execute).toBe('function');
    }
  });

  test('reload_connectors clears agent pool', async () => {
    const tools = await provider.createTools({ userId: 'u1', piAi: { Type: mockType } });
    const reloadTool = tools.find(t => t.name === 'reload_connectors')!;
    await reloadTool.execute('id', {});
    expect(mockToolRegistry.loadAll).toHaveBeenCalled();
    expect(mockMcpRegistry.loadAll).toHaveBeenCalled();
    expect(mockAgentPool.clear).toHaveBeenCalled();
  });

  test('test_connector returns not found for unknown name', async () => {
    mockToolRegistry.get.mockReturnValue(null);
    mockMcpRegistry.get.mockReturnValue(null);
    const tools = await provider.createTools({ userId: 'u1', piAi: { Type: mockType } });
    const testTool = tools.find(t => t.name === 'test_connector')!;
    const result = await testTool.execute('id', { name: 'nonexistent' });
    expect(result.content[0].text).toContain('未找到连接');
  });

  test('mcp_health_check returns message when no servers', async () => {
    mockMcpRegistry.getAll.mockReturnValueOnce([]);
    const tools = await provider.createTools({ userId: 'u1', piAi: { Type: mockType } });
    const healthTool = tools.find(t => t.name === 'mcp_health_check')!;
    const result = await healthTool.execute('id', {});
    expect(result.content[0].text).toContain('当前没有注册任何 MCP Server');
  });
});
