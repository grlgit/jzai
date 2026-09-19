import { AppGrantService } from './app-grant.service';
import { AppManifest } from '../validators/manifest.schema';
import { createUserPrincipal } from '../runtime/invocation-principal';

const manifest = {
  appId: 'com.example.ps',
  nsPrefix: 'ps',
  permissions: [
    { id: 'ps:use', label: { zh: '查看' }, default: 'user' },
    { id: 'ps:plan', label: { zh: '排程' }, default: 'none' },
    { id: 'ps:publish', label: { zh: '生效' }, default: 'admin' },
  ],
  backend: {
    entry: 'dist/index.js',
    module: 'PsModule',
    toolProviders: [{
      class: 'PsTools',
      toolIds: ['ps_sync', 'ps_publish'],
      permissions: { ps_sync: 'ps:plan', ps_publish: 'ps:publish' },
    }],
    controllers: [{
      class: 'PsController',
      handlers: ['PsController.list', 'PsController.confirm'],
      permissions: { 'PsController.confirm': 'ps:publish' },
    }],
  },
} as unknown as AppManifest;

function createService(grantRows: Array<Record<string, unknown>> = []) {
  const db = {
    query: jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes('FROM jz_app_grants g')) {
        const [appId, ...rest] = params;
        const byPermission = sql.includes('g.permission_id=$2');
        const permissionId = byPermission ? rest[0] : undefined;
        const [userId, roleIds, departmentIds] = byPermission ? rest.slice(1) : rest;
        const matched = grantRows.filter(g =>
          g.app_id === appId
          && g.level !== 'none'
          && (!byPermission || g.permission_id === permissionId)
          && (
            (g.target_type === 'user' && g.target_id === userId)
            || (g.target_type === 'role' && (roleIds as string[]).includes(g.target_id as string))
            || (g.target_type === 'department' && (departmentIds as string[]).includes(g.target_id as string))
          ),
        );
        return { rows: matched.slice(0, 1).map(() => ({ '?column?': 1 })) };
      }
      throw new Error(`unexpected sql: ${sql}`);
    }),
  };
  const registry = { findOne: jest.fn().mockResolvedValue({ manifest }) };
  const service = new AppGrantService(db as any, registry as any);
  return { service, registry };
}

const principalOf = (id: string, roleId?: string) =>
  createUserPrincipal({ id, roleId }, 'test');

describe('AppGrantService fine-grained permissions', () => {
  it('resolves declared required permissions for tools and handlers', async () => {
    const { service } = createService();
    await expect(service.getRequiredToolPermission('com.example.ps', 'ps_sync')).resolves.toBe('ps:plan');
    await expect(service.getRequiredToolPermission('com.example.ps', 'ps_unknown')).resolves.toBeUndefined();
    await expect(service.getRequiredHandlerPermission('com.example.ps', 'PsController.confirm')).resolves.toBe('ps:publish');
    await expect(service.getRequiredHandlerPermission('com.example.ps', 'PsController.list')).resolves.toBeUndefined();
  });

  it('allows via user-target grant regardless of permission default', async () => {
    const { service } = createService([
      { app_id: 'com.example.ps', permission_id: 'ps:publish', target_type: 'user', target_id: 'u1', level: 'user' },
    ]);
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:publish', principalOf('u1'))).resolves.toBe(true);
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:publish', principalOf('u2'))).resolves.toBe(false);
  });

  it('allows via role-target grant', async () => {
    const { service } = createService([
      { app_id: 'com.example.ps', permission_id: 'ps:plan', target_type: 'role', target_id: 'planner', level: 'user' },
    ]);
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:plan', principalOf('u1', 'planner'))).resolves.toBe(true);
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:plan', principalOf('u2', 'viewer'))).resolves.toBe(false);
  });

  it('falls back to manifest default when no grant matches', async () => {
    const { service } = createService();
    // ps:use default='user' → 放行；ps:plan default='none' → 拒绝；ps:publish default='admin' → 拒绝（admin 由调用方直通）
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:use', principalOf('u1'))).resolves.toBe(true);
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:plan', principalOf('u1'))).resolves.toBe(false);
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:publish', principalOf('u1'))).resolves.toBe(false);
  });

  it('fails closed for anonymous principals', async () => {
    const { service } = createService();
    await expect(service.hasPermissionForPrincipal('com.example.ps', 'ps:use', {
      ...principalOf('u1'),
      userId: undefined,
    })).resolves.toBe(false);
  });
});
