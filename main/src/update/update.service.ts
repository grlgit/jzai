import { Injectable, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { EditionService } from '../edition/edition.service';

export interface VersionInfo {
  version: string;
  component: string;
  buildDate: string;
  gitCommit?: string;
}

/** 差量信息（每组件）：file=差量包（仅含新增/变更文件），deleted=需删除路径 */
export interface DeltaComp {
  file: string | null;
  size?: number;
  deleted?: string[];
}

/** 单个升级步骤的信息 */
export interface UpgradeStep {
  version: string;
  prevVersion: string;
  releaseDate: string;
  releaseNotes?: string;
  components?: Record<string, { size: number; file: string }>;
  delta?: ({ base: string } & Record<string, DeltaComp>) | null;
  gitCommit?: string | null;
}

export interface UpdateInfo {
  available: boolean;
  version?: string;
  releaseDate?: string;
  releaseNotes?: string;
  components?: Record<string, { size: number; file?: string }>;
  totalSize?: number;
  gitCommit?: string | null;
  delta?: ({ base: string } & Record<string, DeltaComp>) | null;
  // 升级路径（用于"升级到最新"功能）
  upgradePath?: {
    current: string;
    latest: string;
    steps: UpgradeStep[];
    totalSteps: number;
    totalSize: number;
    releaseNotes: string;
  };
}

export interface UpdateProgress {
  phase: 'idle' | 'downloading' | 'backup' | 'installing' | 'restarting' | 'done' | 'error';
  components: Record<string, { totalBytes: number; downloadedBytes: number; done: boolean }>;
  totalBytes: number;
  downloadedBytes: number;
  percent: number;
  currentComponent: string;
  error: string | null;
}

@Injectable()
export class UpdateService {
  private readonly logger = new Logger(UpdateService.name);
  private readonly websiteUrl: string;
  private cachedUpdate: UpdateInfo = { available: false };
  private currentVersion: VersionInfo | null = null;
  private progress: UpdateProgress = this.idleProgress();

  constructor(
    private readonly config: ConfigService,
    @Optional() @Inject(forwardRef(() => EditionService)) private readonly edition?: EditionService,
  ) {
    this.websiteUrl = this.config.get('JIANZHI_WEBSITE_URL', 'http://43.133.38.52');
    this.loadCurrentVersion();
  }

  private idleProgress(): UpdateProgress {
    return { phase: 'idle', components: {}, totalBytes: 0, downloadedBytes: 0, percent: 0, currentComponent: '', error: null };
  }

  private loadCurrentVersion() {
    const candidates = [
      path.join(process.cwd(), 'version.json'),
      path.join(process.cwd(), 'config', 'version.json'),
      path.join(__dirname, '..', '..', 'version.json'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          this.currentVersion = JSON.parse(fs.readFileSync(p, 'utf8'));
          this.logger.log(`Version: ${this.currentVersion!.version} (${p})`);
          return;
        }
      } catch { /* continue */ }
    }
    this.logger.warn('version.json not found, version unknown');
  }

  getCurrentVersion(): VersionInfo | null { return this.currentVersion; }
  getVersionString(): string { return this.currentVersion?.version || 'unknown'; }

  cacheUpdateInfo(update: UpdateInfo) {
    this.cachedUpdate = update;
    if (update.available) this.logger.log(`Update available: ${update.version}`);
  }

  getCachedUpdate(): UpdateInfo { return this.cachedUpdate; }
  getProgress(): UpdateProgress { return this.progress; }

  async checkUpdate(): Promise<UpdateInfo> {
    const version = this.getVersionString();
    if (version === 'unknown') return { available: false };
    try {
      const resp = await fetch(
        `${this.websiteUrl}/api/v1/releases/check?current=${encodeURIComponent(version)}`,
        { headers: this.getAuthHeaders(), signal: AbortSignal.timeout(10000) },
      );
      if (!resp.ok) return { available: false };
      const data = await resp.json();
      this.cachedUpdate = data;
      return data;
    } catch (err: any) {
      this.logger.warn(`Update check failed: ${err.message}`);
      return { available: false };
    }
  }

  /** 检查最新版本及升级路径（用于"升级到最新"功能） */
  async checkLatest(): Promise<UpdateInfo> {
    const version = this.getVersionString();
    if (version === 'unknown') return { available: false };
    try {
      const resp = await fetch(
        `${this.websiteUrl}/api/v1/releases/latest?current=${encodeURIComponent(version)}`,
        { headers: this.getAuthHeaders(), signal: AbortSignal.timeout(10000) },
      );
      if (!resp.ok) return { available: false };
      const data = await resp.json();
      if (!data.available) return { available: false };

      // 构造返回数据，包含升级路径
      const result: UpdateInfo = {
        available: true,
        version: data.latest,
        releaseNotes: data.releaseNotes,
        upgradePath: {
          current: data.current,
          latest: data.latest,
          steps: data.steps,
          totalSteps: data.totalSteps,
          totalSize: data.totalSize,
          releaseNotes: data.releaseNotes,
        },
      };
      // 缓存数据供 startApplyLatest 使用
      this.cachedUpdate = result;
      return result;
    } catch (err: any) {
      this.logger.warn(`Latest version check failed: ${err.message}`);
      return { available: false };
    }
  }

  /** Start update in background, progress available via getProgress() */
  startApply(): { started: boolean; error?: string } {
    return this.startApplyInternal(false);
  }

  /** 升级到最新版本（链式升级，依次执行所有中间版本） */
  startApplyLatest(): { started: boolean; error?: string } {
    return this.startApplyInternal(true);
  }

  private startApplyInternal(forceLatest: boolean): { started: boolean; error?: string } {
    if (this.progress.phase !== 'idle' && this.progress.phase !== 'error' && this.progress.phase !== 'done') {
      return { started: false, error: 'Update already in progress' };
    }
    const update = this.cachedUpdate;
    if (!update.available) {
      return { started: false, error: 'No update available' };
    }

    // 检查是否有升级路径（用于"升级到最新"）
    const upgradePath = forceLatest ? update.upgradePath : null;

    // Reset progress
    this.progress = this.idleProgress();

    // 计算总下载量
    let totalBytes = 0;

    if (upgradePath) {
      // 升级到最新：累加所有步骤的下载量
      for (const step of upgradePath.steps) {
        for (const comp of ['main', 'web', 'kb', 'coworker-app'] as const) {
          const delta = step.delta ? (step.delta as any)[comp] : undefined;
          if (comp !== 'kb' && comp !== 'coworker-app' && delta?.file) {
            totalBytes += delta.size || 0;  // 走差量
          } else if (step.components?.[comp]) {
            totalBytes += step.components[comp].size || 0;  // 全量
          }
        }
      }
      this.progress.totalBytes = totalBytes;
      this.progress.phase = 'downloading';

      // 运行链式升级
      this.runApplyUpgradePath(upgradePath).catch(() => {});
    } else {
      // 单版本升级
      if (!update.version) {
        return { started: false, error: 'No update available' };
      }
      const deltaUsable = !!(update.delta && update.delta.base === this.getVersionString());
      for (const comp of ['main', 'web', 'kb', 'coworker-app'] as const) {
        const d = deltaUsable ? (update.delta as any)?.[comp] : undefined;
        const full = update.components?.[comp];
        let size = 0;
        if (comp !== 'kb' && comp !== 'coworker-app' && d?.file) size = d.size || 0;
        else if (full) size = full.size || 0;
        else if (d) size = 0;
        else continue;
        this.progress.components[comp] = { totalBytes: size, downloadedBytes: 0, done: false };
        totalBytes += size;
      }
      this.progress.totalBytes = totalBytes;
      this.progress.phase = 'downloading';

      this.runApply(update).catch(() => {});
    }
    return { started: true };
  }

  private async runApply(update: UpdateInfo): Promise<void> {
    const version = update.version!;
    const tmpDir = path.join('/tmp', `upgrade-${version}`);
    const appDir = path.resolve(process.cwd(), '..');
    // 差量可用前提：服务端 delta.base 必须 == 当前安装版本（逐跳、不跳版）
    const delta = update.delta && update.delta.base === this.getVersionString() ? update.delta : null;
    const { execSync } = await import('child_process');

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      // Phase 1: 先把所有需要的包下载到临时目录（此阶段不改动任何文件；
      // 下载失败=文件未动、重跑即可，无需备份/回退）。
      // 升级=直接叠加覆盖（同 hotfix）：hotfix 过的本地实例与客户实例走同一路径，
      // 不做基线校验、不做版本回退；补丁存在则用补丁，否则用全量。
      this.progress.phase = 'downloading';
      const steps: Array<{ comp: string; tar: string | null; deleted: string[]; kind: 'delta' | 'full' }> = [];
      for (const comp of ['main', 'web'] as const) {
        this.progress.currentComponent = comp;
        const d: DeltaComp | undefined = delta ? (delta as any)[comp] : undefined;
        const wantsDelta = !!d && (!!d.file || !!(d.deleted && d.deleted.length));
        if (wantsDelta) {
          let tar: string | null = null;
          if (d!.file) { tar = path.join(tmpDir, `${comp}-delta.tar.gz`); fs.writeFileSync(tar, await this.downloadComponent(version, comp, 'delta')); }
          steps.push({ comp, tar, deleted: d!.deleted || [], kind: 'delta' });
        } else if (update.components?.[comp]) {
          const tar = path.join(tmpDir, `${comp}.tar.gz`);
          fs.writeFileSync(tar, await this.downloadComponent(version, comp, 'full'));
          steps.push({ comp, tar, deleted: [], kind: 'full' });
        }
        if (this.progress.components[comp]) this.progress.components[comp].done = true;
      }
      let kbTar: string | null = null;
      if (update.components?.kb) {
        this.progress.currentComponent = 'kb';
        kbTar = path.join(tmpDir, 'kb.tar.gz');
        fs.writeFileSync(kbTar, await this.downloadComponent(version, 'kb', 'full'));
        if (this.progress.components['kb']) this.progress.components['kb'].done = true;
      }
      let coworkerAppTar: string | null = null;
      if (update.components?.['coworker-app']) {
        this.progress.currentComponent = 'coworker-app';
        coworkerAppTar = path.join(tmpDir, 'coworker-app.tar.gz');
        fs.writeFileSync(coworkerAppTar, await this.downloadComponent(version, 'coworker-app', 'full'));
        if (this.progress.components['coworker-app']) this.progress.components['coworker-app'].done = true;
      }

      // Phase 2: 应用 —— 叠加覆盖 + 删除（与 hotfix 叠加语义一致）
      this.progress.phase = 'installing';
      for (const s of steps) {
        if (s.tar) execSync(`tar -xzf ${s.tar} -C ${appDir}`, { stdio: 'pipe' });
        for (const rel of s.deleted) {
          const target = path.join(appDir, s.comp, rel);
          if (target.startsWith(path.join(appDir, s.comp) + path.sep)) fs.rmSync(target, { force: true });
        }
        this.logger.log(`[${s.comp}] ${s.kind === 'delta' ? '增量' : '全量'}升级 (deleted=${s.deleted.length})`);
      }
      await this.verifyDeps(appDir);
      if (kbTar) await this.upgradeKb(kbTar);
      if (coworkerAppTar) await this.upgradeCoWorkerApp(coworkerAppTar);

      // 把 version + gitCommit 落到 /app/main/version.json（产物已含 version.json，这里补 gitCommit）
      try {
        const vf = path.join(appDir, 'main', 'version.json');
        const vj = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8') || '{}') : {};
        vj.version = version;
        if (update.gitCommit) vj.gitCommit = update.gitCommit;
        fs.writeFileSync(vf, JSON.stringify(vj, null, 2));
      } catch { /* best effort */ }

      fs.rmSync(tmpDir, { recursive: true, force: true });
      this.progress.phase = 'restarting';
      this.logger.log(`Update to ${version} applied (delta=${!!delta}, git=${(update.gitCommit || '').slice(0, 9)}), restarting...`);
      setTimeout(() => process.exit(0), 2000);

    } catch (err: any) {
      // 下载阶段失败=未改动文件；应用阶段失败=重跑 OTA 重新叠加即可（与 hotfix 一致，不做回退）
      this.logger.error(`Update failed: ${err.message}`);
      this.progress.phase = 'error';
      this.progress.error = err.message;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** 链式升级：依次执行多个版本的升级（用于"升级到最新"功能） */
  private async runApplyUpgradePath(upgradePath: {
    current: string;
    latest: string;
    steps: UpgradeStep[];
  }): Promise<void> {
    const appDir = path.resolve(process.cwd(), '..');
    const { execSync } = await import('child_process');
    const tmpDir = path.join('/tmp', `upgrade-to-${upgradePath.latest}`);

    try {
      fs.mkdirSync(tmpDir, { recursive: true });

      this.logger.log(`Starting upgrade path: ${upgradePath.current} → ${upgradePath.latest} (${upgradePath.steps.length} steps)`);

      // 按版本分组收集升级步骤
      const stepsByVersion = new Map<string, Array<{ comp: string; tar: string | null; deleted: string[]; kind: 'delta' | 'full' }>>();

      // Phase 1: 下载所有步骤的所有组件包
      this.progress.phase = 'downloading';

      for (let stepIdx = 0; stepIdx < upgradePath.steps.length; stepIdx++) {
        const step = upgradePath.steps[stepIdx];
        this.logger.log(`Downloading step ${stepIdx + 1}/${upgradePath.steps.length}: ${step.prevVersion} → ${step.version}`);

        // 对于链式升级，第一个版本可以用差量（base == current），后续版本也用差量（base == prev_version）
        const deltaUsable = step.delta && step.delta.base === step.prevVersion;
        const stepVersion = step.version;

        // 初始化该版本的步骤数组
        if (!stepsByVersion.has(stepVersion)) stepsByVersion.set(stepVersion, []);

        for (const comp of ['main', 'web', 'kb', 'coworker-app'] as const) {
          this.progress.currentComponent = `${step.version}/${comp}`;
          const d: DeltaComp | undefined = deltaUsable ? (step.delta as any)?.[comp] : undefined;
          const full = step.components?.[comp];

          let stepItem: { comp: string; tar: string | null; deleted: string[]; kind: 'delta' | 'full' } | null = null;

          if (comp !== 'kb' && comp !== 'coworker-app' && d?.file) {
            // 差量包
            const tar = path.join(tmpDir, `${stepVersion}-${comp}-delta.tar.gz`);
            fs.writeFileSync(tar, await this.downloadComponent(stepVersion, comp, 'delta'));
            stepItem = { comp, tar, deleted: d.deleted || [], kind: 'delta' as const };
          } else if (full) {
            // 全量包
            const tar = path.join(tmpDir, `${stepVersion}-${comp}.tar.gz`);
            fs.writeFileSync(tar, await this.downloadComponent(stepVersion, comp, 'full'));
            stepItem = { comp, tar, deleted: [], kind: 'full' as const };
          }

          if (stepItem) {
            stepsByVersion.get(stepVersion)!.push(stepItem);
          }
        }
      }

      // Phase 2: 按版本顺序依次应用所有升级包
      this.progress.phase = 'installing';
      this.logger.log(`Applying updates for ${upgradePath.steps.length} versions...`);

      // 按版本顺序应用（upgradePath.steps 已经是正确顺序）
      for (const step of upgradePath.steps) {
        const versionSteps = stepsByVersion.get(step.version) || [];
        if (versionSteps.length === 0) {
          this.logger.log(`Version ${step.version}: no components to update`);
          continue;
        }

        this.logger.log(`Applying version ${step.version} (${versionSteps.length} components)...`);

        for (const s of versionSteps) {
          if (s.tar) {
            execSync(`tar -xzf ${s.tar} -C ${appDir}`, { stdio: 'pipe' });
          }
          for (const rel of s.deleted) {
            const target = path.join(appDir, s.comp, rel);
            if (target.startsWith(path.join(appDir, s.comp) + path.sep)) {
              fs.rmSync(target, { force: true });
            }
          }
          this.logger.log(`[${s.comp}] ${s.kind === 'delta' ? '增量' : '全量'}升级 (deleted=${s.deleted.length})`);
        }

        await this.verifyDeps(appDir);

        // 更新 version.json（每个版本步骤都更新，确保中途失败时可恢复）
        try {
          const vf = path.join(appDir, 'main', 'version.json');
          const vj = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8') || '{}') : {};
          vj.version = step.version;
          if (step.gitCommit) vj.gitCommit = step.gitCommit;
          fs.writeFileSync(vf, JSON.stringify(vj, null, 2));
          this.logger.log(`Version updated to ${step.version}`);
        } catch (e) {
          this.logger.warn(`Failed to update version.json: ${e}`);
        }
      }

      // 最终确保最新版本信息正确
      const finalStep = upgradePath.steps[upgradePath.steps.length - 1];
      try {
        const vf = path.join(appDir, 'main', 'version.json');
        const vj = fs.existsSync(vf) ? JSON.parse(fs.readFileSync(vf, 'utf8') || '{}') : {};
        vj.version = finalStep.version;
        if (finalStep.gitCommit) vj.gitCommit = finalStep.gitCommit;
        fs.writeFileSync(vf, JSON.stringify(vj, null, 2));
      } catch { /* best effort */ }

      fs.rmSync(tmpDir, { recursive: true, force: true });
      this.progress.phase = 'restarting';
      this.logger.log(`Upgrade to ${upgradePath.latest} completed (${upgradePath.steps.length} steps applied), restarting...`);
      setTimeout(() => process.exit(0), 2000);

    } catch (err: any) {
      this.logger.error(`Upgrade path failed: ${err.message}`);
      this.progress.phase = 'error';
      this.progress.error = err.message;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** 流式下载组件包（kind=full|delta），带进度统计，返回 Buffer */
  private async downloadComponent(version: string, comp: string, kind: 'full' | 'delta'): Promise<Buffer> {
    const url = `${this.websiteUrl}/api/v1/releases/${encodeURIComponent(version)}/${comp}${kind === 'delta' ? '?kind=delta' : ''}`;
    const resp = await fetch(url, { headers: this.getAuthHeaders(), signal: AbortSignal.timeout(600000) });
    if (!resp.ok) throw new Error(`下载 ${comp}(${kind}) 失败: ${resp.status}`);
    const reader = resp.body?.getReader();
    if (!reader) throw new Error(`下载 ${comp}(${kind}) 无响应体`);
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      const cp = this.progress.components[comp];
      if (cp) cp.downloadedBytes += value.length;
      this.progress.downloadedBytes += value.length;
      this.progress.percent = this.progress.totalBytes > 0
        ? Math.min(100, Math.round((this.progress.downloadedBytes / this.progress.totalBytes) * 100))
        : 0;
    }
    return Buffer.concat(chunks);
  }

  /**
   * 校验随 main 包下发的新增依赖是否落地。
   *
   * 依赖以预取好的 node_modules 形式搭 main 包的车下发，tar 解压即生效；这里是安全网。
   * 校验不通过时抛错：此时 dist 已覆盖，回退不了，但停在 error 态可以让进程继续用内存里的
   * 旧代码提供服务、错误也能在升级界面上看到；重启则会直接进入 MODULE_NOT_FOUND 崩溃循环。
   */
  private async verifyDeps(appDir: string): Promise<void> {
    const mainDir = path.join(appDir, 'main');
    const planFile = path.join(mainDir, 'deps-plan.json');
    if (!fs.existsSync(planFile)) return;

    let planned: Array<{ path: string; name: string; version: string }>;
    try {
      planned = JSON.parse(fs.readFileSync(planFile, 'utf8')).packages || [];
    } catch {
      return;
    }
    if (!planned.length) return;

    const findMissing = () =>
      planned.filter((p) => {
        try {
          return JSON.parse(fs.readFileSync(path.join(mainDir, p.path, 'package.json'), 'utf8')).version !== p.version;
        } catch {
          return true;
        }
      });

    let missing = findMissing();
    if (!missing.length) {
      this.logger.log(`[deps] ${planned.length} 个新增依赖校验通过`);
      return;
    }

    this.logger.warn(`[deps] ${missing.length} 个依赖未落地，尝试联网补装: ${missing.map((m) => `${m.name}@${m.version}`).join(', ')}`);
    const { execFileSync } = await import('child_process');
    try {
      // --no-save --no-package-lock：不改动 package.json / lock。不用 npm ci —— 它会先清空
      // node_modules，失败即砖化。
      execFileSync('npm', ['install', '--no-save', '--no-package-lock', '--omit=dev', ...missing.map((m) => `${m.name}@${m.version}`)], {
        cwd: mainDir,
        stdio: 'pipe',
        timeout: 300000,
      });
    } catch (err: any) {
      this.logger.error(`[deps] 联网补装失败（内网无 registry 时属预期）: ${err.message}`);
    }

    missing = findMissing();
    if (missing.length) {
      throw new Error(`依赖缺失，升级已中止（未重启，服务继续运行）: ${missing.map((m) => `${m.name}@${m.version}`).join(', ')}`);
    }
    this.logger.log('[deps] 联网补装完成，校验通过');
  }

  private async upgradeKb(tarPath: string): Promise<void> {
    const kbEndpoint = this.config.get('KB_API_URL', 'http://kb:8000');
    const fileData = fs.readFileSync(tarPath);
    const formData = new FormData();
    formData.append('file', new Blob([fileData]), 'kb.tar.gz');
    const resp = await fetch(`${kbEndpoint}/upgrade`, { method: 'POST', body: formData, signal: AbortSignal.timeout(60000) });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`KB upgrade failed: ${resp.status} ${text}`);
    }
  }

  private async upgradeCoWorkerApp(tarPath: string): Promise<void> {
    // coworker-app 升级：直接解压覆盖到 /app/coworker-app/
    const appDir = path.resolve(process.cwd(), '..');
    const targetDir = path.join(appDir, 'coworker-app');
    const { execSync } = await import('child_process');
    // 确保目标目录存在
    fs.mkdirSync(targetDir, { recursive: true });
    // 解压覆盖
    execSync(`tar -xzf ${tarPath} -C ${targetDir}`, { stdio: 'pipe' });
    this.logger.log('[coworker-app] 全量升级完成');
  }

  private getAuthHeaders(): Record<string, string> {
    const token = this.edition?.getInstallation()?.installationToken || '';
    return token ? { Authorization: `Bearer ${token}` } : {};
  }
}
