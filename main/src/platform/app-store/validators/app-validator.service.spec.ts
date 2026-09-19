/**
 * AppValidatorService — Check 15 (globalThis writes) 单元测试
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppValidatorService } from './app-validator.service';

const VALID_MANIFEST = {
  manifestVersion: '1.0',
  appId: 'com.test.global-write',
  shortName: 'global-write',
  nsPrefix: 'gw',
  name: { zh: '测试包' },
  version: '1.0.0',
};

function makePkg(files: Record<string, string>, manifest: any = VALID_MANIFEST): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzapp-validate-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('AppValidatorService · Check 15 globalThis writes', () => {
  let service: AppValidatorService;
  const empties = () => ({
    existingAppIds: new Set<string>(),
    existingShortNames: new Set<string>(),
    existingNsPrefixes: new Set<string>(),
    existingSchemaNames: new Set<string>(),
    existingPanelIds: new Set<string>(),
    existingToolIds: new Set<string>(),
  });

  beforeEach(() => { service = new AppValidatorService(); });

  it('flags globalThis assignment in dist code', async () => {
    const dir = makePkg({ 'dist/index.js': `globalThis.myCache = {};\nmodule.exports = {};\n` });
    const report = await service.validate(dir, ...Object.values(empties()) as any);
    const hits = report.all.filter(r => r.code === 'GLOBAL_THIS_WRITE');
    expect(hits.length).toBe(1);
    expect(hits[0].level).toBe('warning');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does NOT flag delete cleanup (defensive clear is allowed)', async () => {
    const dir = makePkg({ 'dist/index.js': `delete globalThis.pdfjsWorker;\ndelete (globalThis).pdfjsWorker;\n` });
    const report = await service.validate(dir, ...Object.values(empties()) as any);
    expect(report.all.filter(r => r.code === 'GLOBAL_THIS_WRITE').length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags known-bad pdfjsWorker writer inside bundled node_modules', async () => {
    const dir = makePkg({
      'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs': `var x = globalThis.pdfjsWorker = {};\n`,
    });
    const report = await service.validate(dir, ...Object.values(empties()) as any);
    const hits = report.all.filter(r => r.code === 'GLOBAL_THIS_WRITE_KNOWN_BAD');
    expect(hits.length).toBe(1);
    expect(hits[0].details).toContain('pdfjs-dist');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags globalThis["key"] bracket assignment in skills', async () => {
    const dir = makePkg({ 'skills/s/scripts/handler.ts': `globalThis["shared"] = 1;\n` });
    const report = await service.validate(dir, ...Object.values(empties()) as any);
    expect(report.all.filter(r => r.code === 'GLOBAL_THIS_WRITE').length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('AppValidatorService · manifest reference closure', () => {
  let service: AppValidatorService;
  const emptySets = Array.from({ length: 6 }, () => new Set<string>());
  const manifest = {
    ...VALID_MANIFEST,
    icon: 'assets/icon.svg',
    migrations: [{ version: 1, file: './migrations/001.sql' }],
    agents: [{ file: 'agents/gw_assistant.yaml' }],
    skills: [{ dir: 'skills/gw-format' }],
    backend: { entry: 'dist/backend/index.js', module: 'GlobalWriteModule' },
    panels: [{
      id: 'gwMain',
      name: { zh: '测试' },
      entryComponent: 'dist/pages/Main.js',
      messageSchema: 'dist/schemas/message.js',
      icon: 'assets/panel.svg',
    }],
  };
  const files = {
    'assets/icon.svg': '<svg/>',
    'assets/panel.svg': '<svg/>',
    'migrations/001.sql': 'CREATE TABLE example(id text);',
    'agents/gw_assistant.yaml': 'agent:\n  id: gw_assistant\n  tools: []\n',
    'skills/gw-format/SKILL.md': '---\nname: gw-format\n---\n',
    'dist/backend/index.js': 'class GlobalWriteModule { static forApp() { return { toolProviders: [] }; } } exports.GlobalWriteModule = GlobalWriteModule;',
    'dist/pages/Main.js': 'const Main = () => null; export { Main as default };',
    'dist/schemas/message.js': 'export default function validate() { return true; }',
  };

  beforeEach(() => { service = new AppValidatorService(); });

  async function validate(overrides: Record<string, unknown> = {}, packageFiles: Record<string, string> = files) {
    const dir = makePkg(packageFiles, { ...manifest, ...overrides });
    const report = await service.validate(dir, ...emptySets as any);
    return { dir, report };
  }

  it('accepts closed references and validates backend shape without executing it', async () => {
    const dangerousFiles = {
      ...files,
      'dist/backend/index.js': 'throw new Error("must not execute"); class GlobalWriteModule { static forApp() {} } exports.GlobalWriteModule = GlobalWriteModule;',
    };
    const { dir, report } = await validate({}, dangerousFiles);
    expect(report.criticals).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('accepts a legacy skill directory reference with a trailing slash', async () => {
    const { dir, report } = await validate({ skills: [{ dir: 'skills/gw-format/' }] });
    expect(report.criticals).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each([
    ['REFERENCE_MISSING', { agents: [{ file: 'agents/missing.yaml' }] }],
    ['REFERENCE_CASE_MISMATCH', { panels: [{ id: 'gwMain', name: { zh: '测试' }, entryComponent: 'dist/pages/main.js' }] }],
    ['REFERENCE_PATH_TRAVERSAL', { migrations: [{ version: 1, file: '../outside.sql' }] }],
    ['REFERENCE_ABSOLUTE_PATH', { backend: { entry: '/tmp/index.js', module: 'GlobalWriteModule' } }],
    ['REFERENCE_WRONG_KIND', { skills: [{ dir: 'assets/icon.svg' }] }],
  ])('rejects %s references', async (code, overrides) => {
    const { dir, report } = await validate(overrides as Record<string, unknown>);
    expect(report.criticals.some(result => result.code === code)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects symlinks without following them outside the package', async () => {
    const { dir } = await validate();
    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.yaml`);
    fs.writeFileSync(outside, 'agent: {}');
    fs.rmSync(path.join(dir, 'agents', 'gw_assistant.yaml'));
    fs.symlinkSync(outside, path.join(dir, 'agents', 'gw_assistant.yaml'));
    const report = await service.validate(dir, ...emptySets as any);
    expect(report.criticals.map(result => result.code)).toEqual(expect.arrayContaining(['SYMLINK_NOT_ALLOWED', 'REFERENCE_SYMLINK']));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  });

  it('rejects malformed backend and panel module shapes', async () => {
    const malformed = {
      ...files,
      'dist/backend/index.js': 'class GlobalWriteModule { static forApp() {} }',
      'dist/pages/Main.js': 'export const Main = () => null;',
      'dist/schemas/message.js': 'export const validate = () => true;',
    };
    const { dir, report } = await validate({}, malformed);
    expect(report.criticals.map(result => result.code)).toEqual(expect.arrayContaining([
      'BACKEND_MODULE_SHAPE_INVALID',
      'PANEL_ENTRY_SHAPE_INVALID',
      'PANEL_MESSAGE_SCHEMA_SHAPE_INVALID',
    ]));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects backend entries with invalid JavaScript syntax', async () => {
    const malformed = { ...files, 'dist/backend/index.js': 'class GlobalWriteModule {' };
    const { dir, report } = await validate({}, malformed);
    expect(report.criticals.map(result => result.code)).toContain('BACKEND_ENTRY_SYNTAX_INVALID');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
