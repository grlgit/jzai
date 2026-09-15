import { Test, TestingModule } from '@nestjs/testing';
import { DatabaseToolProvider } from './database.tools';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { CredentialService } from '../../capability/skill/credential.service';
import { ConfirmationBridgeService } from '../../agent/support/confirmation-bridge.service';
import { ToolContext } from '../../agent/tool-bridge/tool-provider.interface';

describe('DatabaseToolProvider', () => {
  let provider: DatabaseToolProvider;

  const mockMcpRegistry = {
    get: jest.fn(),
    getBaseDir: jest.fn().mockReturnValue('/tmp/mcp'),
    loadAll: jest.fn(),
    refreshSchema: jest.fn().mockResolvedValue({ success: true, total: 10 }),
  };

  const mockCredentialService = {
    getGlobalCredentials: jest.fn(),
    saveGlobalCredentials: jest.fn(),
  };

  const mockConfirmBridge = {
    requestConfirmation: jest.fn(),
  };

  // Minimal Type mock that mirrors @sinclair/typebox shape
  const mockType = {
    Object: jest.fn((props: any) => ({ type: 'object', properties: props })),
    String: jest.fn((opts?: any) => ({ type: 'string', ...opts })),
    Optional: jest.fn((schema: any) => ({ ...schema, optional: true })),
  };

  const ctx: ToolContext = { piAi: { Type: mockType } };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DatabaseToolProvider,
        { provide: McpRegistryService, useValue: mockMcpRegistry },
        { provide: CredentialService, useValue: mockCredentialService },
        { provide: ConfirmationBridgeService, useValue: mockConfirmBridge },
      ],
    }).compile();

    provider = module.get<DatabaseToolProvider>(DatabaseToolProvider);
  });

  it('should be defined', () => {
    expect(provider).toBeDefined();
  });

  describe('toolIds', () => {
    it('should expose 4 tool IDs', () => {
      expect(provider.toolIds).toEqual([
        'save_db_connection',
        'test_db_connection',
        'discover_db_schema',
        'search_db_schema',
      ]);
    });
  });

  describe('getCatalog', () => {
    it('should return 4 entries with group "数据库"', () => {
      const catalog = provider.getCatalog();
      expect(catalog).toHaveLength(4);
      for (const entry of catalog) {
        expect(entry.group).toBe('数据库');
      }
      expect(catalog.map(e => e.id)).toEqual([
        'save_db_connection',
        'test_db_connection',
        'discover_db_schema',
        'search_db_schema',
      ]);
    });
  });

  describe('createTools', () => {
    it('should return 4 tools with correct names', async () => {
      const tools = await provider.createTools(ctx);
      expect(tools).toHaveLength(4);
      expect(tools.map(t => t.name)).toEqual([
        'save_db_connection',
        'test_db_connection',
        'discover_db_schema',
        'search_db_schema',
      ]);
    });

    it('should return empty array when piAi.Type is missing', async () => {
      const tools = await provider.createTools({ piAi: {} });
      expect(tools).toHaveLength(0);
    });

    it('should return empty array when piAi is undefined', async () => {
      const tools = await provider.createTools({});
      expect(tools).toHaveLength(0);
    });

    it('each tool should have an execute function', async () => {
      const tools = await provider.createTools(ctx);
      for (const tool of tools) {
        expect(typeof tool.execute).toBe('function');
      }
    });
  });
});
