import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DynamicModuleLoader } from './dynamic-module.loader';

describe('DynamicModuleLoader backend export selection', () => {
  let root: string;
  let loader: DynamicModuleLoader;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-app-'));
    loader = new DynamicModuleLoader();
  });

  afterEach(async () => {
    await loader.onModuleDestroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads the exact manifest-declared export instead of the default export', async () => {
    const entry = path.join(root, 'index.js');
    fs.writeFileSync(entry, `
      class WrongModule { static forApp() { return { marker: 'wrong' }; } }
      class ExpectedModule { static forApp() { return { marker: 'expected' }; } }
      exports.default = WrongModule;
      exports.ExpectedModule = ExpectedModule;
    `);

    const loaded = await loader.load('com.test.expected', entry, 'ExpectedModule', {} as any);

    expect(loaded.moduleRef).toEqual({ marker: 'expected' });
  });

  it('rejects a missing or malformed declared export', async () => {
    const entry = path.join(root, 'index.js');
    fs.writeFileSync(entry, 'exports.OtherModule = class OtherModule {};');

    await expect(loader.load('com.test.missing', entry, 'ExpectedModule', {} as any))
      .rejects.toThrow('Backend export ExpectedModule must provide static forApp(ctx)');
  });
});

describe('DynamicModuleLoader lifecycle', () => {
  let root: string;
  let loader: DynamicModuleLoader;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-app-life-'));
    loader = new DynamicModuleLoader();
  });

  afterEach(async () => {
    await loader.onModuleDestroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('awaits async forApp before exposing the module', async () => {
    const entry = path.join(root, 'async.js');
    fs.writeFileSync(entry, `
      class AsyncModule {
        static async forApp() {
          await new Promise(r => setTimeout(r, 10));
          return { toolProviders: [{ marker: 'ready' }] };
        }
      }
      exports.AsyncModule = AsyncModule;
    `);

    const loaded = await loader.load('com.test.async', entry, 'AsyncModule', {} as any);
    expect((loaded.moduleRef as any).toolProviders[0].marker).toBe('ready');
  });

  it('invokes onDeactivate with reason exactly once on unload', async () => {
    const entry = path.join(root, 'hooked.js');
    fs.writeFileSync(entry, `
      const calls = [];
      class HookedModule {
        static forApp() {
          return {
            toolProviders: [],
            onDeactivate(reason) { calls.push(reason); },
          };
        }
      }
      exports.HookedModule = HookedModule;
      exports.__calls = calls;
    `);

    await loader.load('com.test.hooked', entry, 'HookedModule', {} as any);
    await loader.unload('com.test.hooked', 'upgrade');
    await loader.unload('com.test.hooked', 'uninstall'); // 已卸载，不再触发

    const mod = require(entry);
    expect(mod.__calls).toEqual(['upgrade']);
  });

  it('awaits async onDeactivate and tolerates hook failures', async () => {
    const entry = path.join(root, 'failing.js');
    fs.writeFileSync(entry, `
      class FailingModule {
        static forApp() {
          return {
            toolProviders: [],
            async onDeactivate() { throw new Error('hook boom'); },
          };
        }
      }
      exports.FailingModule = FailingModule;
    `);

    await loader.load('com.test.failing', entry, 'FailingModule', {} as any);
    await expect(loader.unload('com.test.failing', 'uninstall')).resolves.toEqual({ requiresRestart: true });
    expect(loader.isLoaded('com.test.failing')).toBe(false);
  });

  it('calls onDeactivate(shutdown) for each loaded app on module destroy', async () => {
    const entry = path.join(root, 'shutdown.js');
    fs.writeFileSync(entry, `
      const calls = [];
      class ShutdownModule {
        static forApp() {
          return { toolProviders: [], onDeactivate(r) { calls.push(r); } };
        }
      }
      exports.ShutdownModule = ShutdownModule;
      exports.__calls = calls;
    `);

    await loader.load('com.test.shutdown', entry, 'ShutdownModule', {} as any);
    await loader.onModuleDestroy();

    expect(require(entry).__calls).toEqual(['shutdown']);
    expect(loader.isLoaded('com.test.shutdown')).toBe(false);
  });
});
