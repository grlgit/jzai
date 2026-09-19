jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    rmSync: jest.fn(actual.rmSync),
    renameSync: jest.fn(actual.renameSync),
  };
});

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppActivationService, APP_CONFIG_ARTIFACT_PERMISSION } from './app-activation.service';

describe('AppActivationService', () => {
  let root: string;
  let installDir: string;
  let agentsDir: string;
  let configDir: string;
  let service: AppActivationService;

  beforeEach(() => {
    const actualFs = jest.requireActual<typeof import('fs')>('fs');
    (fs.rmSync as jest.Mock).mockReset().mockImplementation(actualFs.rmSync);
    (fs.renameSync as jest.Mock).mockReset().mockImplementation(actualFs.renameSync);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'app-activation-'));
    installDir = path.join(root, 'install');
    agentsDir = path.join(root, 'agents');
    configDir = path.join(root, 'config');
    fs.mkdirSync(path.join(installDir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(installDir, 'skills', 'probe', 'nested'), { recursive: true });

    service = new AppActivationService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { loadAll: jest.fn() } as any,
      {
        getAgentsDir: jest.fn().mockReturnValue(agentsDir),
        getConfigDir: jest.fn().mockReturnValue(configDir),
      } as any,
      { replaceForApp: jest.fn(), removeForApp: jest.fn() } as any,
      { append: jest.fn(), read: jest.fn().mockReturnValue([]) } as any,
      { buildFacade: jest.fn().mockReturnValue(undefined) } as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete (global as any).nestApp;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes readable agent and skill content without Finder metadata', () => {
    const agentSource = path.join(installDir, 'agents', 'dt_probe.yaml');
    fs.writeFileSync(agentSource, 'agent:\n  id: dt_probe\n');
    fs.chmodSync(agentSource, 0o600);
    fs.writeFileSync(path.join(installDir, 'agents', '._dt_probe.yaml'), 'metadata');
    fs.writeFileSync(path.join(installDir, 'skills', 'probe', 'handler.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(installDir, 'skills', 'probe', 'nested', 'guide.md'), 'guide');
    fs.writeFileSync(path.join(installDir, 'skills', 'probe', '._handler.js'), 'metadata');
    fs.writeFileSync(path.join(installDir, 'skills', 'probe', '.DS_Store'), 'metadata');

    const manifest = {
      agents: [{ file: 'agents/dt_probe.yaml' }],
      skills: [{ dir: 'skills/probe' }],
    } as any;
    const agentPath = path.join(agentsDir, 'dt_probe.yaml');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(agentPath, 'stale agent');
    const rmSync = fs.rmSync as unknown as jest.Mock;

    service.copyAgents(manifest, installDir);
    service.copySkills(manifest, installDir);

    const skillPath = path.join(configDir, 'skills', 'probe', 'handler.js');
    expect(fs.readFileSync(agentPath, 'utf-8')).toContain('dt_probe');
    expect(rmSync).not.toHaveBeenCalledWith(agentPath, { force: true });
    expect(fs.readFileSync(skillPath, 'utf-8')).toContain('module.exports');
    expect(fs.readFileSync(path.join(configDir, 'skills', 'probe', 'nested', 'guide.md'), 'utf-8')).toBe('guide');
    const expectedMode = 0o644 & ~process.umask();
    expect(fs.statSync(agentPath).mode & 0o777).toBe(expectedMode);
    expect(fs.statSync(agentPath).mode & 0o444).not.toBe(0);
    expect(fs.statSync(skillPath).mode & 0o444).not.toBe(0);
    expect(fs.existsSync(path.join(configDir, 'skills', 'probe', '._handler.js'))).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'skills', 'probe', '.DS_Store'))).toBe(false);

    service.removeAgents(manifest);
    service.removeSkills(manifest);

    expect(fs.existsSync(agentPath)).toBe(false);
    expect(fs.existsSync(path.join(configDir, 'skills', 'probe'))).toBe(false);
  });

  it('classifies a denied atomic replacement without modifying the old agent', () => {
    const agentSource = path.join(installDir, 'agents', 'dt_probe.yaml');
    const agentPath = path.join(agentsDir, 'dt_probe.yaml');
    fs.writeFileSync(agentSource, 'agent:\n  id: dt_probe\n');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(agentPath, 'stale agent');
    (fs.renameSync as unknown as jest.Mock).mockImplementation(() => {
      const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      throw error;
    });

    expect(() => service.copyAgents({ agents: [{ file: 'agents/dt_probe.yaml' }] } as any, installDir))
      .toThrow(APP_CONFIG_ARTIFACT_PERMISSION);
    expect(fs.readFileSync(agentPath, 'utf-8')).toBe('stale agent');
  });

  it('injects the app-scoped service connection client into the backend context', async () => {
    const entry = path.join(installDir, 'backend.js');
    fs.writeFileSync(entry, 'module.exports = {};');
    const connectionClient = Object.freeze({
      listBindings: jest.fn(),
      describe: jest.fn(),
      invoke: jest.fn(),
    });
    const connectionBindings = {
      createServiceClient: jest.fn().mockReturnValue(connectionClient),
    };
    const toolBridge = { callTool: jest.fn() };
    const toolRegistry = { register: jest.fn(), registerTokenLimits: jest.fn() };
    const loader = {
      load: jest.fn().mockReturnValue({ moduleRef: { toolProviders: [] } }),
    };
    const activation = new AppActivationService(
      {
        findOne: jest.fn().mockResolvedValue({
          shortName: 'probe',
          config: {},
        }),
      } as any,
      {} as any,
      {} as any,
      loader as any,
      { loadAll: jest.fn() } as any,
      {
        getAgentsDir: jest.fn().mockReturnValue(agentsDir),
        getConfigDir: jest.fn().mockReturnValue(configDir),
      } as any,
      { replaceForApp: jest.fn(), removeForApp: jest.fn() } as any,
      { append: jest.fn(), read: jest.fn().mockReturnValue([]) } as any,
      { buildFacade: jest.fn().mockReturnValue(undefined) } as any,
    );
    (global as any).nestApp = {
      get: jest.fn((type: { name: string }) => {
        if (type.name === 'AppConnectionBindingService') return connectionBindings;
        if (type.name === 'ToolBridgeService') return toolBridge;
        if (type.name === 'DynamicToolProviderRegistry') return toolRegistry;
        return undefined;
      }),
    };
    const manifest = {
      shortName: 'probe',
      backend: {
        entry: 'backend.js',
        module: 'ProbeModule',
        toolProviders: [],
      },
    } as any;

    await (activation as any).loadBackend('com.example.probe', installDir, manifest);

    expect(connectionBindings.createServiceClient).toHaveBeenCalledWith('com.example.probe');
    expect(loader.load).toHaveBeenCalledWith(
      'com.example.probe',
      entry,
      'ProbeModule',
      expect.objectContaining({ connections: connectionClient }),
    );
  });
});
