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
