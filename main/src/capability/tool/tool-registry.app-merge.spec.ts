/**
 * T3.3 单测：/api/tools 并入已审批 mcpExposed APP 工具（source 标记 + exposedViaMcp）+ APP 工具写操作 404。
 */
import { NotFoundException } from '@nestjs/common';
import { ToolRegistryController } from './tool-registry.controller';
import type { AppMcpExposeService } from '../../platform/app-store/services/app-mcp-expose.service';

const adminReq = { user: { id: 'admin1', role: { id: 'admin', permissions: ['sys:admin'] } } };

function makeCtx(opts: { declared?: any[] } = {}) {
  const tools = {
    getAll: jest.fn(() => [{ name: 'db_query', system: 's', description: 'd', parameters: [],
      enabled: true, permissions: {}, status: {}, authFields: null, llmHint: undefined, authSystem: undefined }]),
    getAllForPrincipal: jest.fn(async () => [{ name: 'db_query' }]),
    get: jest.fn((name: string) => (name === 'db_query' ? { name: 'db_query' } : undefined)),
    delete: jest.fn((name: string) => name === 'db_query'),
    enable: jest.fn(() => true),
    disable: jest.fn(() => true),
  } as any;
  const sourceMap = new Map([['tp_do', { appId: 'com.third.tp1', name: '三方工具' }]]);
  const appCapabilities = { getSourceMap: jest.fn(async () => new Map([['tool', sourceMap]])) } as any;
  const mcpExpose = {
    listDeclared: jest.fn(async () => opts.declared ?? []),
  } as unknown as AppMcpExposeService;
  // 权限修复后 controller 多了 access（ResourceAccessService）构造参数：详情可见性校验
  const access = { canView: jest.fn(async () => true) } as any;
  const ctrl = new ToolRegistryController(tools, appCapabilities, access, mcpExpose);
  return { ctrl, tools, sourceMap };
}

describe('T3.3 /api/tools APP 工具并入', () => {
  it('用例1：列表含 APP 工具 + sourceApp 徽标 + 审批通过 exposedViaMcp=true / 未审批 false', async () => {
    const { ctrl } = makeCtx({ declared: [
      { appId: 'com.third.tp1', toolIds: ['tp_do'], allowed: true, firstParty: false },
    ] });
    const list = await ctrl.list(adminReq);
    const app = list.find((t: any) => t.name === 'tp_do');
    expect(app).toMatchObject({
      sourceApp: { appId: 'com.third.tp1', name: '三方工具' },
      exposedViaMcp: true,
    });

    const c2 = makeCtx({ declared: [
      { appId: 'com.third.tp1', toolIds: ['tp_do'], allowed: false, firstParty: false },
    ] });
    const list2 = await c2.ctrl.list(adminReq);
    expect(list2.find((t: any) => t.name === 'tp_do').exposedViaMcp).toBe(false);
  });

  it('未声明 mcpExposed 的 APP 工具 exposedViaMcp=false（listDeclared 未收录）', async () => {
    const { ctrl } = makeCtx({ declared: [] });
    const list = await ctrl.list(adminReq);
    expect(list.find((t: any) => t.name === 'tp_do').exposedViaMcp).toBe(false);
  });

  it('用例3：APP 工具 PATCH/DELETE → 404；workspace 工具正常', async () => {
    const { ctrl, tools } = makeCtx();
    await expect(ctrl.toggle('tp_do', { enabled: false })).rejects.toThrow(NotFoundException);
    await expect(ctrl.deleteTool('tp_do')).rejects.toThrow(NotFoundException);
    expect(tools.delete).not.toHaveBeenCalled();

    await expect(ctrl.toggle('db_query', { enabled: false })).resolves.toEqual({ success: true, name: 'db_query', enabled: false });
    await expect(ctrl.deleteTool('db_query')).resolves.toEqual({ success: true });
    expect(tools.delete).toHaveBeenCalledWith('db_query');
  });

  it('workspace 工具照常列出（V6 过滤语义不变）', async () => {
    const { ctrl } = makeCtx();
    const list = await ctrl.list(adminReq);
    expect(list.find((t: any) => t.name === 'db_query')).toBeTruthy();
  });
});
