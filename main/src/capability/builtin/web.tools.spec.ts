import { WebToolProvider } from './web.tools';

describe('WebToolProvider', () => {
  let provider: WebToolProvider;

  beforeEach(() => {
    provider = new WebToolProvider();
  });

  test('toolIds lists all web tools', () => {
    expect(provider.toolIds).toEqual([
      'fetch_url', 'web_search', 'web_fetch', 'browser', 'firecrawl', 'tavily',
    ]);
  });

  test('getCatalog returns entries with group Web', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(6);
    for (const entry of catalog) {
      expect(entry.group).toBe('Web');
      expect(entry.id).toBeTruthy();
      expect(entry.label).toBeTruthy();
    }
    expect(catalog.map(c => c.id)).toEqual(provider.toolIds);
  });

  test('createTools returns empty array when piAi.Type is missing', async () => {
    const tools = await provider.createTools({});
    expect(tools).toEqual([]);
  });

  test('createTools returns tool instances with correct names', async () => {
    const mockType = {
      Object: (schema: any) => schema,
      String: (opts?: any) => ({ type: 'string', ...opts }),
      Number: (opts?: any) => ({ type: 'number', ...opts }),
      Optional: (t: any) => ({ ...t, optional: true }),
    };

    const tools = await provider.createTools({ piAi: { Type: mockType } });
    expect(tools.length).toBe(6);

    const names = tools.map(t => t.name);
    expect(names).toContain('fetch_url');
    expect(names).toContain('web_search');
    expect(names).toContain('web_fetch');
    expect(names).toContain('browser_action');
    expect(names).toContain('firecrawl');
    expect(names).toContain('tavily_search');

    // Every tool has execute function
    for (const tool of tools) {
      expect(typeof tool.execute).toBe('function');
      expect(tool.description).toBeTruthy();
    }
  });
});
