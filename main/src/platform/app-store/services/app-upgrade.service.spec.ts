import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppUpgradeService } from './app-upgrade.service';

const manifest = {
  manifestVersion: '1.0' as const,
  appId: 'com.test.sample',
  shortName: 'sample-app',
  nsPrefix: 'sa',
  name: { zh: '示例应用' },
  version: '1.0.1',
  database: { schemaName: 'app_sample_app' },
  backend: {
    entry: 'dist/backend/index.js',
    module: 'SampleAppModule',
    toolProviders: [{ class: 'SampleTools', toolIds: ['sa_run'] }],
  },
  panels: [{ id: 'saMain', name: { zh: '示例' } }],
};

describe('AppUpgradeService validation', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-upgrade-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('excludes every identifier owned by the current app from uniqueness checks', async () => {
    const ids = {
      appIds: new Set([manifest.appId, 'com.other.app']),
      shortNames: new Set([manifest.shortName, 'other-app']),
      nsPrefixes: new Set([manifest.nsPrefix, 'ot']),
      schemaNames: new Set([manifest.database.schemaName, 'app_other_app']),
      panelIds: new Set([manifest.panels[0].id, 'otMain']),
      toolIds: new Set([manifest.backend.toolProviders[0].toolIds[0], 'ot_run']),
    };
    const validator = {
      validate: jest.fn(async (_dir, appIds, shortNames, nsPrefixes, schemaNames, panelIds, toolIds) => {
        expect(appIds).toEqual(new Set(['com.other.app']));
        expect(shortNames).toEqual(new Set(['other-app']));
        expect(nsPrefixes).toEqual(new Set(['ot']));
        expect(schemaNames).toEqual(new Set(['app_other_app']));
        expect(panelIds).toEqual(new Set(['otMain']));
        expect(toolIds).toEqual(new Set(['ot_run']));
        return { passed: true, criticals: [], warnings: [], all: [] };
      }),
    };
    const registry = {
      findOne: jest.fn().mockResolvedValue({ manifest }),
      getExistingIds: jest.fn().mockResolvedValue(ids),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      updateManifest: jest.fn().mockResolvedValue(undefined),
      updatePackageIntegrity: jest.fn().mockResolvedValue(undefined),
    };
    const archives = {
      extract: jest.fn(async (_archive, destination) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest));
      }),
    };
    const activation = {
      deactivateApp: jest.fn(),
      removePanels: jest.fn().mockResolvedValue(undefined),
      removeAgents: jest.fn(),
      removeSkills: jest.fn(),
      activateApp: jest.fn().mockResolvedValue(undefined),
    };
    const service = new AppUpgradeService(
      { getRoot: () => root } as any,
      archives as any,
      validator as any,
      registry as any,
      { getCurrentVersion: jest.fn().mockResolvedValue(0) } as any,
      { hasPool: () => false } as any,
      activation as any,
      { hashFile: jest.fn().mockResolvedValue('sha256'), verifyDirectory: jest.fn().mockReturnValue({ status: 'unsigned' }), check: jest.fn().mockReturnValue({ ok: true }) } as any,
      { hasValidLicense: jest.fn().mockResolvedValue(true) } as any,
    );

    await service.upgrade(manifest.appId, path.join(root, 'package.jzapp'));

    expect(validator.validate).toHaveBeenCalledTimes(1);
    expect(registry.updateStatus).toHaveBeenLastCalledWith(manifest.appId, 'active');
  });
});

describe('AppUpgradeService atomic rollback', () => {
  let root: string;
  let oldDir: string;

  const oldManifest = { ...manifest, version: '1.0.0' };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-upgrade-rb-'));
    oldDir = path.join(root, 'app-store', manifest.shortName, 'versions', '1.0.0');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, 'manifest.json'), JSON.stringify(oldManifest));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function setup(overrides: {
    activation?: any;
    migrations?: any;
    pools?: any;
  } = {}) {
    const registry = {
      findOne: jest.fn().mockResolvedValue({ manifest: oldManifest, installDir: oldDir }),
      getExistingIds: jest.fn().mockResolvedValue({
        appIds: new Set([manifest.appId]),
        shortNames: new Set([manifest.shortName]),
        nsPrefixes: new Set([manifest.nsPrefix]),
        schemaNames: new Set([manifest.database.schemaName]),
        panelIds: new Set([manifest.panels[0].id]),
        toolIds: new Set([manifest.backend.toolProviders[0].toolIds[0]]),
      }),
      updateStatus: jest.fn().mockResolvedValue(undefined),
      updateManifest: jest.fn().mockResolvedValue(undefined),
      updatePackageIntegrity: jest.fn().mockResolvedValue(undefined),
    };
    const validator = {
      validate: jest.fn().mockResolvedValue({ passed: true, criticals: [], warnings: [], all: [] }),
    };
    const archives = {
      extract: jest.fn(async (_archive: string, destination: string) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest));
      }),
    };
    const activation = {
      deactivateApp: jest.fn().mockResolvedValue(undefined),
      removePanels: jest.fn().mockResolvedValue(undefined),
      removeAgents: jest.fn(),
      removeSkills: jest.fn(),
      activateApp: jest.fn().mockResolvedValue(undefined),
      ...overrides.activation,
    };
    const migrations = {
      getCurrentVersion: jest.fn().mockResolvedValue(1),
      plan: jest.fn().mockResolvedValue({ toRun: [{ version: 2, file: 'm/002.sql', checksum: 'x' }], irreversibleVersions: [] }),
      up: jest.fn().mockResolvedValue(undefined),
      down: jest.fn().mockResolvedValue(undefined),
      ...overrides.migrations,
    };
    const pools = { hasPool: () => true, ...overrides.pools };
    const service = new AppUpgradeService(
      { getRoot: () => root } as any,
      archives as any,
      validator as any,
      registry as any,
      migrations as any,
      pools as any,
      activation as any,
      { hashFile: jest.fn().mockResolvedValue('sha256'), verifyDirectory: jest.fn().mockReturnValue({ status: 'unsigned' }), check: jest.fn().mockReturnValue({ ok: true }) } as any,
      { hasValidLicense: jest.fn().mockResolvedValue(true) } as any,
    );
    return { service, registry, activation, migrations };
  }

  it('restores the old version when new backend activation fails', async () => {
    const activationError = new Error('backend entry missing');
    const { service, registry, activation } = setup({
      activation: {
        activateApp: jest.fn()
          .mockRejectedValueOnce(activationError) // 新版本激活失败
          .mockResolvedValueOnce(undefined),      // 旧版本恢复成功
      },
    });

    await expect(service.upgrade(manifest.appId, 'pkg.jzapp')).rejects.toBe(activationError);

    // 指针从未切换
    expect(registry.updateManifest).not.toHaveBeenCalled();
    // 旧版本被重新激活，状态恢复 active 而非 failed
    expect(activation.activateApp).toHaveBeenLastCalledWith(manifest.appId, oldDir, oldManifest);
    expect(registry.updateStatus).toHaveBeenLastCalledWith(manifest.appId, 'active');
    // 新版本目录已清理，旧目录完整
    const newDir = path.join(root, 'app-store', manifest.shortName, 'versions', manifest.version);
    expect(fs.existsSync(newDir)).toBe(false);
    expect(fs.existsSync(path.join(oldDir, 'manifest.json'))).toBe(true);
  });

  it('rolls back applied migrations when activation fails after migrating', async () => {
    const { service, migrations } = setup({
      activation: {
        activateApp: jest.fn()
          .mockRejectedValueOnce(new Error('panel conflict'))
          .mockResolvedValueOnce(undefined),
      },
    });

    await expect(service.upgrade(manifest.appId, 'pkg.jzapp')).rejects.toThrow('panel conflict');

    expect(migrations.up).toHaveBeenCalledTimes(1);
    expect(migrations.down).toHaveBeenCalledWith(
      manifest.appId, 1, expect.objectContaining({ version: '1.0.1' }), expect.stringContaining('versions'),
    );
  });

  it('keeps the old version active when migration fails mid-upgrade', async () => {
    const { service, registry, activation, migrations } = setup({
      migrations: { up: jest.fn().mockRejectedValue(new Error('SQLSTATE syntax error')) },
    });

    await expect(service.upgrade(manifest.appId, 'pkg.jzapp')).rejects.toThrow('SQLSTATE');

    expect(migrations.down).not.toHaveBeenCalled(); // up 未成功，无已应用迁移
    expect(activation.activateApp).toHaveBeenCalledTimes(1); // 仅旧版本恢复
    expect(registry.updateManifest).not.toHaveBeenCalled();
    expect(registry.updateStatus).toHaveBeenLastCalledWith(manifest.appId, 'active');
  });

  it('rejects before touching the old version when the target version dir already exists', async () => {
    const newDir = path.join(root, 'app-store', manifest.shortName, 'versions', manifest.version);
    fs.mkdirSync(newDir, { recursive: true });
    const { service, registry, activation } = setup();

    await expect(service.upgrade(manifest.appId, 'pkg.jzapp')).rejects.toThrow(/Version directory already exists/);

    expect(activation.deactivateApp).not.toHaveBeenCalled();
    expect(registry.updateStatus).not.toHaveBeenCalledWith(manifest.appId, 'upgrading');
  });

  it('marks failed only when the old version cannot be restored', async () => {
    const { service, registry } = setup({
      activation: {
        activateApp: jest.fn().mockRejectedValue(new Error('always broken')),
      },
    });

    await expect(service.upgrade(manifest.appId, 'pkg.jzapp')).rejects.toThrow('always broken');
    expect(registry.updateStatus).toHaveBeenLastCalledWith(manifest.appId, 'failed');
  });
});
