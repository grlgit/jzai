/**
 * T1.8 单测：MCP/Tool controller 加固（修 V3/V4/V6）+ per-tool 授权语义。
 * 真实注册表（临时目录 manifest/tool.yaml）+ 真实 ResourceAccessService（内存 meta/grants）。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Reflector } from '@nestjs/core';
import { McpRegistryController } from './mcp-registry.controller';
import { McpRegistryService } from './mcp-registry.service';
import { ToolRegistryController } from '../tool/tool-registry.controller';
import { ToolRegistryService } from '../tool/tool-registry.service';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';
import type { ResourceMetaService, ResourceMeta } from '../../platform/authz/resource-meta.service';
import type { ResourceGrantService } from '../../platform/authz/resource-grant.service';
import { PERMISSIONS_KEY } from '../../platform/authz/require-permission.decorator';

const userReq = (id: string) => ({ user: { id, role: { id: 'user', permissions: ['chat:use'] } }, headers: {} });
const adminReq = { user: { id: 'admin1', role: { id: 'admin', permissions: ['sys:admin'] } }, headers: {} };

function makeAuthz() {
  const store = new Map<string, ResourceMeta>();
  const grantRows: Array<{ t: string; id: string; subId: string; targetId: string }> = [];
  const meta = {
    get: async (t: string, id: string) => store.get(`${t}:${id}`),
    getMany: async (t: string, ids: string[]) =>
      new Map(ids.filter(id => store.has(`${t}:${id}`)).map(id => [id, store.get(`${t}:${id}`)!])),
    upsert: async (m: ResourceMeta) => { store.set(`${m.resourceType}:${m.resourceId}`, m); },
    remove: jest.fn(async (t: string, id: string) => { store.delete(`${t}:${id}`); }),
  } as unknown as ResourceMetaService;
  const grants = {
    hasGrant: jest.fn(async (t: string, id: string, p: any) =>
      grantRows.some(g => g.t === t && g.id === id && g.targetId === p.userId)),
    visibleIds: jest.fn(async (t: string, p: any) =>
      new Set(grantRows.filter(g => g.t === t && g.targetId === p.userId).map(g => g.id))),
    visibleSubIds: jest.fn(async (t: string, id: string, p: any) => {
      const rows = grantRows.filter(g => g.t === t && g.id === id && g.targetId === p.userId);
      if (rows.length === 0) return new Set<string>();
      if (rows.some(r => r.subId === '')) return null;
      return new Set(rows.map(r => r.subId));
    }),
  } as unknown as ResourceGrantService;
  const access = new ResourceAccessService(meta, grants);
  return { store, grantRows, meta, grants, access };
}

function makeMcpDir() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  const mcpDir = path.join(cfgDir, 'mcp');
  const mk = (name: string, tools: string[], enabled = true) => {
    fs.mkdirSync(path.join(mcpDir, name), { recursive: true });
    fs.writeFileSync(path.join(mcpDir, name, 'manifest.yaml'), [
      'mcp:',
      `  name: ${name}`,
      `  system: ${name}`,
      `  description: ${name} connector`,
      `  enabled: ${enabled}`,
      '  tools:',
      ...tools.flatMap(tn => [`    - name: ${tn}`, `      description: ${tn} desc`]),
    ].join('\n'));
    fs.writeFileSync(path.join(mcpDir, name, 'handler.ts'), `// handler of ${name}`);
  };
  mk('erp', ['tool_a', 'tool_b']);
  mk('crm', ['tool_c'], false);
  return { cfgDir, mcpDir };
}

function makeToolsDir() {
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-'));
  const toolsDir = path.join(cfgDir, 'tools');
  const mk = (name: string) => {
    fs.mkdirSync(path.join(toolsDir, name), { recursive: true });
    fs.writeFileSync(path.join(toolsDir, name, 'tool.yaml'),
      `tool:\n  name: ${name}\n  system: sys\n  description: ${name} tool\n  parameters: []\n`);
    fs.writeFileSync(path.join(toolsDir, name, 'handler.ts'), '// h');
  };
  mk('db_query');
  mk('mail_send');
  return { cfgDir, toolsDir };
}

describe('T1.8 MCP/Tool 连接加固', () => {
  it('用例1【安全回归 V3/V4】：mcp/tool 写端点与 handler 源码读取均已 @RequireAdmin', () => {
    const r = new Reflector();
    const mcpAdmin = ['setPermissions', 'saveHandler', 'getHandler', 'toggle', 'deleteMcp', 'register', 'reload', 'setLlmHint', 'saveSchemaFile', 'refreshSchema', 'restore', 'purge'];
    for (const m of mcpAdmin) {
      expect(r.get(PERMISSIONS_KEY, (McpRegistryController.prototype as any)[m])).toEqual(['sys:admin']);
    }
    const toolAdmin = ['setPermissions', 'saveHandler', 'getHandler', 'toggle', 'deleteTool', 'saveManifest', 'reload', 'setLlmHint', 'restore', 'purge'];
    for (const m of toolAdmin) {
      expect(r.get(PERMISSIONS_KEY, (ToolRegistryController.prototype as any)[m])).toEqual(['sys:admin']);
    }
  });

  it('用例2：普通用户 GET :name 响应无 handlerCode；无授权连接 → Not found', async () => {
    const { cfgDir } = makeMcpDir();
    const authz = makeAuthz();
    authz.store.set('connector:erp', { resourceType: 'connector', resourceId: 'erp', scope: 'global', builtin: false, defaultVisibility: 'all' } as ResourceMeta);
    authz.store.set('connector:crm', { resourceType: 'connector', resourceId: 'crm', scope: 'global', builtin: false, defaultVisibility: 'none' } as ResourceMeta);
    const mcp = new McpRegistryService({ getConfigDir: () => cfgDir } as any, authz.access, authz.grants);
    const ctrl = new McpRegistryController(mcp, {} as any, { resolveCredentials: () => ({}) } as any, { verifyToken: () => null } as any);

    // visibility=all 的 erp：可见但脱敏
    const detail = await ctrl.getDetail('erp', userReq('u1'));
    expect(detail).not.toHaveProperty('handlerCode');
    expect(detail).toHaveProperty('name', 'erp');
    // 无任何授权的 crm：Not found（fail-closed）
    await expect(ctrl.getDetail('crm', userReq('u1'))).resolves.toEqual({ error: 'Not found' });
    // admin：全量含 handlerCode
    const adminDetail = await ctrl.getDetail('erp', adminReq);
    expect(adminDetail).toHaveProperty('handlerCode');
  });

  it('用例3：sub_id 全部/单工具语义——列表 tools 按 visibleSubIds 过滤', async () => {
    const { cfgDir } = makeMcpDir();
    const authz = makeAuthz();
    authz.store.set('connector:erp', { resourceType: 'connector', resourceId: 'erp', scope: 'global', builtin: false, defaultVisibility: 'none' } as ResourceMeta);
    authz.store.set('connector:crm', { resourceType: 'connector', resourceId: 'crm', scope: 'global', builtin: false, defaultVisibility: 'all' } as ResourceMeta);
    const mcp = new McpRegistryService({ getConfigDir: () => cfgDir } as any, authz.access, authz.grants);
    const ctrl = new McpRegistryController(mcp, {} as any, { resolveCredentials: () => ({}) } as any, { verifyToken: () => null } as any);

    // 无授权：列表为空（crm disabled + 无 grant）
    authz.grantRows.push({ t: 'connector', id: 'erp', subId: '', targetId: 'u1' });
    let list = await ctrl.list(userReq('u1'));
    expect(list.map((x: any) => x.name)).toEqual(['erp']);
    expect(list[0].tools.map((t: any) => t.name)).toEqual(['tool_a', 'tool_b']); // sub_id='' 全部

    // 改为仅授权 tool_a
    authz.grantRows.length = 0;
    authz.grantRows.push({ t: 'connector', id: 'erp', subId: 'tool_a', targetId: 'u1' });
    list = await ctrl.list(userReq('u1'));
    expect(list[0].tools.map((t: any) => t.name)).toEqual(['tool_a']);
    expect(list[0].toolCount).toBe(1);

    // admin：见全部连接（含 disabled）与全部工具
    const adminList = await ctrl.list(adminReq);
    expect(adminList.map((x: any) => x.name).sort()).toEqual(['crm', 'erp']);
    expect(adminList.find((x: any) => x.name === 'erp')!.tools).toHaveLength(2);
  });

  it('用例4【安全回归 V6】：GET /api/tools 对无授权用户不返回未授权项', async () => {
    const { cfgDir } = makeToolsDir();
    const authz = makeAuthz();
    authz.store.set('tool:db_query', { resourceType: 'tool', resourceId: 'db_query', scope: 'global', builtin: false, defaultVisibility: 'all' } as ResourceMeta);
    authz.store.set('tool:mail_send', { resourceType: 'tool', resourceId: 'mail_send', scope: 'global', builtin: false, defaultVisibility: 'none' } as ResourceMeta);
    const tools = new ToolRegistryService({ getConfigDir: () => cfgDir } as any, authz.access);
    const ctrl = new ToolRegistryController(tools, { getSourceMap: async () => new Map() } as any);

    const bobList = await ctrl.list(userReq('bob'));
    expect(bobList.map((t: any) => t.name)).toEqual(['db_query']); // mail_send 未授权不再泄漏

    authz.grantRows.push({ t: 'tool', id: 'mail_send', subId: '', targetId: 'bob' });
    const grantedList = await ctrl.list(userReq('bob'));
    expect(grantedList.map((t: any) => t.name).sort()).toEqual(['db_query', 'mail_send']);

    const adminList = await ctrl.list(adminReq);
    expect(adminList.map((t: any) => t.name).sort()).toEqual(['db_query', 'mail_send']);
  });

  it('isAllowedForUser 委托 canView（delegated 兼容旧调用形态）', async () => {
    const { cfgDir } = makeMcpDir();
    const authz = makeAuthz();
    authz.store.set('connector:erp', { resourceType: 'connector', resourceId: 'erp', scope: 'global', builtin: false, defaultVisibility: 'none' } as ResourceMeta);
    const mcp = new McpRegistryService({ getConfigDir: () => cfgDir } as any, authz.access, authz.grants);

    await expect(mcp.isAllowedForUser('erp', 'u1', ['r1'])).resolves.toBe(false);
    authz.grantRows.push({ t: 'connector', id: 'erp', subId: '', targetId: 'u1' });
    await expect(mcp.isAllowedForUser('erp', 'u1', ['r1'])).resolves.toBe(true);
    // disabled → false（保留旧语义）
    await expect(mcp.isAllowedForUser('crm', 'u1', [])).resolves.toBe(false);
  });

  it('未接线 authz（直构）时 isAllowedForUser 回落旧 manifest ACL', async () => {
    const { cfgDir } = makeMcpDir();
    const mcp = new McpRegistryService({ getConfigDir: () => cfgDir } as any);
    await expect(mcp.isAllowedForUser('erp', 'u1', [])).resolves.toBe(true); // 无 ACL → allow
  });
});
