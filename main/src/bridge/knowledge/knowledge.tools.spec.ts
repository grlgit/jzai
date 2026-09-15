import { KnowledgeToolProvider } from './knowledge.tools';

const mockMcpTools = {
  getRawMcpTools: jest.fn().mockResolvedValue([
    { name: 'guide', description: 'Guide tool', parameters: {}, execute: jest.fn() },
    { name: 'search', description: 'Search tool', parameters: {}, execute: jest.fn() },
  ]),
  getKnowledgeTools: jest.fn().mockResolvedValue([
    { name: 'search_knowledge', description: 'KB search', execute: jest.fn() },
  ]),
};

const mockSkillRegistry = { getKnowledgeDomains: () => ['ERP', 'MOM'] };

const mockKbAccess = { getAccessibleScopesForUser: jest.fn().mockResolvedValue(['cat-1']) };

const mockType = {
  Object: (p: any) => p, String: (o?: any) => 'string', Optional: (t: any) => t,
  Array: (t: any, _o?: any) => [t],
};

describe('KnowledgeToolProvider', () => {
  const provider = new KnowledgeToolProvider(mockMcpTools as any, mockKbAccess as any, mockSkillRegistry as any);

  test('toolIds has 2 entries', () => {
    expect(provider.toolIds).toEqual(['kb_mcp', 'knowledge']);
  });

  test('getCatalog returns 2 entries', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(2);
    expect(catalog.every(c => c.group === '知识')).toBe(true);
  });

  test('createTools returns raw MCP + knowledge tools', async () => {
    const tools = await provider.createTools({ piAi: { Type: mockType } });
    const names = tools.map(t => t.name);
    expect(names).toContain('guide');
    expect(names).toContain('search');
    expect(names).toContain('suggest_kb_save');
    expect(names).toContain('search_knowledge');
    expect(tools.length).toBe(4);
  });

  test('createTools returns only raw MCP when no Type', async () => {
    const tools = await provider.createTools({});
    // kb_mcp tools still work without Type, knowledge tools need Type
    expect(tools.length).toBe(2); // guide + search from getRawMcpTools
  });
});
