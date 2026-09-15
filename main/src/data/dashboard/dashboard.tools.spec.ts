import { DashboardToolProvider } from './dashboard.tools';
import { ToolContext } from '../../agent/tool-bridge/tool-provider.interface';

// Minimal Type mock matching @sinclair/typebox API surface
const Type = {
  Object: (props: any) => ({ type: 'object', properties: props }),
  String: (opts?: any) => ({ type: 'string', ...opts }),
  Number: (opts?: any) => ({ type: 'number', ...opts }),
  Any: (opts?: any) => ({ type: 'any', ...opts }),
  Optional: (s: any) => ({ ...s, optional: true }),
  Union: (items: any[]) => ({ anyOf: items }),
  Literal: (v: any) => ({ const: v }),
  Array: (item: any) => ({ type: 'array', items: item }),
};

const mockDashboardService = {
  executeDataSource: jest.fn(),
  listDashboards: jest.fn(),
  createDashboard: jest.fn(),
  deleteDashboard: jest.fn(),
  addWidget: jest.fn(),
  updateWidget: jest.fn(),
  deleteWidget: jest.fn(),
};

const mockAgentPool = {
  getSessionId: jest.fn(),
};

const mockSessionService = {
  bindSkill: jest.fn(),
};

describe('DashboardToolProvider', () => {
  let provider: DashboardToolProvider;

  beforeEach(() => {
    provider = new DashboardToolProvider(
      mockDashboardService as any,
      mockAgentPool as any,
      mockSessionService as any,
    );
  });

  test('toolIds contains 4 tool IDs', () => {
    expect(provider.toolIds).toEqual([
      'dashboard_query', 'dashboard_manage', 'dashboard_widget', 'inline_chart',
    ]);
  });

  test('getCatalog returns 4 entries with group 数据仪表', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(4);
    expect(catalog.every(e => e.group === '数据仪表')).toBe(true);
    expect(catalog.map(e => e.id)).toEqual([
      'dashboard_query', 'dashboard_manage', 'dashboard_widget', 'inline_chart',
    ]);
  });

  test('createTools returns 4 tools when Type is provided', async () => {
    const ctx: ToolContext = { userId: 'u1', agentKey: 'k1', piAi: { Type } };
    const tools = await provider.createTools(ctx);
    expect(tools).toHaveLength(4);
    expect(tools.map(t => t.name)).toEqual([
      'dashboard_query', 'dashboard_manage', 'dashboard_widget', 'inline_chart',
    ]);
  });

  test('createTools returns empty when piAi.Type is missing', async () => {
    const tools = await provider.createTools({ userId: 'u1' });
    expect(tools).toHaveLength(0);
  });
});
