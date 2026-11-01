/**
 * T4.1 单测：panelSchema mobile 段向后兼容、MOBILE_ENTRY_MISSING warning、
 * registerAppPanel 写 mobile_config、getUserSidebar 返回 mobile 字段。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppManifestSchema } from '../app-store/validators/manifest.schema';
import { AppValidatorService } from '../app-store/validators/app-validator.service';
import { PanelService } from './panel.service';

const SQL = fs.readFileSync(path.join(__dirname, '../../db/migrations/050_panel_mobile.sql'), 'utf-8');

describe('T4.1 迁移 050_panel_mobile', () => {
  it('幂等加列', () => {
    expect(SQL).toContain('ALTER TABLE jz_panels ADD COLUMN IF NOT EXISTS mobile_config JSONB');
  });
});

describe('T4.1 panelSchema mobile 段', () => {
  const baseManifest = {
    manifestVersion: '1.0', appId: 'com.test.mobile', shortName: 'mobile-test',
    nsPrefix: 'mb', name: { zh: '测试' }, version: '1.0.0',
  };

  it('用例1：旧包（无 mobile 字段）schema 校验通过（向后兼容）', () => {
    const parsed = AppManifestSchema.safeParse({
      ...baseManifest,
      panels: [{ id: 'mbMain', name: { zh: '面板' }, entryComponent: 'dist/p.js' }],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.panels?.[0].mobile).toBeUndefined();
  });

  it('mobile 段解析正确（supported 缺省 false / layout 枚举）', () => {
    const parsed = AppManifestSchema.safeParse({
      ...baseManifest,
      panels: [
        { id: 'mbFull', name: { zh: 'A' }, entryComponent: 'dist/a.js',
          mobile: { supported: true, layout: 'full' } },
        { id: 'mbSheet', name: { zh: 'B' }, entryComponent: 'dist/b.js',
          mobile: { supported: true, entryComponent: 'dist/b.mobile.js', layout: 'sheet' } },
      ],
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.panels?.[0].mobile).toEqual({ supported: true, layout: 'full', entryComponent: undefined });
    expect(parsed.data?.panels?.[1].mobile?.entryComponent).toBe('dist/b.mobile.js');
    // layout 非法值被拒
    expect(AppManifestSchema.safeParse({
      ...baseManifest,
      panels: [{ id: 'x', name: { zh: 'x' }, mobile: { supported: true, layout: 'banana' } }],
    }).success).toBe(false);
  });
});

describe('T4.1 validator MOBILE_ENTRY_MISSING', () => {
  it('用例3：supported=true 但两处 entryComponent 均缺 → warning；有其一则无', async () => {
    const service = new AppValidatorService();
    const empties = {
      existingAppIds: new Set<string>(), existingShortNames: new Set<string>(),
      existingNsPrefixes: new Set<string>(), existingSchemaNames: new Set<string>(),
      existingPanelIds: new Set<string>(), existingToolIds: new Set<string>(),
    };
    const mk = (panel: any) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzapp-mobile-'));
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
        manifestVersion: '1.0', appId: 'com.test.mobile-warn', shortName: 'mobile-warn',
        nsPrefix: 'mw', name: { zh: '测试' }, version: '1.0.0', panels: [panel],
      }));
      fs.writeFileSync(path.join(dir, 'README.md'), '# x\n' + 'y'.repeat(300));
      return dir;
    };

    const bad = mk({ id: 'mwMain', name: { zh: 'A' }, icon: 'x', mobile: { supported: true } });
    const r1 = await service.validate(bad, ...Object.values(empties) as any);
    const hit = r1.all.filter((x: any) => x.code === 'MOBILE_ENTRY_MISSING');
    expect(hit).toHaveLength(1);
    expect(hit[0].level).toBe('warning');
    fs.rmSync(bad, { recursive: true, force: true });

    const ok1 = mk({ id: 'mwMain', name: { zh: 'A' }, icon: 'x', entryComponent: 'dist/p.js', mobile: { supported: true } });
    const r2 = await service.validate(ok1, ...Object.values(empties) as any);
    expect(r2.all.some((x: any) => x.code === 'MOBILE_ENTRY_MISSING')).toBe(false);
    fs.rmSync(ok1, { recursive: true, force: true });

    const ok2 = mk({ id: 'mwMain', name: { zh: 'A' }, icon: 'x', mobile: { supported: true, entryComponent: 'dist/m.js' } });
    const r3 = await service.validate(ok2, ...Object.values(empties) as any);
    expect(r3.all.some((x: any) => x.code === 'MOBILE_ENTRY_MISSING')).toBe(false);
    fs.rmSync(ok2, { recursive: true, force: true });
  });
});

describe('T4.1 registerAppPanel / getUserSidebar mobile 链路', () => {
  it('用例2/4：mobile 写库原样存 JSONB；升级（重复 register）随 manifest 更新；sidebar 返回 mobile', async () => {
    const calls: Array<{ sql: string; params: any[] }> = [];
    let panelRow: any = {};
    const db = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (sql.startsWith('INSERT INTO jz_panels')) {
          panelRow = {
            id: params[0], entry_component: params[7],
            mobile_config: params[11] ? JSON.parse(params[11]) : null,
          };
          return { rows: [] };
        }
        if (sql.includes('FROM jz_panels p')) {
          return { rows: [{
            id: 'mwMain', name: 'A', icon: '', permission: null, isBuiltin: false, defaultOrder: 1,
            category: 'third_party', sourceAppId: 'com.test.app', agentId: null, uninstallable: true,
            nameI18n: null, entryComponent: panelRow.entry_component, keepAlive: false,
            messageSchema: null, mobile: panelRow.mobile_config, appVersion: '1.0.0',
            visible: true, groupName: '', sortOrder: 1, grantRole: 'user',
          }] };
        }
        if (sql.includes('WHERE enabled=TRUE') || sql === 'SELECT 1') return { rows: [{ exists: true }] };
        return { rows: [] };
      }),
    } as any;
    const svc = new PanelService(db, {} as any);

    // 安装：带 mobile 段
    await svc.registerAppPanel({
      id: 'mwMain', name: { zh: 'A' }, entryComponent: 'dist/p.js',
      mobile: { supported: true, layout: 'sheet' },
    } as any, 'com.test.app');
    expect(panelRow.mobile_config).toEqual({ supported: true, layout: 'sheet' });

    // 升级：manifest 移除 mobile → mobile_config 置 null
    await svc.registerAppPanel({ id: 'mwMain', name: { zh: 'A' }, entryComponent: 'dist/p.js' } as any, 'com.test.app');
    expect(panelRow.mobile_config).toBeNull();

    // 再升级：独立 entryComponent
    await svc.registerAppPanel({
      id: 'mwMain', name: { zh: 'A' }, entryComponent: 'dist/p.js',
      mobile: { supported: true, entryComponent: 'dist/p.mobile.js', layout: 'full' },
    } as any, 'com.test.app');
    expect(panelRow.mobile_config.entryComponent).toBe('dist/p.mobile.js');

    // sidebar 返回体
    const items = await svc.getUserSidebar('u1', ['sys:admin']);
    expect(items[0].mobile).toEqual({ supported: true, entryComponent: 'dist/p.mobile.js', layout: 'full' });
    expect(typeof (items[0] as any).mobile.supported).toBe('boolean');
  });
});
