import { PanelService, SidebarItem } from './panel.service';
import { DbService } from '../../db/db.service';

/** 构建 mock DbService */
function makeDb(panels: any[], appTableExists = false, grants: any[] = []) {
  return {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('to_regclass')) {
        return { rows: [{ tbl: appTableExists ? 'jz_installed_apps' : null }] };
      }
      if (sql.includes('jz_panels')) {
        const userId = params?.[0];
        return {
          rows: panels.map(p => ({
            id: p.id,
            name: p.name,
            icon: p.icon ?? '',
            permission: p.permission ?? null,
            isBuiltin: p.isBuiltin ?? p.is_builtin ?? false,
            category: p.category ?? 'builtin',
            sourceAppId: p.sourceAppId ?? p.source_app_id ?? null,
            agentId: p.agentId ?? p.agent_id ?? null,
            uninstallable: p.uninstallable ?? false,
            nameI18n: p.nameI18n ?? p.name_i18n ?? null,
            visible: true,
            groupName: p.groupName ?? '',
            sortOrder: p.sortOrder ?? p.sort_order ?? 1,
            customName: null,
            customIcon: null,
            grantRole: grants.find(g =>
              g.app_id === (p.sourceAppId ?? p.source_app_id) && g.user_id === userId,
            )?.role ?? null,
          })),
        };
      }
      return { rows: [] };
    }),
  } as unknown as DbService;
}

const mockWorkspace = { getUserFilePath: jest.fn(() => '/tmp/test') } as any;

// 辅助：构造一个 third_party 面板
function thirdPartyPanel(id: string, sourceAppId = 'app-1') {
  return {
    id, name: '测试应用', icon: '', permission: 'app:use',
    isBuiltin: false, category: 'third_party',
    sourceAppId, agent_id: null, uninstallable: true,
    name_i18n: { zh: '测试应用', en: 'TestApp' },
    sort_order: 10,
  };
}

describe('PanelService.getUserSidebar 三方面板过滤', () => {
  let service: PanelService;

  it('admin 无 grant → 三方面板可见', async () => {
    const panels = [thirdPartyPanel('app-panel')];
    service = new PanelService(makeDb(panels), mockWorkspace);
    const result = await service.getUserSidebar('user-admin', ['sys:admin']);
    expect(result.find(p => p.id === 'app-panel')).toBeDefined();
  });

  it('普通用户无 grant → 三方面板不可见', async () => {
    const panels = [thirdPartyPanel('app-panel')];
    service = new PanelService(makeDb(panels), mockWorkspace);
    const result = await service.getUserSidebar('user-normal', ['kb:read']);
    expect(result.find(p => p.id === 'app-panel')).toBeUndefined();
  });

  it('普通用户有 grant → 三方面板可见', async () => {
    const panels = [thirdPartyPanel('app-panel', 'app-1')];
    const grants = [{ app_id: 'app-1', user_id: 'user-granted', role: 'user' }];
    service = new PanelService(makeDb(panels, false, grants), mockWorkspace);
    const result = await service.getUserSidebar('user-granted', ['kb:read']);
    expect(result.find(p => p.id === 'app-panel')).toBeDefined();
  });

  it('system 类别面板始终返回（无需权限）', async () => {
    const panels = [{ id: 'cfg', name: '设置', icon: '⚙', permission: null, isBuiltin: true, category: 'system', uninstallable: false, sort_order: 9 }];
    service = new PanelService(makeDb(panels), mockWorkspace);
    const result = await service.getUserSidebar('user-normal', ['kb:read']);
    expect(result.find(p => p.id === 'cfg')).toBeDefined();
  });

  it('system 类别面板 uninstallable=false', async () => {
    const panels = [{ id: 'cfg', name: '设置', icon: '⚙', permission: null, isBuiltin: true, category: 'system', uninstallable: false, sort_order: 9 }];
    service = new PanelService(makeDb(panels), mockWorkspace);
    const result = await service.getUserSidebar('user-admin', ['sys:admin']);
    const cfg = result.find(p => p.id === 'cfg');
    expect(cfg?.uninstallable).toBe(false);
  });

  it('返回体包含 agentId 和 category 字段', async () => {
    const panels = [{
      id: 'skills', name: '技能', icon: '', permission: 'cfg:automation',
      isBuiltin: false, category: 'builtin', agent_id: 'skill_master',
      uninstallable: false, sort_order: 5,
    }];
    service = new PanelService(makeDb(panels), mockWorkspace);
    const result = await service.getUserSidebar('admin', ['sys:admin']);
    const item = result.find(p => p.id === 'skills');
    expect(item?.agentId).toBe('skill_master');
    expect(item?.category).toBe('builtin');
  });

  it('nameI18n 透传到返回体', async () => {
    const panels = [thirdPartyPanel('app-panel')];
    const grants = [{ app_id: 'app-1', user_id: 'u1', role: 'user' }];
    service = new PanelService(makeDb(panels, false, grants), mockWorkspace);
    const result = await service.getUserSidebar('u1', ['kb:read']);
    const item = result.find(p => p.id === 'app-panel') as SidebarItem;
    expect(item?.nameI18n).toEqual({ zh: '测试应用', en: 'TestApp' });
  });
});
