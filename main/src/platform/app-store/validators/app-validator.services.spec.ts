/**
 * AppValidatorService — PLAT-016 伴随服务（services）声明校验单元测试
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppValidatorService } from './app-validator.service';

const BASE_MANIFEST: any = {
  manifestVersion: '1.0',
  appId: 'com.test.svc',
  shortName: 'svc-app',
  nsPrefix: 'sv',
  name: { zh: '伴随服务测试包' },
  version: '1.0.0',
  configSchema: {
    fields: [
      { key: 'solverEndpoint', type: 'string', label: { zh: '求解端点' } },
      { key: 'solverApiKey', type: 'secret', label: { zh: '求解密钥' } },
    ],
  },
};

function makePkg(files: Record<string, string>, manifest: any): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzapp-svc-'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('AppValidatorService · PLAT-016 services 声明', () => {
  let service: AppValidatorService;
  const empties = () => ({
    existingAppIds: new Set<string>(),
    existingShortNames: new Set<string>(),
    existingNsPrefixes: new Set<string>(),
    existingSchemaNames: new Set<string>(),
    existingPanelIds: new Set<string>(),
    existingToolIds: new Set<string>(),
  });
  const validate = (dir: string) => service.validate(dir, ...Object.values(empties()) as any);
  const codes = (report: any) => report.all.map((r: any) => r.code);

  beforeEach(() => { service = new AppValidatorService(); });
  const clean = (dir: string) => fs.rmSync(dir, { recursive: true, force: true });

  it('合法 container 声明（预构建镜像）通过', async () => {
    const dir = makePkg({ 'solver/main.py': '# py' }, {
      ...BASE_MANIFEST,
      services: [{
        id: 'schedSolver', runtime: 'container', cwd: 'solver', image: 'sched-solver:1.0.0',
        containerPort: 8100,
        env: { SOLVER_API_KEY: '{secret:solverApiKey}' },
        inject: { 'config.solverEndpoint': 'http://{host}:{port}' },
      }],
    });
    const report = await validate(dir);
    expect(codes(report).filter((c: string) => c.startsWith('SERVICE_'))).toEqual([]);
    expect(report.passed).toBe(true);
    clean(dir);
  });

  it('container 未给镜像且缺 Dockerfile → critical', async () => {
    const dir = makePkg({ 'solver/main.py': '# py' }, {
      ...BASE_MANIFEST,
      services: [{ id: 'schedSolver', runtime: 'container', cwd: 'solver', containerPort: 8100 }],
    });
    const report = await validate(dir);
    expect(report.passed).toBe(false);
    expect(JSON.stringify(report.criticals)).toContain('Dockerfile');
    clean(dir);
  });

  it('service id 重复 / process 缺 command / container 缺 containerPort', async () => {
    const dir = makePkg({ 'a/x': '1', 'b/y': '2' }, {
      ...BASE_MANIFEST,
      services: [
        { id: 'svcA', runtime: 'process', cwd: 'a' },
        { id: 'svcA', runtime: 'container', cwd: 'b', image: 'img:1' },
      ],
    });
    const report = await validate(dir);
    const c = codes(report);
    expect(c).toContain('SERVICE_ID_DUPLICATE');
    expect(c).toContain('SERVICE_COMMAND_MISSING');
    expect(c).toContain('SERVICE_PORT_MISSING');
    clean(dir);
  });

  it('env {secret:*} 必须指向 configSchema secret 字段', async () => {
    const dir = makePkg({ 'solver/main.py': '# py' }, {
      ...BASE_MANIFEST,
      services: [{
        id: 'schedSolver', runtime: 'container', cwd: 'solver', image: 'img:1', containerPort: 8100,
        env: { KEY: '{secret:solverEndpoint}' }, // solverEndpoint 是 string 不是 secret
      }],
    });
    const report = await validate(dir);
    expect(codes(report)).toContain('SERVICE_SECRET_REF_INVALID');
    clean(dir);
  });

  it('inject 目标必须是 configSchema 已声明字段', async () => {
    const dir = makePkg({ 'solver/main.py': '# py' }, {
      ...BASE_MANIFEST,
      services: [{
        id: 'schedSolver', runtime: 'container', cwd: 'solver', image: 'img:1', containerPort: 8100,
        inject: { 'config.noSuchField': 'http://{host}:{port}' },
      }],
    });
    const report = await validate(dir);
    expect(codes(report)).toContain('SERVICE_INJECT_TARGET_INVALID');
    clean(dir);
  });

  it('process 形态声明 resources → warning 不阻断', async () => {
    const dir = makePkg({ 'solver/main.py': '# py' }, {
      ...BASE_MANIFEST,
      services: [{
        id: 'schedSolver', runtime: 'process', cwd: 'solver',
        command: ['python3', 'main.py'],
        resources: { cpuMillis: 1000 },
      }],
    });
    const report = await validate(dir);
    expect(report.passed).toBe(true);
    const hit = report.all.find((r: any) => r.code === 'SERVICE_RESOURCES_IGNORED');
    expect(hit?.level).toBe('warning');
    clean(dir);
  });

  it('cwd 不存在 → critical 引用错误', async () => {
    const dir = makePkg({}, {
      ...BASE_MANIFEST,
      services: [{ id: 'schedSolver', runtime: 'process', cwd: 'no-such-dir', command: ['x'] }],
    });
    const report = await validate(dir);
    expect(report.passed).toBe(false);
    clean(dir);
  });
});
