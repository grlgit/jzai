import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppInstallService, ORPHANED_DATABASE_RESOURCES_ERROR } from './app-install.service';
import { AppManifest } from '../validators/manifest.schema';

const manifest: AppManifest = {
  manifestVersion: '1.0',
  appId: 'com.menhu.drawing.dimtuner',
  shortName: 'dimension-tuner',
  nsPrefix: 'dt',
  name: { zh: '图纸识别' },
  version: '1.0.0',
  database: { schemaName: 'app_dimension_tuner' },
};

const existingIds = {
  appIds: new Set<string>(),
  shortNames: new Set<string>(),
  nsPrefixes: new Set<string>(),
  schemaNames: new Set<string>(),
  panelIds: new Set<string>(),
  toolIds: new Set<string>(),
};

describe('AppInstallService', () => {
  const databaseUrl = 'postgres://platform:secret@localhost:5432/menhu';
  let previousDatabaseUrl: string | undefined;
  let workspaceRoot: string;
  let stageDir: string;

  beforeEach(() => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = databaseUrl;
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-workspace-'));
    stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-install-stage-'));
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest));
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
  });

  it('removes attempt-owned resources after activation fails', async () => {
    const dependencies = createDependencies(workspaceRoot);
    const activationError = new Error('backend entry missing');
    dependencies.activation.activateApp.mockRejectedValue(activationError);

    await expect(dependencies.service.installFromStage(stageDir)).rejects.toBe(activationError);

    const normalizedManifest = expect.objectContaining({ appId: manifest.appId });
    expect(dependencies.activation.deactivateApp).toHaveBeenCalledWith(manifest.appId, 'uninstall');
    expect(dependencies.activation.removePanels).toHaveBeenCalledWith(manifest.appId);
    expect(dependencies.activation.removeAgents).toHaveBeenCalledWith(normalizedManifest);
    expect(dependencies.activation.removeSkills).toHaveBeenCalledWith(normalizedManifest);
    expect(dependencies.pools.destroyPool).toHaveBeenCalledWith(manifest.appId);
    expect(dependencies.migrations.dropAll).toHaveBeenCalledWith(manifest.appId);
    expect(dependencies.schema.dropSchemaAndRole).toHaveBeenCalledWith(normalizedManifest);
    expect(fs.existsSync(path.join(workspaceRoot, 'app-store', manifest.shortName))).toBe(false);
    expect(dependencies.registry.delete).toHaveBeenCalledWith(manifest.appId);
    expect(dependencies.registry.updateStatus).toHaveBeenCalledWith(manifest.appId, 'failed');
    expect(dependencies.registry.updateStatus).not.toHaveBeenCalledWith(manifest.appId, 'active');
  });

  it('removes only the copied directory when registry creation fails', async () => {
    const dependencies = createDependencies(workspaceRoot);
    const registryError = new Error('registry unavailable');
    dependencies.registry.create.mockRejectedValue(registryError);

    await expect(dependencies.service.installFromStage(stageDir)).rejects.toBe(registryError);

    expect(fs.existsSync(path.join(workspaceRoot, 'app-store', manifest.shortName))).toBe(false);
    expect(dependencies.schema.createSchemaAndRole).not.toHaveBeenCalled();
    expect(dependencies.pools.destroyPool).not.toHaveBeenCalled();
    expect(dependencies.migrations.dropAll).not.toHaveBeenCalled();
    expect(dependencies.activation.deactivateApp).not.toHaveBeenCalled();
    expect(dependencies.registry.delete).not.toHaveBeenCalled();
  });

  it('uses discrete PostgreSQL settings when DATABASE_URL is absent', async () => {
    const previousEnvironment = {
      databaseUrl: process.env.DATABASE_URL,
      host: process.env.PG_HOST,
      port: process.env.PG_PORT,
      database: process.env.PG_DATABASE,
    };
    delete process.env.DATABASE_URL;
    process.env.PG_HOST = 'postgres';
    process.env.PG_PORT = '5433';
    process.env.PG_DATABASE = 'menhu';

    try {
      const dependencies = createDependencies(workspaceRoot);
      dependencies.activation.activateApp.mockRejectedValue(new Error('backend entry missing'));

      await expect(dependencies.service.installFromStage(stageDir)).rejects.toThrow('backend entry missing');

      expect(dependencies.pools.createPool).toHaveBeenCalledWith(
        manifest.appId,
        expect.objectContaining({ host: 'postgres', port: 5433, database: 'menhu' }),
      );
    } finally {
      restoreEnvironment(previousEnvironment);
    }
  });

  it('preserves the installation error when cleanup also fails', async () => {
    const dependencies = createDependencies(workspaceRoot);
    const activationError = new Error('backend entry missing');
    dependencies.activation.activateApp.mockRejectedValue(activationError);
    dependencies.registry.delete.mockRejectedValue(new Error('registry cleanup failed'));

    await expect(dependencies.service.installFromStage(stageDir)).rejects.toBe(activationError);

    expect(dependencies.registry.updateStatus).toHaveBeenCalledWith(manifest.appId, 'failed');
    expect(dependencies.registry.delete).toHaveBeenCalledWith(manifest.appId);
  });

  it('restores an uninstalled app with its retained schema and role', async () => {
    const dependencies = createDependencies(workspaceRoot);
    dependencies.registry.findOne.mockResolvedValue({
      appId: manifest.appId,
      status: 'uninstalled',
      manifest,
    });

    await dependencies.service.installFromStage(stageDir, { enabled: true });

    expect(dependencies.registry.restore).toHaveBeenCalledWith(
      expect.objectContaining({ appId: manifest.appId }),
      { enabled: true },
      expect.stringContaining(manifest.shortName),
    );
    expect(dependencies.schema.restoreSchemaAndRole).toHaveBeenCalledWith(
      expect.objectContaining({ appId: manifest.appId }),
      expect.any(String),
    );
    expect(dependencies.schema.createSchemaAndRole).not.toHaveBeenCalled();
    expect(dependencies.registry.updateStatus).toHaveBeenCalledWith(manifest.appId, 'active');
  });

  it('returns an uninstalled app to its retained state when restoration fails', async () => {
    const dependencies = createDependencies(workspaceRoot);
    dependencies.registry.findOne.mockResolvedValue({
      appId: manifest.appId,
      status: 'uninstalled',
      manifest,
    });
    const activationError = new Error('backend entry missing');
    dependencies.activation.activateApp.mockRejectedValue(activationError);

    await expect(dependencies.service.installFromStage(stageDir)).rejects.toBe(activationError);

    expect(dependencies.registry.updateStatus).toHaveBeenCalledWith(manifest.appId, 'uninstalled');
    expect(dependencies.registry.delete).not.toHaveBeenCalled();
    expect(dependencies.schema.dropSchemaAndRole).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before clearing unregistered database residue', async () => {
    const dependencies = createDependencies(workspaceRoot);
    dependencies.schema.getResourceState.mockResolvedValue({
      roleExists: true,
      schemaExists: true,
      schemaOwner: 'app_dimension_tuner_role',
    });

    await expect(dependencies.service.installFromStage(stageDir)).rejects.toThrow(
      ORPHANED_DATABASE_RESOURCES_ERROR,
    );
    expect(dependencies.schema.purgeOrphanedResources).not.toHaveBeenCalled();

    await dependencies.service.installFromStage(stageDir, {}, undefined, { purgeOrphanedData: true });

    expect(dependencies.schema.purgeOrphanedResources).toHaveBeenCalledWith(
      expect.objectContaining({ appId: manifest.appId }),
    );
    expect(dependencies.schema.createSchemaAndRole).toHaveBeenCalled();
  });
});

function restoreEnvironment(previous: {
  databaseUrl: string | undefined;
  host: string | undefined;
  port: string | undefined;
  database: string | undefined;
}): void {
  const entries: Array<[string, string | undefined]> = [
    ['DATABASE_URL', previous.databaseUrl],
    ['PG_HOST', previous.host],
    ['PG_PORT', previous.port],
    ['PG_DATABASE', previous.database],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function createDependencies(workspaceRoot: string) {
  const validator = {
    validate: jest.fn().mockResolvedValue({ passed: true, criticals: [] }),
  };
  const registry = {
    getExistingIds: jest.fn().mockResolvedValue(existingIds),
    findOne: jest.fn().mockResolvedValue(null),
    create: jest.fn().mockResolvedValue(undefined),
    restore: jest.fn().mockResolvedValue(undefined),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    updatePackageIntegrity: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  };
  const schema = {
    checkCreaterolePrivilege: jest.fn().mockResolvedValue(true),
    getResourceState: jest.fn().mockResolvedValue({ roleExists: false, schemaExists: false, schemaOwner: null }),
    purgeOrphanedResources: jest.fn().mockResolvedValue(undefined),
    createSchemaAndRole: jest.fn().mockResolvedValue(undefined),
    restoreSchemaAndRole: jest.fn().mockResolvedValue(undefined),
    dropSchemaAndRole: jest.fn().mockResolvedValue(undefined),
    getRoleName: jest.fn().mockReturnValue('app_dimension_tuner_role'),
  };
  const migrations = {
    plan: jest.fn().mockResolvedValue({ toRun: [], irreversibleVersions: [] }),
    up: jest.fn().mockResolvedValue(undefined),
    dropAll: jest.fn().mockResolvedValue(undefined),
  };
  const pools = {
    createPool: jest.fn().mockResolvedValue(undefined),
    destroyPool: jest.fn().mockResolvedValue(undefined),
  };
  const activation = {
    activateApp: jest.fn().mockResolvedValue(undefined),
    deactivateApp: jest.fn(),
    removePanels: jest.fn().mockResolvedValue(undefined),
    removeAgents: jest.fn(),
    removeSkills: jest.fn(),
    reloadRegistries: jest.fn(),
  };
  const service = new AppInstallService(
    { getRoot: jest.fn().mockReturnValue(workspaceRoot) } as any,
    { extract: jest.fn() } as any,
    validator as any,
    registry as any,
    schema as any,
    migrations as any,
    pools as any,
    activation as any,
    { replaceForApp: jest.fn(), removeForApp: jest.fn().mockResolvedValue(undefined) } as any,
    { extractAndStoreSecrets: jest.fn((_appId: string, config: any) => Promise.resolve(config)), deleteAllSecrets: jest.fn().mockResolvedValue(undefined) } as any,
    { hashFile: jest.fn().mockResolvedValue('sha256'), verifyDirectory: jest.fn().mockReturnValue({ status: 'unsigned' }), check: jest.fn().mockReturnValue({ ok: true }) } as any,
    { hasValidLicense: jest.fn().mockResolvedValue(true) } as any,
  );

  return { service, registry, schema, migrations, pools, activation };
}
