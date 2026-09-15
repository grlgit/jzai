import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

type InstallPhase = 'idle' | 'checking' | 'downloading' | 'done' | 'error';

export interface InstallProgress {
  running: boolean;
  phase: InstallPhase;
  version?: string;
  message?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  downloadedBytes?: number;
  totalBytes?: number;
}

/**
 * Windows CoWorker App 管理服务
 * - 安装器文件托管
 * - 版本管理
 * - 下载统计
 * - 从官网下载最新版本
 */
@Injectable()
export class CoWorkerAppService {
  private readonly logger = new Logger(CoWorkerAppService.name);
  private readonly storageDir: string;
  private readonly metadataFile: string;
  private readonly downloadsFile: string;
  private progress: InstallProgress = { running: false, phase: 'idle' };

  constructor() {
    // 安装器存储目录（可通过环境变量覆盖）
    this.storageDir = process.env.JIANZHI_COWORKER_APP_DIR ||
      path.join(process.cwd(), 'storage', 'coworker-app');
    this.metadataFile = path.join(this.storageDir, 'metadata.json');
    this.downloadsFile = path.join(this.storageDir, 'downloads.jsonl');

    // 确保目录存在
    this.ensureStorage();
  }

  /** 获取当前安装进度 */
  getProgress(): InstallProgress {
    return this.progress;
  }

  /**
   * 存储已签名的安装器，版本号自动递增（patch +1）
   * @param sourcePath 源文件路径（multer 写入 tmpdir 的临时文件）
   */
  async storeInstaller(sourcePath: string): Promise<{
    filename: string;
    version: string;
    size: number;
    storedAt: Date;
  }> {
    if (!fs.existsSync(sourcePath)) {
      throw new NotFoundException('安装器文件不存在');
    }

    const version = this.nextVersion();
    const filename = `见智CoWorker-Setup-${version}-x64.exe`;
    const targetPath = path.join(this.storageDir, filename);

    fs.copyFileSync(sourcePath, targetPath);

    const stats = fs.statSync(targetPath);

    await this.updateMetadata({
      currentVersion: version,
      filename,
      size: stats.size,
      updatedAt: new Date().toISOString(),
    });

    this.logger.log(`存储安装器: ${filename} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      filename,
      version,
      size: stats.size,
      storedAt: stats.mtime,
    };
  }

  /** 基于当前版本自动递增 patch 位 */
  private nextVersion(): string {
    const metadata = this.readMetadata();
    const current = metadata.currentVersion;
    if (!current) return '1.0.0';
    const parts = current.split('.').map(Number);
    if (parts.length !== 3 || parts.some(isNaN)) return '1.0.0';
    return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
  }

  /**
   * 获取当前可用安装器信息
   */
  getCurrentInstaller(): {
    available: boolean;
    version: string | null;
    filename: string | null;
    size: number;
    path: string | null;
  } | null {
    const metadata = this.readMetadata();
    if (!metadata.currentVersion) {
      return {
        available: false,
        version: null,
        filename: null,
        size: 0,
        path: null,
      };
    }

    const filePath = path.join(this.storageDir, metadata.filename);
    if (!fs.existsSync(filePath)) {
      console.warn(`[CoWorkerApp] 元数据存在但文件缺失: ${metadata.filename}`);
      return {
        available: false,
        version: null,
        filename: null,
        size: 0,
        path: null,
      };
    }

    const stats = fs.statSync(filePath);
    return {
      available: true,
      version: metadata.currentVersion,
      filename: metadata.filename,
      size: stats.size,
      path: filePath,
    };
  }

  /**
   * 记录下载事件
   * @param userId 用户ID（可选）
   * @param ip IP地址
   * @param userAgent User-Agent
   */
  async recordDownload(userId: string | null, ip: string, userAgent: string): Promise<void> {
    const record = {
      timestamp: new Date().toISOString(),
      userId,
      ip,
      userAgent,
    };

    // 追加到下载日志（JSONL 格式便于分析）
    fs.appendFileSync(this.downloadsFile, JSON.stringify(record) + '\n');

    console.log(`[CoWorkerApp] 下载记录: userId=${userId || 'anonymous'}, ip=${ip}`);
  }

  /**
   * 获取下载统计
   * @param days 统计天数
   */
  getDownloadStats(days: number = 30): {
    total: number;
    uniqueUsers: number;
    byDay: Record<string, number>;
  } {
    if (!fs.existsSync(this.downloadsFile)) {
      return { total: 0, uniqueUsers: 0, byDay: {} };
    }

    const lines = fs.readFileSync(this.downloadsFile, 'utf-8').split('\n').filter(Boolean);
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    let total = 0;
    const uniqueUsers = new Set<string>();
    const byDay: Record<string, number> = {};

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        const timestamp = new Date(record.timestamp).getTime();

        if (timestamp >= cutoff) {
          total++;
          if (record.userId) uniqueUsers.add(record.userId);

          const day = record.timestamp.split('T')[0];
          byDay[day] = (byDay[day] || 0) + 1;
        }
      } catch (err) {
        // 忽略损坏的行
      }
    }

    return {
      total,
      uniqueUsers: uniqueUsers.size,
      byDay,
    };
  }

  /**
   * 清理旧版本安装器（保留当前版本）
   */
  async cleanupOldVersions(): Promise<string[]> {
    const metadata = this.readMetadata();
    const currentFile = metadata.filename;
    const files = fs.readdirSync(this.storageDir);
    const deleted: string[] = [];

    for (const file of files) {
      // 跳过元数据文件和当前版本
      if (file === 'metadata.json' ||
          file === 'downloads.jsonl' ||
          file === currentFile) {
        continue;
      }

      // 删除旧的安装器文件
      if (file.startsWith('见智CoWorker-Setup-') && file.endsWith('.exe')) {
        const filePath = path.join(this.storageDir, file);
        fs.unlinkSync(filePath);
        deleted.push(file);
        console.log(`[CoWorkerApp] 清理旧版本: ${file}`);
      }
    }

    return deleted;
  }

  /**
   * 获取最新版本信息
   * @param websiteUrl 官网地址
   */
  async getLatestVersion(websiteUrl?: string): Promise<{ version: string } | null> {
    const url = websiteUrl || process.env.JIANZHI_WEBSITE_URL || 'http://43.133.38.52';
    try {
      const resp = await fetch(`${url}/api/v1/coworker-app`, {
        headers: { 'User-Agent': 'jianzhi' },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        this.logger.warn(`获取最新版本失败: ${resp.status}`);
        return null;
      }
      const data = await resp.json();
      return data.available && data.version ? { version: data.version } : null;
    } catch (err: any) {
      this.logger.warn(`获取最新版本异常: ${err.message}`);
      return null;
    }
  }

  /**
   * 获取官网版本详细信息（包含实际文件名）
   * @param websiteUrl 官网地址
   * @param version 版本号
   * @returns 版本信息（version, filename, size）或 null
   */
  private async getWebsiteVersionInfo(
    websiteUrl: string,
    version: string
  ): Promise<{ version: string; filename: string; size: number } | null> {
    try {
      const resp = await fetch(`${websiteUrl}/api/v1/coworker-app`, {
        headers: { 'User-Agent': 'jianzhi' },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) {
        this.logger.warn(`获取版本详细信息失败: ${resp.status}`);
        return null;
      }
      const data = await resp.json();
      if (data.available && data.version === version && data.filename) {
        return {
          version: data.version,
          filename: data.filename,
          size: data.size || 0,
        };
      }
      this.logger.warn(`版本信息不匹配或缺少文件名: version=${data.version}, filename=${data.filename}`);
      return null;
    } catch (err: any) {
      this.logger.warn(`获取版本详细信息异常: ${err.message}`);
      return null;
    }
  }

  /**
   * 下载并安装最新版本的 Windows 安装器
   * @param version 指定版本（留空则下载最新版）
   */
  async install(version?: string): Promise<{ started: boolean; reason?: string }> {
    if (this.progress.running) {
      return { started: false, reason: '已有安装任务进行中' };
    }

    this.progress = { running: true, phase: 'checking', startedAt: new Date().toISOString() };

    // 异步执行下载
    this.runInstall(version).catch(err => {
      this.logger.error(`Windows 安装器下载失败: ${err?.message}`);
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

  /**
   * 从官网下载安装器
   * @param websiteUrl 官网地址
   * @param version 版本号
   * @param onProgress 下载进度回调
   */
  private async downloadFromWebsite(
    websiteUrl: string,
    version: string,
    onProgress?: (downloaded: number, total: number) => void,
  ): Promise<Buffer> {
    const url = `${websiteUrl}/api/v1/coworker-app/${version}`;
    this.logger.log(`开始下载: ${url}`);

    const resp = await fetch(url, {
      headers: { 'User-Agent': 'jianzhi' },
      signal: AbortSignal.timeout(900000), // 15 分钟（支持大文件下载）
    });

    if (!resp.ok || !resp.body) {
      throw new Error(`下载失败 HTTP ${resp.status}`);
    }

    const contentLength = resp.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;

    const reader = resp.body.getReader();
    const chunks: Uint8Array[] = [];
    let downloaded = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      downloaded += value.length;
      if (onProgress && total > 0) {
        onProgress(downloaded, total);
      }
    }

    // 合并所有chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = Buffer.allocUnsafe(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }

    return buffer;
  }

  /**
   * 内部执行下载安装流程
   */
  private async runInstall(targetVersion?: string): Promise<void> {
    const websiteUrl = process.env.JIANZHI_WEBSITE_URL || 'http://43.133.38.52';
    const root = this.storageDir;

    try {
      // 1. 确定版本
      this.progress.phase = 'checking';
      this.progress.message = '检查最新版本';

      let version = targetVersion;
      if (!version) {
        const latest = await this.getLatestVersion(websiteUrl);
        if (!latest) {
          throw new Error('无法获取最新版本信息');
        }
        version = latest.version;
      }
      this.progress.version = version;

      // 1.5. 获取官网版本信息（包含实际文件名）
      this.progress.message = '获取版本信息';
      const versionInfo = await this.getWebsiteVersionInfo(websiteUrl, version);
      if (!versionInfo) {
        throw new Error(`无法获取版本 ${version} 的详细信息，请确认官网已构建该版本`);
      }
      const actualFilename = versionInfo.filename;
      this.logger.log(`官网版本信息: version=${version}, filename=${actualFilename}`);

      // 2. 下载 exe 安装器
      this.progress.phase = 'downloading';
      this.progress.message = `下载 ${version}`;

      const buffer = await this.downloadFromWebsite(websiteUrl, version, (downloaded, total) => {
        this.progress.downloadedBytes = downloaded;
        this.progress.totalBytes = total;
        const percent = total > 0 ? Math.round((downloaded / total) * 100) : 0;
        this.progress.message = `下载 ${version} (${percent}%)`;
      });

      this.progress.message = '下载完成';

      // 3. 保存到目标位置（使用官网的实际文件名）
      const targetPath = path.join(root, actualFilename);
      fs.writeFileSync(targetPath, buffer);

      // 4. 更新元数据（使用实际文件名）
      await this.updateMetadata({
        currentVersion: version,
        filename: actualFilename,
        size: buffer.length,
        updatedAt: new Date().toISOString(),
      });

      // 5. 清理旧版本
      await this.cleanupOldVersions();

      this.progress = {
        running: false,
        phase: 'done',
        version,
        message: `已安装 ${version}`,
        startedAt: this.progress.startedAt,
        finishedAt: new Date().toISOString(),
      };

      this.logger.log(`Windows 安装器 ${version} 安装成功 (${actualFilename})`);
    } catch (err) {
      throw err;
    }
  }

  // ===== 私有方法 =====

  private ensureStorage(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
      console.log(`[CoWorkerApp] 创建存储目录: ${this.storageDir}`);
    }
  }

  private readMetadata(): any {
    if (!fs.existsSync(this.metadataFile)) {
      return { currentVersion: null, filename: null, size: 0, updatedAt: null };
    }
    try {
      return JSON.parse(fs.readFileSync(this.metadataFile, 'utf-8'));
    } catch {
      return { currentVersion: null, filename: null, size: 0, updatedAt: null };
    }
  }

  private async updateMetadata(data: any): Promise<void> {
    fs.writeFileSync(this.metadataFile, JSON.stringify(data, null, 2));
  }
}
