import { McpAdapterService } from './mcp-adapter.service';

const mockType = {
  Object: (props: any) => ({ type: 'object', properties: props }),
  String: (opts?: any) => ({ type: 'string', ...opts }),
  Number: () => ({ type: 'number' }),
  Boolean: () => ({ type: 'boolean' }),
  Any: () => ({ type: 'any' }),
  Optional: (t: any) => ({ ...t, optional: true }),
};

const mockMcpRegistry = {
  getEnabled: jest.fn().mockReturnValue([
    {
      name: 'test_mcp',
      description: 'A test MCP',
      handlerCode: 'async function execute(ctx) { return { message: "ok" }; }',
      tools: [
        { name: 'query', description: 'Run query', inputSchema: { properties: { sql: { type: 'string' } }, required: ['sql'] } },
      ],
      authFields: [],
      enabled: true,
    },
  ]),
};

const mockCredentialService = {
  resolveCredentials: jest.fn().mockReturnValue({}),
};

describe('McpAdapterService', () => {
  let service: McpAdapterService;

  beforeEach(() => {
    service = new McpAdapterService(
      mockMcpRegistry as any,
      mockCredentialService as any,
    );
  });

  test('toolIds contains "mcp"', () => {
    expect(service.toolIds).toEqual(['mcp']);
  });

  test('getCatalog returns MCP connector entry', () => {
    const catalog = service.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({ id: 'mcp', label: 'MCP Connectors', group: '连接' });
  });

  test('createTools returns empty when no Type in context', async () => {
    const tools = await service.createTools({ userId: 'u1' });
    expect(tools).toEqual([]);
  });

  test('createTools builds mcp_* prefixed tools from registry', async () => {
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].name).toBe('mcp_test_mcp_query');
    expect(tools[0].label).toBe('test_mcp: Run query');
    expect(typeof tools[0].execute).toBe('function');
  });

  test('createTools skips MCPs with no tools', async () => {
    mockMcpRegistry.getEnabled.mockReturnValueOnce([
      { name: 'empty_mcp', tools: [], handlerCode: 'code' },
    ]);
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    expect(tools).toHaveLength(0);
  });

  test('createTools skips MCPs with no handlerCode', async () => {
    mockMcpRegistry.getEnabled.mockReturnValueOnce([
      { name: 'no_handler', tools: [{ name: 't', description: 'd', inputSchema: {} }], handlerCode: null },
    ]);
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    expect(tools).toHaveLength(0);
  });
});
