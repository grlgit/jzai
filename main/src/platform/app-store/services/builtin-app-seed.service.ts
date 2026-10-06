import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppRegistryService } from './app-registry.service';
import { AppInstallService } from './app-install.service';
import { AppUpgradeService } from './app-upgrade.service';
import { SafeArchiveService } from './safe-archive.service';

/**
 * 内置官方 APP 预装/自升级（M7）。
 *
 * 扫 config/bundled-apps/*.jzapp（随 main 产物分发——Docker 镜像与原生
 * 安装包的 main 组件均包含 main/config）：
 * - 未安装 → 内部直调 AppInstallService（不经 HTTP，避免 admin token 鸡生蛋）
 * - 已装但 bundled 版本更高 → AppUpgradeService（官方 APP 自身升级通道）
 * - 失败仅记日志，下次启动重试，不阻塞平台启动
 */
@Injectable()
export class BuiltinAppSeedService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BuiltinAppSeedService.name);

  constructor(
    private readonly registry: AppRegistryService,
    private readonly install: AppInstallService,
    private readonly upgrade: AppUpgradeService,
    private readonly archives: SafeArchiveService,
  ) {}

  onApplicationBootstrap() {
    // 后台执行，不阻塞启动
    setImmediate(() => {
      void this.seed().catch(err => this.logger.warn(`内置 APP 预装失败: ${err.message}`));
    });
  }

  private bundledDir(): string {
    return process.env.BUNDLED_APPS_DIR || path.join(process.cwd(), 'config', 'bundled-apps');
  }

  private async seed(): Promise<void> {
    const dir = this.bundledDir();
    if (!fs.existsSync(dir)) return;
    const packages = fs.readdirSync(dir).filter(f => f.endsWith('.jzapp'));
    if (packages.length === 0) return;

    for (const file of packages) {
      const pkgPath = path.join(dir, file);
      try {
        await this.seedOne(pkgPath);
      } catch (err: any) {
        this.logger.warn(`内置 APP ${file} 预装/升级失败（下次启动重试）: ${err.message}`);
      }
    }
  }

  private async seedOne(pkgPath: string): Promise<void> {
    const manifest = await this.peekManifest(pkgPath);
    const existing = await this.registry.findOne(manifest.appId);

    if (!existing || existing.status === 'uninstalled') {
      this.logger.log(`预装内置 APP ${manifest.appId}@${manifest.version}…`);
      await this.install.install(pkgPath);
      this.logger.log(`内置 APP ${manifest.appId}@${manifest.version} 预装完成`);
      return;
    }

    if (compareSemver(manifest.version, existing.version) > 0) {
      this.logger.log(`内置 APP ${manifest.appId} 检测到新版本 ${existing.version} → ${manifest.version}，自动升级…`);
      await this.upgrade.upgrade(manifest.appId, pkgPath);
      this.logger.log(`内置 APP ${manifest.appId} 升级完成`);
      return;
    }

    this.logger.debug(`内置 APP ${manifest.appId}@${existing.version} 已是最新，跳过`);
  }

  /** 解包到临时目录读取 manifest（不安装），用完即删 */
  private async peekManifest(pkgPath: string): Promise<{ appId: string; version: string }> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jzbundled-'));
    try {
      await this.archives.extract(pkgPath, tmp);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf-8'));
      if (!manifest.appId || !manifest.version) throw new Error('manifest 缺少 appId/version');
      return { appId: manifest.appId, version: manifest.version };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(x => parseInt(x, 10) || 0);
  const pb = b.split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
