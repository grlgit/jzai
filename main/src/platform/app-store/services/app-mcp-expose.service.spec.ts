/**
 * T3.1 单测：049 迁移静态验证 + AppMcpExposeService 审批语义 + controller 端点元数据。
 */
import * as fs from 'fs';
import * as path from 'path';
import { Reflector } from '@nestjs/core';
import { NotFoundException } from '@nestjs/common';
import { AppMcpExposeService, isFirstPartyApp } from './app-mcp-expose.service';
import { AppStoreController } from '../app-store.controller';
import { PERMISSIONS_KEY } from '../../authz/require-permission.decorator';

const SQL = fs.readFileSync(path.join(__dirname, '../../../../src/db/migrations/049_app_mcp_expose.sql'), 'utf-8');

describe('T3.1 迁移 049_app_mcp_expose', () => {
  it('幂等创建 + 默认 FALSE（fail-closed）', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS jz_app_mcp_expose');
    expect(SQL).toContain('allowed      BOOLEAN NOT NULL DEFAULT FALSE');
    expect(SQL).toContain('approved_by  TEXT');
    expect(SQL).toContain('approved_at  TIMESTAMPTZ DEFAULT NOW()');
  });
});

function makeCtx(apps: any[]) {
  const rows = new Map<string, any>();
  const registry = { findOne: jest.fn(async (id: string) => apps.find(a => a.appId === id)),
    findAll: jest.fn(async () => apps) } as any;
  const db = {
    rows,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.startsWith('INSERT INTO jz_app_mcp_expose')) {
        const [appId, allowed, approvedBy] = params;
        const row = { app_id: appId, allowed, approved_by: approvedBy, approved_at: new Date(), note: params[3] ?? null };
        rows.set(appId, row);
        return { rows: [row] };
      }
      if (sql.startsWith('SELECT app_id, allowed')) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      throw new Error('unexpected SQL: ' + sql);
    }),
  } as any;
  const svc = new AppMcpExposeService(db, registry);
  return { svc, db, registry };
}

const THIRD_PARTY = { appId: 'tp1', status: 'active', manifest: { backend: { toolProviders: [{ mcpExposed: true, toolIds: ['t_a', 't_b'] }] } } };
const FIRST_PARTY = { appId: 'fp1', status: 'active', manifest: { platformCapabilities: ['appstore:manage'], backend: { toolProviders: [{ mcpExposed: true, toolIds: ['jd_x'] }] } } };

describe('T3.1 AppMcpExposeService', () => {
  it('用例1：未审批 false → setAllowed 后 true 且记录 approved_by/at', async () => {
    const { svc, db } = makeCtx([THIRD_PARTY]);
    await expect(svc.isAllowed('tp1')).resolves.toBe(false);

    const rec = await svc.setAllowed('tp1', true, 'admin1', '业务需要');
    expect(rec.allowed).toBe(true);
    expect(rec.approvedBy).toBe('admin1');
    expect(rec.approvedAt).toBeTruthy();
    await expect(svc.isAllowed('tp1')).resolves.toBe(true);

    await svc.setAllowed('tp1', false, 'admin1');
    await expect(svc.isAllowed('tp1')).resolves.toBe(false);
    expect(db.rows.get('tp1').allowed).toBe(false);
  });

  it('用例2：首方 APP 无表行也恒 true；非 active 恒 false', async () => {
    const { svc } = makeCtx([FIRST_PARTY]);
    await expect(svc.isAllowed('fp1')).resolves.toBe(true);
    const inactive = { ...THIRD_PARTY, appId: 'off1', status: 'inactive' };
    const c2 = makeCtx([inactive]);
    await c2.svc.setAllowed('off1', true, 'admin1'); // 可记录但运行期仍 false
    await expect(c2.svc.isAllowed('off1')).resolves.toBe(false);
  });

  it('用例4：listDeclared 返回声明 mcpExposed 的 active APP 及审批状态', async () => {
    const { svc } = makeCtx([THIRD_PARTY, FIRST_PARTY,
      { appId: 'none1', status: 'active', manifest: { backend: { toolProviders: [{ toolIds: ['x'] }] } } }]);
    await svc.setAllowed('tp1', true, 'admin1');
    const list = await svc.listDeclared();
    expect(list.map(d => d.appId).sort()).toEqual(['fp1', 'tp1']); // 未声明者 excluded
    const tp = list.find(d => d.appId === 'tp1')!;
    expect(tp).toMatchObject({ allowed: true, approvedBy: 'admin1', firstParty: false, toolIds: ['t_a', 't_b'] });
    expect(list.find(d => d.appId === 'fp1')).toMatchObject({ allowed: true, firstParty: true });
  });

  it('setAllowed 对不存在 APP → 404', async () => {
    const { svc } = makeCtx([]);
    await expect(svc.setAllowed('ghost', true, 'admin1')).rejects.toThrow(NotFoundException);
  });

  it('isFirstPartyApp 判定', () => {
    expect(isFirstPartyApp({ platformCapabilities: ['appstore:manage'] })).toBe(true);
    expect(isFirstPartyApp({ platformCapabilities: ['connections'] })).toBe(false);
    expect(isFirstPartyApp({})).toBe(false);
  });
});

describe('T3.1 controller 端点', () => {
  it('用例3：GET/PUT mcp-expose 与 declared 均 @RequireAdmin 元数据', () => {
    const r = new Reflector();
    const proto = AppStoreController.prototype as any;
    for (const m of ['getMcpExpose', 'setMcpExpose', 'listMcpExposeDeclared']) {
      expect(r.get(PERMISSIONS_KEY, proto[m])).toEqual(['sys:admin']);
    }
  });
});
