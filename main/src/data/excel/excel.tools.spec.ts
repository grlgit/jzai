import { ExcelToolProvider } from './excel.tools';
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

const mockExcelExportService = {
  generateExcel: jest.fn(),
  updateCells: jest.fn(),
};

describe('ExcelToolProvider', () => {
  let provider: ExcelToolProvider;

  beforeEach(() => {
    provider = new ExcelToolProvider(mockExcelExportService as any);
  });

  test('toolIds contains 2 tool IDs', () => {
    expect(provider.toolIds).toEqual(['export_excel', 'update_excel_cells']);
  });

  test('getCatalog returns 2 entries with group 数据', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(2);
    expect(catalog.every(e => e.group === '数据')).toBe(true);
    expect(catalog.map(e => e.id)).toEqual(['export_excel', 'update_excel_cells']);
  });

  test('createTools returns 2 tools when Type is provided', async () => {
    const ctx: ToolContext = { userId: 'u1', piAi: { Type } };
    const tools = await provider.createTools(ctx);
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual(['export_excel', 'update_excel_cells']);
  });

  test('createTools returns empty when piAi.Type is missing', async () => {
    const tools = await provider.createTools({ userId: 'u1' });
    expect(tools).toHaveLength(0);
  });
});
