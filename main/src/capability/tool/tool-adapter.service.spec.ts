import { ToolAdapterService } from './tool-adapter.service';

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
  getEnabled: jest.fn().mockReturnValue([
    {
      name: 'my_tool',
      description: 'A test tool',
      handlerCode: 'async function execute(ctx) { return { message: "ok" }; }',
      parameters: [{ name: 'input', type: 'string', required: true }],
      authFields: [],
      confirm: false,
    },
  ]),
};

const mockCredentialService = {
  resolveCredentials: jest.fn().mockReturnValue({}),
};

const mockConfirmBridge = {
  requestConfirmation: jest.fn(),
};

describe('ToolAdapterService', () => {
  let service: ToolAdapterService;

  beforeEach(() => {
    service = new ToolAdapterService(
      mockToolRegistry as any,
      mockCredentialService as any,
      mockConfirmBridge as any,
    );
  });

  test('toolIds contains "tools"', () => {
    expect(service.toolIds).toEqual(['tools']);
  });

  test('getCatalog returns tool connector entry', () => {
    const catalog = service.getCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toEqual({ id: 'tools', label: 'Tool Connectors', group: '连接' });
  });

  test('createTools returns empty when no Type in context', async () => {
    const tools = await service.createTools({ userId: 'u1' });
    expect(tools).toEqual([]);
  });

  test('createTools builds tool_* prefixed tools from registry', async () => {
    const tools = await service.createTools({ userId: 'u1', piAi: { Type: mockType } });
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools[0].name).toBe('tool_my_tool');
    expect(tools[0].description).toContain('A test tool');
    expect(typeof tools[0].execute).toBe('function');
  });
});
