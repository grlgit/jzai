import { ToolBridgeService } from './tool-bridge.service';
import { DynamicToolProviderRegistry } from './dynamic-tool-provider.registry';
import { ToolProvider, ToolContext } from './tool-provider.interface';
import {
  createInvocationPrincipal,
  createUserPrincipal,
} from '../../platform/app-store/runtime/invocation-principal';

const mockProvider: ToolProvider = {
  toolIds: ['mock_a', 'mock_b'],
  getCatalog: () => [
    { id: 'mock_a', label: 'Mock A', group: 'test' },
    { id: 'mock_b', label: 'Mock B', group: 'test' },
  ],
  createTools: async () => [
    { name: 'mock_a', description: 'A', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
    { name: 'mock_b', description: 'B', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
  ],
};

const largeOutputProvider: ToolProvider = {
  toolIds: ['large'],
  getCatalog: () => [{ id: 'large', label: 'Large', group: 'test' }],
  createTools: async () => [{
    name: 'large_tool', description: 'Returns large output', parameters: {},
    execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(50000) }] }),
  }],
};

describe('ToolBridgeService', () => {

  test('registers providers and builds lookup map', () => {
    const bridge = new ToolBridgeService([mockProvider]);
    expect(bridge.hasProvider('mock_a')).toBe(true);
    expect(bridge.hasProvider('mock_b')).toBe(true);
    expect(bridge.hasProvider('nonexistent')).toBe(false);
  });

  test('buildForAgent resolves tools from providers', async () => {
    const bridge = new ToolBridgeService([mockProvider]);
    await bridge.init({});
    const tools = await bridge.buildForAgent(['mock_a', 'mock_b'], {});
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('mock_a');
  });

  test('buildForAgent wraps with safety — truncates large output', async () => {
    const bridge = new ToolBridgeService([largeOutputProvider]);
    await bridge.init({});
    const tools = await bridge.buildForAgent(['large'], {}, 10000);
    const result = await tools[0].execute('id', {});
    expect(result.content[0].text.length).toBeLessThan(11000);
    expect(result.content[0].text).toContain('截断');
  });

  test('buildForAgent wraps with safety — catches errors', async () => {
    const errorProvider: ToolProvider = {
      toolIds: ['err'],
      getCatalog: () => [],
      createTools: async () => [{ name: 'err_tool', description: '', parameters: {}, execute: async () => { throw new Error('boom'); } }],
    };
    const bridge = new ToolBridgeService([errorProvider]);
    await bridge.init({});
    const tools = await bridge.buildForAgent(['err'], {});
    const result = await tools[0].execute('id', {});
    // P0-5: errors are now classified into structured codes
    expect(result.content[0].text).toContain('[EXECUTION_ERROR]');
    expect(result.content[0].text).toContain('boom');
    expect(result.details?.__error?.code).toBe('EXECUTION_ERROR');
    expect(result.details?.__error?.retryable).toBe(false);
  });

  test('getCatalog aggregates all providers', () => {
    const bridge = new ToolBridgeService([mockProvider]);
    expect(bridge.getCatalog()).toHaveLength(2);
  });

  test('handles empty/undefined providers', () => {
    const bridge = new ToolBridgeService([]);
    expect(bridge.getCatalog()).toEqual([]);
    expect(bridge.hasProvider('x')).toBe(false);
  });

  test('handles tool: and mcp: prefixed names', async () => {
    const toolsProvider: ToolProvider = {
      toolIds: ['tools'],
      getCatalog: () => [],
      createTools: async () => [
        { name: 'tool_erp_order', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
        { name: 'tool_erp_stock', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
      ],
    };
    const bridge = new ToolBridgeService([toolsProvider]);
    await bridge.init({});
    const tools = await bridge.buildForAgent(['tool:erp_order'], {});
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('tool_erp_order');
  });

  describe('dedup — duplicate tool name handling', () => {
    const systemProvider: ToolProvider = {
      toolIds: ['read', 'write', 'bash'],
      getCatalog: () => [],
      createTools: async () => [
        { name: 'read', description: 'Read a file', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'file content' }] }) },
        { name: 'write', description: 'Write a file', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'written' }] }) },
        { name: 'bash', description: 'Run command', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'output' }] }) },
      ],
    };

    const kbProvider: ToolProvider = {
      toolIds: ['knowledge'],
      getCatalog: () => [],
      createTools: async () => [
        { name: 'search_knowledge', description: 'KB search', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'kb result' }] }) },
        { name: 'read', description: 'Read from KB vault', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'vault doc' }] }) },
        { name: 'write', description: 'Write to KB vault', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'saved' }] }) },
      ],
    };

    test('first occurrence keeps original name, later duplicates get prefixed', async () => {
      const bridge = new ToolBridgeService([systemProvider, kbProvider]);
      await bridge.init({});
      const tools = await bridge.buildForAgent(['read', 'write', 'bash', 'knowledge'], {});
      const names = tools.map(t => t.name);
      expect(names).toContain('read');
      expect(names).toContain('write');
      expect(names).toContain('bash');
      expect(names).toContain('search_knowledge');
      expect(names).toContain('knowledge_read');
      expect(names).toContain('knowledge_write');
      // All names must be unique
      expect(new Set(names).size).toBe(names.length);
    });

    test('prefixed tools are still executable', async () => {
      const bridge = new ToolBridgeService([systemProvider, kbProvider]);
      await bridge.init({});
      const tools = await bridge.buildForAgent(['read', 'knowledge'], {});
      const originalRead = tools.find(t => t.name === 'read');
      const prefixedRead = tools.find(t => t.name === 'knowledge_read');
      expect(originalRead).toBeDefined();
      expect(prefixedRead).toBeDefined();
      const origResult = await originalRead!.execute('id', {});
      const prefixResult = await prefixedRead!.execute('id', {});
      expect(origResult.content[0].text).toBe('file content');
      expect(prefixResult.content[0].text).toBe('vault doc');
    });

    test('no collision when all tool names are unique', async () => {
      const bridge = new ToolBridgeService([mockProvider]);
      await bridge.init({});
      const tools = await bridge.buildForAgent(['mock_a'], {});
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('mock_a');
      expect(tools[1].name).toBe('mock_b');
    });

    test('order in agent config determines priority — first listed provider wins', async () => {
      const bridge = new ToolBridgeService([systemProvider, kbProvider]);
      await bridge.init({});
      // knowledge listed BEFORE read → kbProvider invoked first, its 'read' keeps original name
      const tools = await bridge.buildForAgent(['knowledge', 'read'], {});
      const kbRead = tools.find(t => t.name === 'read');
      const sysRead = tools.find(t => t.name === 'read_read');
      expect(kbRead).toBeDefined();
      expect(sysRead).toBeDefined();
      const kbResult = await kbRead!.execute('id', {});
      const sysResult = await sysRead!.execute('id', {});
      expect(kbResult.content[0].text).toBe('vault doc');
      expect(sysResult.content[0].text).toBe('file content');
    });
  });

  describe('caching', () => {
    test('同一 provider 在缓存有效期内只调用一次 createTools', async () => {
      const createTools = jest.fn().mockResolvedValue([
        { name: 'mock_a', description: 'A', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
      ]);
      const provider: ToolProvider = {
        toolIds: ['mock_a'],
        getCatalog: () => [],
        createTools,
      };
      const bridge = new ToolBridgeService([provider]);
      await bridge.init({});

      await bridge.buildForAgent(['mock_a'], { userId: 'u1' });
      await bridge.buildForAgent(['mock_a'], { userId: 'u1' });
      expect(createTools).toHaveBeenCalledTimes(1);

      // Different context → cache miss
      await bridge.buildForAgent(['mock_a'], { userId: 'u2' });
      expect(createTools).toHaveBeenCalledTimes(2);
    });

    test('provider 创建失败不污染缓存', async () => {
      const createTools = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([
        { name: 'mock_a', description: 'A', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) },
      ]);
      const provider: ToolProvider = {
        toolIds: ['mock_a'],
        getCatalog: () => [],
        createTools,
      };
      const bridge = new ToolBridgeService([provider]);
      await bridge.init({});

      const tools1 = await bridge.buildForAgent(['mock_a'], { userId: 'u1' });
      expect(tools1).toHaveLength(0);

      const tools2 = await bridge.buildForAgent(['mock_a'], { userId: 'u1' });
      expect(tools2).toHaveLength(1);
      expect(createTools).toHaveBeenCalledTimes(2);
    });

    test('MCP registry changes invalidate cached connector tools', async () => {
      const createTools = jest.fn().mockResolvedValue([
        { name: 'mcp_erp_query', description: 'ERP', parameters: {}, execute: async () => ({ content: [] }) },
      ]);
      const provider: ToolProvider = {
        toolIds: ['mcp'],
        getCatalog: () => [],
        createTools,
      };
      let notify: (() => void) | undefined;
      const mcpRegistry = {
        onChange: jest.fn((listener: () => void) => {
          notify = listener;
          return jest.fn();
        }),
      };
      const bridge = new ToolBridgeService(
        [provider],
        undefined,
        undefined,
        undefined,
        undefined,
        mcpRegistry as any,
      );
      await bridge.init({});

      await bridge.buildForAgent(['mcp'], { userId: 'u1' });
      await bridge.buildForAgent(['mcp'], { userId: 'u1' });
      notify!();
      await bridge.buildForAgent(['mcp'], { userId: 'u1' });

      expect(createTools).toHaveBeenCalledTimes(2);
    });
  });

  describe('dynamic registry', () => {
    test('registers dynamic providers and includes them in catalog', () => {
      const staticProvider: ToolProvider = {
        toolIds: ['static'],
        getCatalog: () => [{ id: 'static', label: 'Static', group: 'test' }],
        createTools: async () => [],
      };
      const dynamicProvider: ToolProvider = {
        toolIds: ['dynamic'],
        getCatalog: () => [{ id: 'dynamic', label: 'Dynamic', group: 'app' }],
        createTools: async () => [{ name: 'dynamic', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [dynamicProvider]);
      const bridge = new ToolBridgeService([staticProvider], registry);

      expect(bridge.hasProvider('static')).toBe(true);
      expect(bridge.hasProvider('dynamic')).toBe(true);
      expect(bridge.getCatalog()).toHaveLength(2);
    });

    test('dynamic tokenLimits override static provider limits', async () => {
      const staticProvider: ToolProvider = {
        toolIds: ['draw_parse'],
        tokenLimits: { draw_parse: 100000 },
        getCatalog: () => [],
        createTools: async () => [{ name: 'draw_parse', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(300000) }] }) }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [], { draw_parse: 8000 });
      const bridge = new ToolBridgeService([staticProvider], registry);
      await bridge.init({});

      const tools = await bridge.buildForAgent(['draw_parse'], {});
      const result = await tools[0].execute('id', {});
      // 8000 limit from registry should win over static 100000
      expect(result.content[0].text.length).toBeLessThan(9000);
    });

    test('E5 regression sentinel: skill_drawing_foo respects manifest tokenLimits, not prefix fallback', async () => {
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [], { skill_drawing_foo: 8000 });
      const bridge = new ToolBridgeService([], registry);
      await bridge.init({});

      const tool: any = { name: 'skill_drawing_foo', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(50000) }] }) };
      const wrapped = (bridge as any).wrapWithSafety([tool], 'user_1');
      const result = await wrapped[0].execute('id', {});
      expect(result.content[0].text.length).toBeLessThan(9000);
    });

    test('app-owned tool forbidden without grant', async () => {
      const dynamicProvider: ToolProvider = {
        toolIds: ['app_tool'],
        getCatalog: () => [],
        createTools: async () => [{ name: 'app_tool', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [dynamicProvider]);
      const bridge = new ToolBridgeService([], registry);
      await bridge.init({});

      const tools = await bridge.buildForAgent(['app_tool'], { userId: 'u1' });
      const result = await tools[0].execute('id', {});
      expect(result.content[0].text).toContain('Forbidden');
    });

    test('app-owned tool allowed for sys:admin', async () => {
      const dynamicProvider: ToolProvider = {
        toolIds: ['app_tool'],
        getCatalog: () => [],
        createTools: async () => [{ name: 'app_tool', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [dynamicProvider]);
      const userService = { getUser: async () => ({ role: { permissions: ['sys:admin'] } }) } as any;
      const appGrantService = { hasAppAccessForPrincipal: async () => false, getRequiredToolPermission: async () => undefined } as any;
      const bridge = new ToolBridgeService([], registry, appGrantService, userService);
      await bridge.init({});

      const tools = await bridge.buildForAgent(['app_tool'], { userId: 'u1' });
      const result = await tools[0].execute('id', {});
      expect(result.content[0].text).toBe('ok');
    });

    test('app-owned tool allowed with explicit grant', async () => {
      const dynamicProvider: ToolProvider = {
        toolIds: ['app_tool'],
        getCatalog: () => [],
        createTools: async () => [{ name: 'app_tool', description: '', parameters: {}, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [dynamicProvider]);
      const userService = { getUser: async () => ({ role: { permissions: ['app:use'] } }) } as any;
      const appGrantService = { hasAppAccessForPrincipal: async () => true, getRequiredToolPermission: async () => undefined } as any;
      const bridge = new ToolBridgeService([], registry, appGrantService, userService);
      await bridge.init({});

      const tools = await bridge.buildForAgent(['app_tool'], { userId: 'u1' });
      const result = await tools[0].execute('id', {});
      expect(result.content[0].text).toBe('ok');
    });

    test('app-owned tool is denied when invocation identity is missing', async () => {
      const dynamicProvider: ToolProvider = {
        toolIds: ['app_tool'],
        getCatalog: () => [],
        createTools: async () => [{
          name: 'app_tool',
          description: '',
          parameters: {},
          execute: async () => ({ content: [{ type: 'text', text: 'should not run' }] }),
        }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [dynamicProvider]);
      const bridge = new ToolBridgeService([], registry);
      await bridge.init({});

      const tools = await bridge.buildForAgent(['app_tool'], {});
      const result = await tools[0].execute('id', {});

      expect(result.details.__error.code).toBe('FORBIDDEN');
      expect(result.content[0].text).toContain('Forbidden');
    });

    test('delegated administrator permissions do not bypass APP grants', async () => {
      const execute = jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'should not run' }] });
      const dynamicProvider: ToolProvider = {
        toolIds: ['app_tool'],
        getCatalog: () => [],
        createTools: async () => [{ name: 'app_tool', description: '', parameters: {}, execute }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [dynamicProvider]);
      const appGrantService = { hasAppAccessForPrincipal: jest.fn().mockResolvedValue(false), getRequiredToolPermission: jest.fn().mockResolvedValue(undefined) };
      const bridge = new ToolBridgeService([], registry, appGrantService as any);
      await bridge.init({});
      const delegated = createInvocationPrincipal({
        type: 'delegated',
        principalId: 'delegation:d1',
        userId: 'admin-user',
        permissions: ['sys:admin'],
        scopes: ['connection:invoke'],
        origin: 'test',
        issuedAt: Date.now(),
      });

      const [tool] = await bridge.buildForAgent(['app_tool'], { principal: delegated });
      const result = await tool.execute('id', {});

      expect(result.details.__error.code).toBe('FORBIDDEN');
      expect(execute).not.toHaveBeenCalled();
    });

    test('provides app tools with a principal-bound connection client', async () => {
      const principal = createUserPrincipal({ id: 'u1' }, 'test');
      const client = {
        listBindings: jest.fn(),
        describe: jest.fn(),
        invoke: jest.fn().mockResolvedValue({ marker: 'erp-primary' }),
      };
      const connectionBindings = {
        createClient: jest.fn().mockReturnValue(client),
      };
      const dynamicProvider: ToolProvider = {
        toolIds: ['app_tool'],
        getCatalog: () => [],
        createTools: async ctx => [{
          name: 'app_tool',
          description: '',
          parameters: {},
          execute: async () => ({
            content: [{ type: 'text', text: JSON.stringify(await ctx.connections!.invoke('binding-1', {})) }],
          }),
        }],
      };
      const registry = new DynamicToolProviderRegistry();
      registry.register('app_1', [dynamicProvider]);
      const appGrantService = { hasAppAccessForPrincipal: jest.fn().mockResolvedValue(true), getRequiredToolPermission: jest.fn().mockResolvedValue(undefined) };
      const bridge = new ToolBridgeService(
        [],
        registry,
        appGrantService as any,
        undefined,
        connectionBindings as any,
      );
      await bridge.init({});

      const [tool] = await bridge.buildForAgent(['app_tool'], { principal });
      const result = await tool.execute('id', {});

      expect(connectionBindings.createClient).toHaveBeenCalledWith('app_1', principal);
      expect(client.invoke).toHaveBeenCalledWith('binding-1', {});
      expect(result.content[0].text).toContain('erp-primary');
    });
  });

  test('direct invocation never falls back to another tool from the provider', async () => {
    const provider: ToolProvider = {
      toolIds: ['requested'],
      getCatalog: () => [],
      createTools: async () => [{
        name: 'different',
        description: '',
        parameters: {},
        execute: jest.fn(),
      }],
    };
    const bridge = new ToolBridgeService([provider]);
    await bridge.init({});

    await expect(bridge.callTool('requested', {})).rejects.toThrow(
      'Tool requested must resolve to exactly one instance; received 0',
    );
  });
});
