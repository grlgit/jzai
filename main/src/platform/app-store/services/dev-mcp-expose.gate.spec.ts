/**
 * T3.2 单测：validator 10.6 降级 warning；dev-mcp 聚合审批门控 + callTool grants 双保险。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppValidatorService } from '../validators/app-validator.service';
import { DevMcpService } from './dev-mcp.service';

const EMPTIES = () => ({
  existingAppIds: new Set<string>(), existingShortNames: new Set<string>(),
  existingNsPrefixes: new Set<string>(), existingSchemaNames: new Set<string>(),
  existingPanelIds: new Set<string>(), existingToolIds: new Set<string>(),
});

describe('T3.2 validator Check 10.6 降级', () => {
  it('用例1：三方包 mcpExposed → MCP_EXPOSE_NOT_FIRST_PARTY 为 warning（不再 critical，install 可通过）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzapp-mcpexpose-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      manifestVersion: '1.0', appId: 'com.third.party-tools', shortName: 'party-tools',
      nsPrefix: 'pt', name: { zh: '三方工具' }, version: '1.0.0',
      backend: { entry: './dist/index.js', module: './dist/index.js',
        toolProviders: [{ class: 'TpProvider', toolIds: ['pt_do'], mcpExposed: true }] },
    }));
    fs.writeFileSync(path.join(dir, 'dist.js'), 'module.exports = {};\n');
    const service = new AppValidatorService();
    const report = await service.validate(dir, ...Object.values(EMPTIES()) as any);
    const hits = report.all.filter((r: any) => r.code === 'MCP_EXPOSE_NOT_FIRST_PARTY');
    expect(hits).toHaveLength(1);
    expect(hits[0].level).toBe('warning');
    expect(hits[0].message).toContain('须管理员审批后生效');
    expect(report.criticals.some((r: any) => r.code === 'MCP_EXPOSE_NOT_FIRST_PARTY')).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function makeSvc(opts: {
  allowed?: boolean; canView?: boolean; userExists?: boolean; withExpose?: boolean; withAccess?: boolean;
}) {
  const apps = [
    { appId: 'com.third.tp1', status: 'active',
      manifest: { backend: { toolProviders: [{ toolIds: ['tp_do'], mcpExposed: true }] } } },
  ];
  const bridge = { getCatalog: () => [{ id: 'tp_do', label: 'tp', description: 'd', parameters: {} }],
    callTool: jest.fn(async () => ({ ok: true })) } as any;
  const moduleRef = { get: jest.fn(() => bridge) } as any;
  const expose = opts.withExpose === false ? undefined : {
    isAllowed: jest.fn(async (appId: string) => opts.allowed ?? false),
  } as any;
  const access = opts.withAccess === false ? undefined : {
    canView: jest.fn(async () => opts.canView ?? true),
  } as any;
  const db = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('FROM jz_users u LEFT JOIN jz_roles')) {
        return opts.userExists === false ? { rows: [] } : { rows: [{ id: params[0], role_id: 'admin', permissions: ['sys:admin'] }] };
      }
      if (sql.includes('jz_department_members')) return { rows: [] };
      return { rows: [] };
    }),
  } as any;
  const svc = new DevMcpService(db, {} as any, { findAll: jest.fn(async () => apps) } as any,
    { log: jest.fn() } as any, { encrypt: (v: string) => v, decrypt: (v: string) => v } as any,
    moduleRef, {} as any, expose, access);
  return { svc, bridge, expose, access };
}

describe('T3.2 dev-mcp 门控', () => {
  it('用例2：未审批 → listTools 不含其工具、callTool 拒绝（not exposed）', async () => {
    const { svc, expose } = makeSvc({ allowed: false });
    const tools = await svc.listTools();
    expect(tools.some(t => t.name === 'tp_do')).toBe(false);
    await expect(svc.callTool('tp_do', {}, 'dev1')).rejects.toThrow('not exposed');
    expect(expose!.isAllowed).toHaveBeenCalledWith('com.third.tp1');
  });

  it('用例3：审批后 → listTools 出现、callTool 成功（canView 直通）', async () => {
    const { svc, bridge } = makeSvc({ allowed: true, canView: true });
    const tools = await svc.listTools();
    expect(tools.some(t => t.name === 'tp_do')).toBe(true);
    await expect(svc.callTool('tp_do', { x: 1 }, 'dev1')).resolves.toEqual({ ok: true });
    expect(bridge.callTool).toHaveBeenCalled();
  });

  it('用例4：审批但 actor 无 tool grant → callTool 拒绝（双保险）；actor 不存在同样拒绝', async () => {
    const { svc, access } = makeSvc({ allowed: true, canView: false });
    await expect(svc.callTool('tp_do', {}, 'dev1')).rejects.toThrow('No tool grant');
    expect(access!.canView).toHaveBeenCalledWith('tool', 'tp_do', expect.objectContaining({ userId: 'dev1', permissions: ['sys:admin'] }));

    const c2 = makeSvc({ allowed: true, userExists: false });
    await expect(c2.svc.callTool('tp_do', {}, 'ghost')).rejects.toThrow('No tool grant');
  });

  it('用例5：未接线 expose/access（旧式构造）→ 保持旧行为全量聚合且直调（零破坏）', async () => {
    const { svc } = makeSvc({ withExpose: false, withAccess: false });
    const tools = await svc.listTools();
    expect(tools.some(t => t.name === 'tp_do')).toBe(true); // 旧语义：声明即暴露
    await expect(svc.callTool('tp_do', {}, 'dev1')).resolves.toBeTruthy();
  });

  it('首方 APP 不经 expose 查询亦恒通（expose.isAllowed 对首方短路由服务内部保证）', async () => {
    const { svc, expose } = makeSvc({ allowed: false });
    // com.third.tp1 非首方；本用例验证 expose 被咨询（首方短路已在 T3.1 用例2 覆盖）
    await svc.listTools();
    expect(expose!.isAllowed).toHaveBeenCalled();
  });
});
