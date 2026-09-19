/**
 * T3.6 — AppValidator dry-run for dimension-tuner app package.
 * Verifies zero critical errors across all 14 checks.
 *
 * Run: npx jest --testPathPattern=dim-tuner-validator --no-coverage
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { AppValidatorService } from '../platform/app-store/validators/app-validator.service';

const SOURCE_DIR = path.resolve(__dirname, '../../../app-packages/dimension-tuner');
const PACKAGE_INPUTS = ['manifest.json', 'package.json', 'dist', 'agents', 'skills', 'migrations', 'README.md'];
let packageDir: string;

// Dummy existing-ID sets (fresh install scenario — nothing pre-installed)
const EMPTY_SET = new Set<string>();

describe('dimension-tuner AppValidator dry-run (T3.6)', () => {
  let validator: AppValidatorService;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      providers: [AppValidatorService],
    }).compile();
    validator = module.get(AppValidatorService);
    packageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dim-tuner-package-'));
    for (const input of PACKAGE_INPUTS) {
      const source = path.join(SOURCE_DIR, input);
      if (fs.existsSync(source)) fs.cpSync(source, path.join(packageDir, input), { recursive: true });
    }
  });

  afterAll(() => {
    fs.rmSync(packageDir, { recursive: true, force: true });
  });

  it('passes all checks with zero criticals', async () => {
    const report = await validator.validate(
      packageDir,
      EMPTY_SET, // existingAppIds
      EMPTY_SET, // existingShortNames
      EMPTY_SET, // existingNsPrefixes
      EMPTY_SET, // existingSchemaNames
      EMPTY_SET, // existingPanelIds
      EMPTY_SET, // existingToolIds
    );

    if (report.criticals.length > 0) {
      console.error('Critical errors:', report.criticals.map(c => `[${c.id}] ${c.code}: ${c.message}`));
    }
    if (report.warnings.length > 0) {
      console.warn('Warnings:', report.warnings.map(w => `[${w.id}] ${w.code}: ${w.message}`));
    }

    expect(report.passed).toBe(true);
    expect(report.criticals).toHaveLength(0);
  });

  it('reports appId as com.menhu.drawing.dimtuner', async () => {
    const report = await validator.validate(packageDir, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET);
    expect(report.appId).toBe('com.menhu.drawing.dimtuner');
  });

  it('passes check 4 — all tool IDs have dt_ prefix', async () => {
    const report = await validator.validate(packageDir, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET);
    const toolNsErrors = report.criticals.filter(c => c.code === 'TOOL_NS_VIOLATION');
    expect(toolNsErrors).toHaveLength(0);
  });

  it('passes check 3 — dtPanel is not a builtin panel ID', async () => {
    const report = await validator.validate(packageDir, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET);
    const panelErrors = report.criticals.filter(c => c.code === 'DUPLICATE_PANEL_ID');
    expect(panelErrors).toHaveLength(0);
  });

  it('passes check 11 — all dt_ agent tools declared in manifest', async () => {
    const report = await validator.validate(packageDir, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET);
    const agentToolErrors = report.criticals.filter(c => c.code === 'AGENT_TOOL_NOT_DECLARED');
    expect(agentToolErrors).toHaveLength(0);
  });

  it('passes check 12 — migrations are consecutive and have no CONCURRENTLY', async () => {
    const report = await validator.validate(packageDir, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET, EMPTY_SET);
    const migrationErrors = report.criticals.filter(c => c.id === 12);
    expect(migrationErrors).toHaveLength(0);
  });
});
