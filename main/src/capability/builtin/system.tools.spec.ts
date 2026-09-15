import { SystemToolProvider } from './system.tools';

// Mock dependencies
const mockAutomationService = {
  getParseAttachmentTool: jest.fn().mockReturnValue({
    name: 'parse_attachment',
    description: '附件解析\n解析上传附件',
    execute: jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'parsed' }],
      parsedData: {},
      rawFields: {},
    }),
  }),
};

const mockContextManager = {
  getPageContext: jest.fn().mockReturnValue({ panel: 'dashboard', title: '仪表盘', nav: 'dashboard' }),
  loadPageMemory: jest.fn().mockResolvedValue({}),
  savePageMemory: jest.fn().mockResolvedValue(undefined),
};

const mockAgentRegistry = {};

const mockType = {
  Object: (schema: any) => schema,
  String: (opts?: any) => ({ type: 'string', ...opts }),
  Number: (opts?: any) => ({ type: 'number', ...opts }),
  Optional: (t: any) => ({ ...t, optional: true }),
  Record: (k: any, v: any) => ({ type: 'record', key: k, value: v }),
};

describe('SystemToolProvider', () => {
  let provider: SystemToolProvider;

  beforeEach(() => {
    provider = new SystemToolProvider(
      mockAutomationService as any,
      mockContextManager as any,
      mockAgentRegistry as any,
    );
  });

  test('toolIds lists all system tools', () => {
    expect(provider.toolIds).toEqual([
      'read', 'edit', 'write', 'bash', 'grep', 'find', 'ls',
      'ui_control', 'code_execution', 'coding_agent', 'attachment',
    ]);
  });

  test('getCatalog returns entries with group 内置', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(11);
    for (const entry of catalog) {
      expect(entry.group).toBe('内置');
      expect(entry.id).toBeTruthy();
      expect(entry.label).toBeTruthy();
    }
    expect(catalog.map(c => c.id)).toEqual(provider.toolIds);
  });

  test('createTools wraps coding tools from ctx.piAi', async () => {
    const mockReadTool = {
      name: 'read',
      description: 'Read a file',
      parameters: {},
      execute: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'file content' }] }),
    };
    const mockBashTool = {
      name: 'bash',
      description: 'Run bash',
      parameters: {},
      execute: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
    };

    const tools = await provider.createTools({
      userId: 'user1',
      piAi: { Type: mockType, codingTools: [mockReadTool, mockBashTool] },
    });

    const names = tools.map(t => t.name);
    expect(names).toContain('read');
    expect(names).toContain('bash');
    expect(names).toContain('ui_control');
    expect(names).toContain('code_execution');
    expect(names).toContain('coding_agent');
    expect(names).toContain('parse_attachment');
  });

  test('read tool blocks binary files', async () => {
    const mockReadTool = {
      name: 'read',
      description: 'Read a file',
      parameters: {},
      execute: jest.fn(),
    };

    const tools = await provider.createTools({
      piAi: { Type: mockType, codingTools: [mockReadTool] },
    });

    const readTool = tools.find(t => t.name === 'read')!;
    const result = await readTool.execute('call1', { path: '/tmp/report.pdf' });
    expect(result.content[0].text).toContain('二进制文件');
    expect(mockReadTool.execute).not.toHaveBeenCalled();
  });

  test('createTools returns attachment even without piAi.Type', async () => {
    const tools = await provider.createTools({ piAi: {} });
    const names = tools.map(t => t.name);
    expect(names).toContain('parse_attachment');
    // Without Type, no ui_control / code_execution / coding_agent
    expect(names).not.toContain('ui_control');
  });
});
