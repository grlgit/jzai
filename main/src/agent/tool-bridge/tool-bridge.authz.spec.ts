/**
 * T1.9 单测：buildForAgent 运行期兜底过滤（YAML 绕过路径封死；system principal 跳过；AUTHZ_ENFORCE=0 回落）。
 */
import { ToolBridgeService } from './tool-bridge.service';
import type { ToolProvider } from './tool-provider.interface';
import { createUserPrincipal, createSystemPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';
import type { ResourceMetaService, ResourceMeta } from '../../platform/authz/resource-meta.service';
import type { ResourceGrantService } from '../../platform/authz/resource-grant.service';

const mcpProvider: ToolProvider = {
  toolIds: ['mcp'],
  getCatalog: () => [{ id: 'mcp', label: 'MCP', group: '连接' }],
  createTools: async () => [
    { name: 'mcp_erp_query', description: 'q', parameters: {}, execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }) },
    { name: 'mcp_erp_create', description: 'c', parameters: {}, execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }) },
    { name: 'mcp_crm_query', description: 'q', parameters: {}, execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }) },
  ],
};

function makeBridge() {
  const store = new Map<string, ResourceMeta>();
  store.set('connector:erp', { resourceType: 'connector', resourceId: 'erp', scope: 'global', builtin: false, defaultVisibility: 'none' } as ResourceMeta);
  store.set('connector:crm', { resourceType: 'connector', resourceId: 'crm', scope: 'global', builtin: false, defaultVisibility: 'all' } as ResourceMeta);
  const meta = {
    get: async (t: string, id: string) => store.get(`${t}:${id}`),
    getMany: async (t: string, ids: string[]) =>
      new Map(ids.filter(id => store.has(`${t}:${id}`)).map(id => [id, store.get(`${t}:${id}`)!])),
  } as unknown as ResourceMetaService;
  const grantRows: Array<{ id: string; subId: string; targetId: string }> = [];
  const grants = {
    hasGrant: jest.fn(async (t: string, id: string, p: any) =>
      grantRows.some(g => g.id === id && g.targetId === p.userId)),
    visibleIds: jest.fn(async (t: string, p: any) =>
      new Set(grantRows.filter(g => g.targetId === p.userId).map(g => g.id))),
    visibleSubIds: jest.fn(async (t: string, id: string, p: any) => {
      const rows = grantRows.filter(g => g.id === id && g.targetId === p.userId);
      if (rows.length === 0) return new Set<string>();
      if (rows.some(r => r.subId === '')) return null;
      return new Set(rows.map(r => r.subId));
    }),
  } as unknown as ResourceGrantService;
  const access = new ResourceAccessService(meta, grants);
  const mcpRegistry = {
    getAll: () => [{ name: 'erp' }, { name: 'crm' }],
    onChange: () => () => {},
  } as any;
  const bridge = new ToolBridgeService(
    [mcpProvider], undefined, undefined, undefined, undefined, mcpRegistry, undefined, access, grants,
  );
  return { bridge, grantRows, store };
}

const userP = (id: string) => createUserPrincipal({ id }, 'test');

describe('T1.9 buildForAgent 运行期兜底过滤', () => {
  beforeEach(() => { delete process.env.AUTHZ_ENFORCE; });
  afterEach(() => { delete process.env.AUTHZ_ENFORCE; });

  it('用例1：YAML 写死 mcp:erp、用户无授权 → 工具集无 erp 工具且有 warn；crm（all）保留', async () => {
    const { bridge } = makeBridge();
    await bridge.init({});
    const warn = jest.spyOn((bridge as any).logger, 'warn').mockImplementation(() => {});
    const tools = await bridge.buildForAgent(['mcp:erp', 'mcp:crm'], { principal: userP('u1') });
    const names = tools.map(t => t.name);
    expect(names).not.toContain('mcp_erp_query');
    expect(names).not.toContain('mcp_erp_create');
    expect(names).toContain('mcp_crm_query');
    expect(warn.mock.calls.some(c => String(c[0]).includes('未授权连接 mcp:erp'))).toBe(true);
  });

  it('用例2：有授权（sub_id=全部）用户 → 工具集包含 erp 全部工具', async () => {
    const { bridge, grantRows } = makeBridge();
    grantRows.push({ id: 'erp', subId: '', targetId: 'u1' });
    await bridge.init({});
    const tools = await bridge.buildForAgent(['mcp:erp'], { principal: userP('u1') });
    expect(tools.map(t => t.name).sort()).toEqual(['mcp_erp_create', 'mcp_erp_query']);
  });

  it('用例3：仅授权 erp/query 子工具 → 工具集只含 mcp_erp_query', async () => {
    const { bridge, grantRows } = makeBridge();
    grantRows.push({ id: 'erp', subId: 'query', targetId: 'u1' });
    await bridge.init({});
    const warn = jest.spyOn((bridge as any).logger, 'warn').mockImplementation(() => {});
    const tools = await bridge.buildForAgent(['mcp:erp'], { principal: userP('u1') });
    expect(tools.map(t => t.name)).toEqual(['mcp_erp_query']);
    expect(warn.mock.calls.some(c => String(c[0]).includes('未授权子工具 mcp:erp/create'))).toBe(true);
  });

  it('用例4：system principal（origin=scheduler）→ 不过滤，全量工具', async () => {
    const { bridge } = makeBridge();
    await bridge.init({});
    const schedulerP = { ...createSystemPrincipal('scheduler'), origin: 'scheduler' } as any;
    const tools = await bridge.buildForAgent(['mcp:erp'], { principal: schedulerP });
    expect(tools.map(t => t.name).sort()).toEqual(['mcp_erp_create', 'mcp_erp_query']);
    // 无 principal 的 legacy ctx（userId only）→ 走 fallback user principal，按用户过滤（fail-closed 不变）
  });

  it('用例5：AUTHZ_ENFORCE=0 → 行为与改造前一致（不过滤）', async () => {
    process.env.AUTHZ_ENFORCE = '0';
    const { bridge } = makeBridge();
    await bridge.init({});
    const tools = await bridge.buildForAgent(['mcp:erp'], { principal: userP('u1') });
    expect(tools.map(t => t.name).sort()).toEqual(['mcp_erp_create', 'mcp_erp_query']);
  });

  it('未接线 authz（直构旧式）→ 不过滤（零破坏）', async () => {
    const bridge = new ToolBridgeService([mcpProvider]);
    await bridge.init({});
    const tools = await bridge.buildForAgent(['mcp:erp'], { principal: userP('u1') });
    expect(tools.map(t => t.name).sort()).toEqual(['mcp_erp_create', 'mcp_erp_query']);
  });
});
