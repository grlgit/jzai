import { Test, TestingModule } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CoWorkerAppService } from './coworker-app.service';

// 每次测试使用独立的临时目录，避免互相污染
function makeTmpDir(): string {
  const dir = path.join(os.tmpdir(), `cw-app-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeExe(dir: string, name = 'test.exe', content = 'fake-exe-content'): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('CoWorkerAppService — 上传/下载链路', () => {
  let service: CoWorkerAppService;
  let storageDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    storageDir = makeTmpDir();
    tmpDir = makeTmpDir();
    process.env.JIANZHI_COWORKER_APP_DIR = storageDir;

    const mod: TestingModule = await Test.createTestingModule({
      providers: [CoWorkerAppService],
    }).compile();
    service = mod.get(CoWorkerAppService);
  });

  afterEach(() => {
    delete process.env.JIANZHI_COWORKER_APP_DIR;
    fs.rmSync(storageDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── nextVersion via storeInstaller ───────────────────────────────────────

  describe('版本号自动递增', () => {
    it('首次上传（无 metadata）→ 1.0.0', async () => {
      const src = writeExe(tmpDir);
      const result = await service.storeInstaller(src);
      expect(result.version).toBe('1.0.0');
    });

    it('1.0.0 → 1.0.1', async () => {
      // 写入初始 metadata
      fs.writeFileSync(
        path.join(storageDir, 'metadata.json'),
        JSON.stringify({ currentVersion: '1.0.0', filename: '见智CoWorker-Setup-1.0.0-x64.exe', size: 0, updatedAt: '' }),
      );
      const src = writeExe(tmpDir);
      const result = await service.storeInstaller(src);
      expect(result.version).toBe('1.0.1');
    });

    it('1.2.9 → 1.2.10（两位 patch）', async () => {
      fs.writeFileSync(
        path.join(storageDir, 'metadata.json'),
        JSON.stringify({ currentVersion: '1.2.9', filename: '见智CoWorker-Setup-1.2.9-x64.exe', size: 0, updatedAt: '' }),
      );
      const src = writeExe(tmpDir);
      const result = await service.storeInstaller(src);
      expect(result.version).toBe('1.2.10');
    });

    it('metadata 损坏（非 semver）→ 重置为 1.0.0', async () => {
      fs.writeFileSync(
        path.join(storageDir, 'metadata.json'),
        JSON.stringify({ currentVersion: 'invalid', filename: null, size: 0, updatedAt: '' }),
      );
      const src = writeExe(tmpDir);
      const result = await service.storeInstaller(src);
      expect(result.version).toBe('1.0.0');
    });
  });

  // ─── storeInstaller ───────────────────────────────────────────────────────

  describe('storeInstaller', () => {
    it('源文件不存在 → 抛出 NotFoundException', async () => {
      await expect(service.storeInstaller('/nonexistent/path.exe'))
        .rejects.toThrow('安装器文件不存在');
    });

    it('正常上传：文件落盘 + 文件名包含版本号', async () => {
      const src = writeExe(tmpDir, 'installer.exe', 'binary-content-abc');
      const result = await service.storeInstaller(src);

      expect(result.version).toBe('1.0.0');
      expect(result.filename).toBe('见智CoWorker-Setup-1.0.0-x64.exe');
      expect(result.size).toBeGreaterThan(0);

      const destPath = path.join(storageDir, result.filename);
      expect(fs.existsSync(destPath)).toBe(true);
      expect(fs.readFileSync(destPath, 'utf-8')).toBe('binary-content-abc');
    });

    it('metadata.json 被正确写入', async () => {
      const src = writeExe(tmpDir);
      const result = await service.storeInstaller(src);

      const meta = JSON.parse(fs.readFileSync(path.join(storageDir, 'metadata.json'), 'utf-8'));
      expect(meta.currentVersion).toBe(result.version);
      expect(meta.filename).toBe(result.filename);
      expect(meta.size).toBe(result.size);
      expect(meta.updatedAt).toBeTruthy();
    });

    it('连续上传两次：版本依次递增', async () => {
      const r1 = await service.storeInstaller(writeExe(tmpDir, 'a.exe'));
      const r2 = await service.storeInstaller(writeExe(tmpDir, 'b.exe'));
      expect(r1.version).toBe('1.0.0');
      expect(r2.version).toBe('1.0.1');
    });
  });

  // ─── getCurrentInstaller ──────────────────────────────────────────────────

  describe('getCurrentInstaller', () => {
    it('未上传任何文件 → available: false', () => {
      const info = service.getCurrentInstaller();
      expect(info?.available).toBe(false);
      expect(info?.version).toBeNull();
    });

    it('metadata 存在但文件已被删除 → available: false', async () => {
      const src = writeExe(tmpDir);
      const result = await service.storeInstaller(src);

      // 手动删除 exe
      fs.unlinkSync(path.join(storageDir, result.filename));

      const info = service.getCurrentInstaller();
      expect(info?.available).toBe(false);
    });

    it('正常上传后 → available: true + 版本/路径正确', async () => {
      const src = writeExe(tmpDir);
      const result = await service.storeInstaller(src);

      const info = service.getCurrentInstaller();
      expect(info?.available).toBe(true);
      expect(info?.version).toBe(result.version);
      expect(info?.filename).toBe(result.filename);
      expect(info?.path).toBe(path.join(storageDir, result.filename));
      expect(fs.existsSync(info!.path!)).toBe(true);
    });
  });

  // ─── cleanupOldVersions ───────────────────────────────────────────────────

  describe('cleanupOldVersions', () => {
    it('只保留当前版本，旧版本被删除', async () => {
      // 上传第一个版本
      await service.storeInstaller(writeExe(tmpDir, 'v1.exe'));
      const v1file = '见智CoWorker-Setup-1.0.0-x64.exe';
      expect(fs.existsSync(path.join(storageDir, v1file))).toBe(true);

      // 上传第二个版本（metadata 指向 1.0.1）
      await service.storeInstaller(writeExe(tmpDir, 'v2.exe'));
      const v2file = '见智CoWorker-Setup-1.0.1-x64.exe';

      // 清理
      const deleted = await service.cleanupOldVersions();

      expect(deleted).toContain(v1file);
      expect(fs.existsSync(path.join(storageDir, v1file))).toBe(false);
      expect(fs.existsSync(path.join(storageDir, v2file))).toBe(true);
    });

    it('只有一个版本时，清理后什么都不删', async () => {
      await service.storeInstaller(writeExe(tmpDir));
      const deleted = await service.cleanupOldVersions();
      expect(deleted).toHaveLength(0);
    });
  });

  // ─── 完整链路：上传 → 读取 → 下载路径可用 ────────────────────────────────

  describe('端到端链路', () => {
    it('上传后 getCurrentInstaller 返回的 path 可直接读取（模拟流式下载）', async () => {
      const content = 'mock-installer-binary-data';
      const src = writeExe(tmpDir, 'installer.exe', content);

      await service.storeInstaller(src);

      const info = service.getCurrentInstaller();
      expect(info?.available).toBe(true);

      // 模拟 controller 中的 createReadStream
      const readContent = fs.readFileSync(info!.path!, 'utf-8');
      expect(readContent).toBe(content);
    });
  });
});
