import { Injectable, Logger } from '@nestjs/common';
import { WorkspaceService } from '../../workspace/workspace.service';
import { OPENCLAW_BUILTIN_TOOLS } from './coworker-config.service';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

const execFileAsync = promisify(execFile);

/** npm package name for OpenClaw. */
const OPENCLAW_NPM_PACKAGE = 'openclaw';
/** Version 见智 has validated as compatible; used when admin installs without an explicit tag. */
export const OPENCLAW_PINNED_VERSION = 'latest';

/**
 * Resolve the download URL for a **prebuilt** OpenClaw asset (choice B: download at runtime).
 * Priority:
 * 1. `OPENCLAW_ASSET_URL` — a direct prebuilt tarball URL (见智官网分发 or a pinned mirror).
 *    Use `{version}` as a placeholder to substitute the tag.
 * 2. npm registry tarball `openclaw-{version}.tgz` (default).
 * The tarball must contain a prebuilt tree with `package/openclaw.mjs` (verified in selfCheck).
 */
function resolveAssetUrl(tag: string): string {
  const override = process.env.OPENCLAW_ASSET_URL;
  if (override) return override.replace('{version}', encodeURIComponent(tag));
  return `https://registry.npmmirror.com/openclaw/-/openclaw-${encodeURIComponent(tag)}.tgz`;
}

type InstallPhase = 'idle' | 'downloading' | 'extracting' | 'manifest' | 'selfcheck' | 'installing' | 'done' | 'error';

export interface InstallProgress {
  running: boolean;
  phase: InstallPhase;
  version?: string;
  message?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

interface OpenClawMeta {
  version: string;
  source: string;          // resolved download URL
  downloadedAt: string;
  compatible: boolean;     // passed structural self-check
  toolsExtracted: 'source' | 'fallback-constant';
  bridgeInjected: boolean;
}

type BuiltinTool = { id: string; label: string; section: string; description: string };

/**
 * Manages the OpenClaw source used by 见智 as build material (NOT a runtime).
 *
 * Placement: mounted volume `workspace/.openclaw` (persists across restarts,
 * upgradable independently of the 见智 image, not in the install package).
 *
 * Responsibilities (admin-driven, manual):
 * 1. Download / upgrade OpenClaw from a GitHub Release tarball.
 * 2. Extract the builtin tool manifest (`tools-manifest.json`) for the authorization UI.
 * 3. Inject the 见智 `jianzhi-bridge` plugin into the source.
 * 4. Structural self-check + rollback (previous version kept at `.openclaw.prev`).
 */
@Injectable()
export class CoWorkerOpenClawService {
  private readonly logger = new Logger(CoWorkerOpenClawService.name);
  private progress: InstallProgress = { running: false, phase: 'idle' };

  constructor(private readonly workspace: WorkspaceService) {}

  /** Mounted OpenClaw source root: `workspace/.openclaw`. */
  getOpenClawRoot(): string {
    return path.join(this.workspace.getRoot(), '.openclaw');
  }

  private getPrevRoot(): string {
    return path.join(this.workspace.getRoot(), '.openclaw.prev');
  }

  /** Stable path of the pinned prebuilt asset tarball that 见智 serves to users. */
  private getAssetPath(): string {
    return path.join(this.workspace.getRoot(), '.openclaw-asset.tar.gz');
  }

  /** Stable path of the Windows runtime artifact (runtime-win-x64.tar.gz). */
  private getWinRuntimePath(): string {
    return path.join(this.workspace.getRoot(), '.openclaw-runtime-win-x64.tar.gz');
  }

  /** Metadata file for Windows runtime. */
  private getWinRuntimeMetaPath(): string {
    return path.join(this.workspace.getRoot(), '.openclaw-runtime-win-x64.meta.json');
  }

  /**
   * The pinned asset users must download from 见智 (never GitHub/DockerHub) — guarantees every
   * user of this 见智 instance builds the SAME OpenClaw version the admin validated.
   */
  getAssetFile(): { path: string; version: string } | null {
    const p = this.getAssetPath();
    const meta = this.readMeta();
    if (!fs.existsSync(p) || !meta) return null;
    return { path: p, version: meta.version };
  }

  /**
   * Get Windows runtime artifact info.
   * Returns the path and version if the Windows runtime has been installed.
   */
  getWinRuntimeFile(): { path: string; version: string; size: number } | null {
    const p = this.getWinRuntimePath();
    const metaPath = this.getWinRuntimeMetaPath();

    if (!fs.existsSync(p) || !fs.existsSync(metaPath)) return null;

    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      const stats = fs.statSync(p);
      return {
        path: p,
        version: meta.version || 'unknown',
        size: stats.size,
      };
    } catch {
      return null;
    }
  }

  /**
   * Download Windows runtime from GitHub Actions artifact.
   * This is the prebuilt runtime-win-x64.tar.gz from the windows-runtime.yml workflow.
   */
  async installWinRuntime(artifactUrl?: string): Promise<{ started: boolean; reason?: string }> {
    if (this.progress.running) {
      return { started: false, reason: '已有安装任务进行中' };
    }

    this.progress = {
      running: true,
      phase: 'downloading',
      version: 'win-x64',
      message: '下载 Windows 运行时',
      startedAt: new Date().toISOString(),
    };

    // Fire-and-forget; caller polls progress.
    void this.runWinRuntimeInstall(artifactUrl).catch(err => {
      this.logger.error(`Windows runtime install failed: ${err?.message}`);
      this.progress = {
        ...this.progress,
        running: false,
        phase: 'error',
        error: err?.message || String(err),
        finishedAt: new Date().toISOString(),
      };
    });

    return { started: true };
  }

  private async runWinRuntimeInstall(artifactUrl?: string): Promise<void> {
    const dest = this.getWinRuntimePath();
    const metaPath = this.getWinRuntimeMetaPath();
    const root = this.workspace.getRoot();
    const tmpDest = path.join(root, `.runtime-win-x64.tmp-${Date.now()}.tar.gz`);

    try {
      let url: string;
      let version: string;

      if (artifactUrl) {
        // Direct URL provided (e.g., from GitHub Actions artifact)
        url = artifactUrl;
        version = 'custom';
      } else {
        // Try to get from the latest GitHub Actions run
        // This requires GitHub token for private repos
        const runInfo = await this.getLatestWinRuntimeRun();
        if (!runInfo) {
          throw new Error('未找到 Windows 运行时构建，请手动提供 artifact URL');
        }
        url = runInfo.url;
        version = runInfo.version;
      }

      this.progress.message = `下载 Windows 运行时 (${version})`;
      await this.download(url, tmpDest);

      // Verify the tarball contains expected structure
      this.progress.phase = 'selfcheck';
      this.progress.message = '验证运行时结构';
      const valid = await this.verifyWinRuntime(tmpDest);
      if (!valid) {
        throw new Error('Windows 运行时验证失败：缺少必要文件');
      }

      // Atomic move
      fs.renameSync(tmpDest, dest);

      // Write metadata
      const meta = {
        version,
        downloadedAt: new Date().toISOString(),
        size: fs.statSync(dest).size,
        source: url,
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');

      this.progress = {
        running: false,
        phase: 'done',
        version,
        message: `Windows 运行时已安装 (${(meta.size / 1024 / 1024).toFixed(1)} MB)`,
        startedAt: this.progress.startedAt,
        finishedAt: new Date().toISOString(),
      };

      this.logger.log(`Windows runtime ${version} installed`);
    } finally {
      // Cleanup temp
      fs.rmSync(tmpDest, { force: true });
    }
  }

  /**
   * Get the latest Windows runtime artifact info from GitHub Actions.
   * Returns null if not available (requires GitHub token or public repo).
   */
  private async getLatestWinRuntimeRun(): Promise<{ url: string; version: string } | null> {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      this.logger.warn('GITHUB_TOKEN 未设置，无法自动获取 Windows 运行时');
      return null;
    }

    try {
      const repo = process.env.GITHUB_REPOSITORY || 'openclaw/openclaw';
      const resp = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/windows-runtime.yml/runs?branch=main&status=success&per_page=1`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'jianzhi',
          },
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!resp.ok) return null;

      const data: any = await resp.json();
      const run = data.workflow_runs?.[0];
      if (!run) return null;

      // Get artifacts from this run
      const artifactResp = await fetch(
        `https://api.github.com/repos/${repo}/actions/runs/${run.id}/artifacts`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'jianzhi',
          },
          signal: AbortSignal.timeout(15000),
        },
      );

      if (!artifactResp.ok) return null;

      const artifactData: any = await artifactResp.json();
      const artifact = artifactData.artifacts?.find((a: any) =>
        a.name === 'runtime-win-x64' || a.name?.includes('runtime-win'),
      );

      if (!artifact) return null;

      return {
        url: artifact.archive_download_url,
        version: run.head_sha?.slice(0, 7) || run.id,
      };
    } catch (err: any) {
      this.logger.warn(`获取 Windows 运行时失败: ${err.message}`);
      return null;
    }
  }

  /**
   * Verify that the Windows runtime tarball contains the expected structure.
   * Does a quick check without full extraction.
   */
  private async verifyWinRuntime(tarPath: string): Promise<boolean> {
    try {
      // List contents without full extraction
      const { stdout } = await execFileAsync('tar', ['-tzf', tarPath]);
      const contents = stdout.split('\n');

      // Check for key indicators of a valid Windows runtime
      const hasNodeExe = contents.some(f => f.includes('node.exe'));
      const hasOpenclaw = contents.some(f => f.includes('openclaw'));
      const hasExtensions = contents.some(f => f.includes('extensions'));

      return hasNodeExe || hasOpenclaw;
    } catch {
      return false;
    }
  }

  private getMetaPath(root = this.getOpenClawRoot()): string {
    return path.join(root, '.jz-meta.json');
  }

  private readMeta(root = this.getOpenClawRoot()): OpenClawMeta | null {
    try {
      return JSON.parse(fs.readFileSync(this.getMetaPath(root), 'utf-8'));
    } catch {
      return null;
    }
  }

  /** Status for the admin "OpenClaw 源" card. `latest` is best-effort (may be null offline). */
  async getStatus(): Promise<{
    installed: boolean;
    version: string | null;
    pinned: string;
    latest: string | null;
    compatible: boolean;
    bridgeInjected: boolean;
    hasPrev: boolean;
    progress: InstallProgress;
  }> {
    const meta = this.readMeta();
    let latest: string | null = null;
    try {
      latest = await this.resolveLatestTag();
    } catch {
      /* offline / rate-limited — leave null */
    }
    return {
      installed: !!meta,
      version: meta?.version || null,
      pinned: OPENCLAW_PINNED_VERSION,
      latest,
      compatible: meta?.compatible ?? false,
      bridgeInjected: meta?.bridgeInjected ?? false,
      hasPrev: fs.existsSync(this.getPrevRoot()),
      progress: this.progress,
    };
  }

  getProgress(): InstallProgress {
    return this.progress;
  }

  /**
   * Local prebuilt OpenClaw source to seed from (offline / internal — openclaw publishes no
   * server-runtime asset on GitHub). Prefers `OPENCLAW_SOURCE_DIR`, else `<workspace>/.openclaw-src`.
   * Must contain a prebuilt `openclaw.mjs`.
   */
  private getSeedDir(): string | null {
    const candidates = [
      process.env.OPENCLAW_SOURCE_DIR || '',
      path.join(this.workspace.getRoot(), '.openclaw-src'),
    ].filter(Boolean);
    return candidates.find(d => fs.existsSync(path.join(d, 'openclaw.mjs'))) || null;
  }

  /** Builtin tool manifest for the capability catalog; falls back to the bundled constant. */
  getToolsManifest(): BuiltinTool[] {
    try {
      const raw = fs.readFileSync(path.join(this.getOpenClawRoot(), 'tools-manifest.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* not installed yet / unreadable */
    }
    return OPENCLAW_BUILTIN_TOOLS;
  }

  /**
   * Download + install (or upgrade) OpenClaw. Runs asynchronously; poll getProgress().
   * Guarded against concurrent installs.
   */
  async install(version?: string): Promise<{ started: boolean; reason?: string }> {
    if (this.progress.running) {
      return { started: false, reason: '已有安装任务进行中' };
    }
    const seedDir = this.getSeedDir();
    let tag: string;
    if (seedDir) {
      // Seed the version from the local asset's package.json (no GitHub call needed).
      let seedVer = '';
      try { seedVer = JSON.parse(fs.readFileSync(path.join(seedDir, 'package.json'), 'utf-8')).version || ''; } catch { /* ignore */ }
      tag = version || seedVer || 'local';
    } else {
      tag = version && version !== 'latest' ? version : await this.resolveLatestTag();
    }
    this.progress = { running: true, phase: 'downloading', version: tag, startedAt: new Date().toISOString() };
    // Fire-and-forget; caller polls progress.
    void this.runInstall(tag).catch(err => {
      this.logger.error(`OpenClaw install failed: ${err?.message}`);
      this.progress = {
        ...this.progress,
        running: false,
        phase: 'error',
        error: err?.message || String(err),
        finishedAt: new Date().toISOString(),
      };
    });
    return { started: true };
  }

  private async runInstall(tag: string): Promise<void> {
    const root = this.workspace.getRoot();
    const stamp = Date.now();
    const tmpDir = path.join(root, `.openclaw.tmp-${stamp}`);
    const tarPath = path.join(root, `.openclaw-${stamp}.tar.gz`);
    const seedDir = this.getSeedDir();
    let source: string;

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      let srcRoot: string | null;
      if (seedDir) {
        // Local prebuilt source (offline / internal — openclaw ships no server-runtime asset).
        // Copy it in, then tar it so 见智 can serve the same asset to users.
        this.progress.phase = 'downloading';
        this.progress.message = `本地播种 ${seedDir}`;
        source = `seed:${seedDir}`;
        const dest = path.join(tmpDir, 'openclaw');
        fs.mkdirSync(dest, { recursive: true });
        await execFileAsync('cp', ['-a', `${seedDir}/.`, dest]);
        this.progress.phase = 'extracting';
        this.progress.message = '打包资产';
        await execFileAsync('tar', ['-czf', tarPath, '-C', tmpDir, 'openclaw']);
        srcRoot = dest;
      } else {
        // choice B: fetch a PREBUILT asset tarball from a real URL (OPENCLAW_ASSET_URL / 官网直链).
        const url = resolveAssetUrl(tag);
        source = url;
        this.progress.phase = 'downloading';
        this.progress.message = `下载 ${tag}`;
        await this.download(url, tarPath);
        this.progress.phase = 'extracting';
        this.progress.message = '解压';
        await execFileAsync('tar', ['-xzf', tarPath, '-C', tmpDir]);
        srcRoot = this.findTopDir(tmpDir);
      }
      if (!srcRoot) throw new Error('未找到 OpenClaw 源目录');

      // 3. Extract builtin tool manifest
      this.progress.phase = 'manifest';
      this.progress.message = '提取工具清单';
      const toolsExtracted = this.extractToolsManifest(srcRoot);

      // 4. Inject 见智 jianzhi-bridge plugin
      const bridgeInjected = this.injectBridge(srcRoot);

      // 5. Structural self-check
      this.progress.phase = 'selfcheck';
      this.progress.message = '兼容自检';
      const compatible = this.selfCheck(srcRoot);

      // 6. Atomic swap: current → .prev, new → current
      this.progress.phase = 'installing';
      this.progress.message = '切换版本';
      const dest = this.getOpenClawRoot();
      const prev = this.getPrevRoot();
      if (fs.existsSync(dest)) {
        fs.rmSync(prev, { recursive: true, force: true });
        fs.renameSync(dest, prev);
      }
      fs.renameSync(srcRoot, dest);

      // 7. Write meta
      const meta: OpenClawMeta = {
        version: tag,
        source,
        downloadedAt: new Date().toISOString(),
        compatible,
        toolsExtracted,
        bridgeInjected,
      };
      fs.writeFileSync(this.getMetaPath(dest), JSON.stringify(meta, null, 2), 'utf-8');

      // Persist the pinned asset so 见智 can serve it to users at this exact version.
      fs.copyFileSync(tarPath, this.getAssetPath());

      this.progress = {
        running: false,
        phase: 'done',
        version: tag,
        message: `已安装 ${tag}${compatible ? '' : '（自检未通过，请检查）'}`,
        startedAt: this.progress.startedAt,
        finishedAt: new Date().toISOString(),
      };
      this.logger.log(`OpenClaw ${tag} installed (compatible=${compatible}, bridge=${bridgeInjected}, tools=${toolsExtracted})`);
    } finally {
      // Cleanup temp artifacts (best-effort)
      fs.rmSync(tarPath, { force: true });
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  /** Roll back to `.openclaw.prev` (swaps current and prev). */
  rollback(): { ok: boolean; reason?: string } {
    if (this.progress.running) return { ok: false, reason: '安装进行中，无法回滚' };
    const dest = this.getOpenClawRoot();
    const prev = this.getPrevRoot();
    if (!fs.existsSync(prev)) return { ok: false, reason: '无可回滚的上一版本' };
    const swap = `${dest}.swap-${Date.now()}`;
    if (fs.existsSync(dest)) fs.renameSync(dest, swap);
    fs.renameSync(prev, dest);
    if (fs.existsSync(swap)) fs.renameSync(swap, prev); // old current becomes the new prev
    const meta = this.readMeta();
    this.logger.log(`OpenClaw rolled back to ${meta?.version || 'unknown'}`);
    return { ok: true };
  }

  // ---- helpers ----

  private async resolveLatestTag(): Promise<string> {
    const resp = await fetch('https://registry.npmjs.org/openclaw', {
      headers: { 'User-Agent': 'jianzhi' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`npm registry HTTP ${resp.status}`);
    const data: any = await resp.json();
    const latest = data['dist-tags']?.latest;
    if (!latest) throw new Error('npm registry 未返回 dist-tags.latest');
    return latest;
  }

  private async download(url: string, dest: string): Promise<void> {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'jianzhi' },
      signal: AbortSignal.timeout(300000),
    });
    if (!resp.ok || !resp.body) throw new Error(`下载失败 HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(dest, buf);
  }

  /** Locate the OpenClaw root inside an extracted tarball (handles npm package/, wrapped, and flat archives). */
  private findTopDir(dir: string): string | null {
    // npm tarball: files wrapped in a `package/` subdirectory.
    const packageDir = path.join(dir, 'package');
    if (fs.existsSync(path.join(packageDir, 'openclaw.mjs'))) return packageDir;

    // Flat archive: files extracted directly into `dir`.
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;

    const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
    if (entries.length === 1) return path.join(dir, entries[0].name);
    // Fallback: prefer a dir whose name starts with the package name.
    const match = entries.find(e => e.name.startsWith('openclaw'));
    return match ? path.join(dir, match.name) : null;
  }

  /**
   * Best-effort extraction of the builtin tool manifest from OpenClaw source.
   * Prefers a shipped manifest JSON; falls back to the bundled OPENCLAW_BUILTIN_TOOLS constant.
   * Always writes `${srcRoot}/tools-manifest.json`.
   */
  private extractToolsManifest(srcRoot: string): 'source' | 'fallback-constant' {
    const candidates = [
      path.join(srcRoot, 'tools-manifest.json'),
      path.join(srcRoot, 'dist', 'tools-manifest.json'),
    ];
    for (const c of candidates) {
      try {
        const parsed = JSON.parse(fs.readFileSync(c, 'utf-8'));
        if (Array.isArray(parsed) && parsed.length && parsed[0]?.id && parsed[0]?.section) {
          fs.writeFileSync(path.join(srcRoot, 'tools-manifest.json'), JSON.stringify(parsed, null, 2), 'utf-8');
          return 'source';
        }
      } catch {
        /* try next */
      }
    }
    // Fallback: write the bundled constant so the authorization UI still works.
    fs.writeFileSync(
      path.join(srcRoot, 'tools-manifest.json'),
      JSON.stringify(OPENCLAW_BUILTIN_TOOLS, null, 2),
      'utf-8',
    );
    return 'fallback-constant';
  }

  /** Copy the bundled 见智 jianzhi-bridge plugin into the OpenClaw source's extensions dir. */
  private injectBridge(srcRoot: string): boolean {
    const source = this.findBundledBridge();
    if (!source) {
      this.logger.warn('jianzhi-bridge 插件源未找到，跳过注入');
      return false;
    }
    const target = path.join(srcRoot, 'extensions', 'jianzhi-bridge');
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(source, target, { recursive: true });
      return true;
    } catch (err: any) {
      this.logger.warn(`jianzhi-bridge 注入失败: ${err.message}`);
      return false;
    }
  }

  private findBundledBridge(): string | null {
    const candidates = [
      process.env.JIANZHI_BRIDGE_DIR,
      // Shipped with the main OTA artifact (dist/assets/jianzhi-bridge) — present in customer containers.
      path.resolve(__dirname, '..', '..', 'assets', 'jianzhi-bridge'),
      path.resolve(process.cwd(), '..', 'openclaw', 'extensions', 'jianzhi-bridge'),
      path.resolve(process.cwd(), 'openclaw', 'extensions', 'jianzhi-bridge'),
      path.resolve(__dirname, '..', '..', '..', '..', 'openclaw', 'extensions', 'jianzhi-bridge'),
    ].filter(Boolean) as string[];
    return candidates.find(c => fs.existsSync(path.join(c, 'openclaw.plugin.json'))) || null;
  }

  /**
   * Structural self-check (can't run OpenClaw): verify it's a usable **prebuilt** OpenClaw asset.
   * Requires the prebuilt entrypoint `dist/openclaw.mjs` (or top-level `openclaw.mjs`) so the
   * user deployment can run without a build step.
   * npm packages use `dist/plugin-sdk`; GitHub sources use `extensions` or `src/plugin-sdk`.
   */
  private selfCheck(srcRoot: string): boolean {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(srcRoot, 'package.json'), 'utf-8'));
      const looksLikeOpenClaw =
        pkg?.name === 'openclaw' || String(pkg?.name || '').includes('openclaw');
      const prebuilt =
        fs.existsSync(path.join(srcRoot, 'dist', 'openclaw.mjs')) ||
        fs.existsSync(path.join(srcRoot, 'openclaw.mjs'));
      const hasPluginSurface =
        fs.existsSync(path.join(srcRoot, 'extensions')) ||
        fs.existsSync(path.join(srcRoot, 'src', 'plugin-sdk')) ||
        fs.existsSync(path.join(srcRoot, 'dist', 'plugin-sdk'));
      return !!looksLikeOpenClaw && prebuilt && hasPluginSurface;
    } catch {
      return false;
    }
  }
}
