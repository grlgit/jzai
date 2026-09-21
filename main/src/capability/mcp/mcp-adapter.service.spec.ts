import { createInvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import { McpAdapterService } from './mcp-adapter.service';
import { McpRunnerService } from './mcp-runner.service';

const mockType = {
  Object: (props: any) => ({ type: 'object', properties: props }),
  String: (opts?: any) => ({ type: 'string', ...opts }),
  Number: () => ({ type: 'number' }),
  Boolean: () => ({ type: 'boolean' }),
  Any: () => ({ type: 'any' }),
  Optional: (t: any) => ({ ...t, optional: true }),
};

const defaultServer = {
  name: 'test_mcp',
  description: 'A test MCP',
  handlerCode: 'async function execute(ctx) { return { message: "ok" }; }',
  tools: [
    { name: 'query', description: 'Run query', inputSchema: { properties: { sql: { type: 'string' } }, required: ['sql'] } },
  ],
  authFields: [],
  enabled: true,
};

let enabledList: any[] = [];
const mockMcpRegistry = {
  isAllowedForUser: jest.fn().mockReturnValue(true),
  getEnabled: jest.fn(() => enabledList),
  get: jest.fn((name: string) => enabledList.find((m: any) => m.name === name)),
};

const mockCredentialService = {
  resolveCredentials: jest.fn().mockReturnValue({}),
};

describe('McpAdapterService', () => {
  let service: McpAdapterService;

  beforeEach(() => {
    jest.clearAllMocks();
    enabledList = [defaultServer];
    mockMcpRegistry.isAllowedForUser.mockReturnValue(true);
    service = new McpAdapterService(
      mockMcpRegistry as any,
      new McpRunnerService(mockMcpRegistry as any, mockCredentialService as any),
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
    enabledList = [{ name: 'empty_mcp', tools: [], handlerCode: 'code' }];
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    expect(tools).toHaveLength(0);
  });

  test('createTools skips MCPs with no handlerCode', async () => {
    enabledList = [{ name: 'no_handler', tools: [{ name: 't', description: 'd', inputSchema: {} }], handlerCode: null }];
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    expect(tools).toHaveLength(0);
  });

  test('filters connectors that deny the current user and roles', async () => {
    mockMcpRegistry.isAllowedForUser.mockReturnValue(false);

    const tools = await service.createTools({
      principal: {
        type: 'user',
        principalId: 'user:u1',
        userId: 'u1',
        roleIds: ['planner'],
        departmentIds: [],
        permissions: [],
        scopes: [],
        origin: 'test',
        issuedAt: Date.now(),
      },
      piAi: { Type: mockType },
    });

    expect(tools).toHaveLength(0);
    expect(mockMcpRegistry.isAllowedForUser).toHaveBeenCalledWith('test_mcp', 'u1', ['planner']);
  });

  test('reauthorizes at execution time after permission revocation', async () => {
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    mockMcpRegistry.isAllowedForUser.mockReturnValue(false);

    const result = await tools[0].execute('mcp_test_mcp_query', { sql: 'SELECT 1' });

    expect(result.details.__error.code).toBe('FORBIDDEN');
  });

  test('allows only the exact connector tool capability for a service principal', async () => {
    mockMcpRegistry.isAllowedForUser.mockReturnValue(false);
    const exactPrincipal = createInvocationPrincipal({
      type: 'service',
      principalId: 'service:sp-1',
      servicePrincipalId: 'sp-1',
      scopes: ['mcp:test_mcp:query:invoke'],
      origin: 'binding:test',
      issuedAt: Date.now(),
    });

    const tools = await service.createTools({
      principal: exactPrincipal,
      piAi: { Type: mockType },
    });

    expect(tools).toHaveLength(1);
    await expect(tools[0].execute('mcp_test_mcp_query', { sql: 'SELECT 1' }))
      .resolves.toEqual(expect.objectContaining({
        content: [{ type: 'text', text: 'ok' }],
      }));
  });

  test('rejects a service principal capability for a different connector tool', async () => {
    mockMcpRegistry.isAllowedForUser.mockReturnValue(false);
    const unrelatedPrincipal = createInvocationPrincipal({
      type: 'service',
      principalId: 'service:sp-1',
      servicePrincipalId: 'sp-1',
      scopes: ['mcp:test_mcp:other:invoke'],
      origin: 'binding:test',
      issuedAt: Date.now(),
    });

    await expect(service.createTools({
      principal: unrelatedPrincipal,
      piAi: { Type: mockType },
    })).resolves.toHaveLength(0);
  });

  test('returns a structured error when a connector reports failure', async () => {
    enabledList = [{
      name: 'test_mcp',
      handlerCode: 'async function execute() { return { success: false, code: "REMOTE_DENIED", message: "denied" }; }',
      tools: [{ name: 'query', description: 'Run query', inputSchema: { properties: {} } }],
      authFields: [],
      enabled: true,
    }];
    const [tool] = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });

    const result = await tool.execute('mcp_test_mcp_query', {});

    expect(result.details.__error).toEqual({
      code: 'REMOTE_DENIED',
      message: 'denied',
    });
  });

  test('returns a structured error when a connector handler throws', async () => {
    enabledList = [{
      name: 'test_mcp',
      handlerCode: 'async function execute() { throw new Error("network down"); }',
      tools: [{ name: 'query', description: 'Run query', inputSchema: { properties: {} } }],
      authFields: [],
      enabled: true,
    }];
    const [tool] = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });

    const result = await tool.execute('mcp_test_mcp_query', {});

    expect(result.details.__error).toEqual({
      code: 'MCP_EXECUTION_ERROR',
      message: 'network down',
    });
  });

  test('returns friendly message when credentials are missing', async () => {
    enabledList = [{
      name: 'test_mcp',
      handlerCode: 'async function execute() { return { message: "ok" }; }',
      tools: [{ name: 'query', description: 'Run query', inputSchema: { properties: {} } }],
      authFields: [{ key: 'api_key', label: 'API Key' }],
      enabled: true,
    }];
    mockCredentialService.resolveCredentials.mockReturnValue({});
    const [tool] = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });

    const result = await tool.execute('mcp_test_mcp_query', {});

    expect(result.details).toBeNull();
    expect(result.content[0].text).toContain('[凭证缺失]');
    expect(result.content[0].text).toContain('API Key');
  });
});
