import { Injectable, Logger } from '@nestjs/common';
import { WorkspaceService } from '../../workspace/workspace.service';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

interface BuildProgress {
  running: boolean;
  phase: 'idle' | 'checking' | 'cert' | 'deps' | 'build' | 'sign' | 'done' | 'error';
  message?: string;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
  output?: string;
}

interface BuildResult {
  success: boolean;
  installerPath?: string;
  version?: string;
  size?: number;
  error?: string;
}

/**
 * Windows 安装器构建服务
 *
 * 在服务器上构建见智 CoWorker Windows 安装器：
 * 1. 检查构建环境（Node.js, wine, osslsigncode）
 * 2. 生成/缓存自签名证书
 * 3. 安装 Electron 依赖
 * 4. 运行 electron-builder
 * 5. 使用 osslsigncode 签名
 */
@Injectable()
export class CoWorkerWinBuildService {
  private readonly logger = new Logger(CoWorkerWinBuildService.name);

  // 构建状态
  private progress: BuildProgress = { running: false, phase: 'idle' };

  // 构建目录
  private get buildDir(): string {
    // 优先使用环境变量，否则使用工作空间下的目录
    return process.env.JIANZHI_WIN_BUILD_DIR ||
           path.join(this.workspace.getRoot(), '.win-build');
  }

  // coworker-app 源码目录
  private get sourceDir(): string {
    return process.env.JIANZHI_WIN_SOURCE_DIR ||
           path.join(process.cwd(), 'coworker-app');
  }

  // 证书目录
  private get certDir(): string {
    return path.join(this.buildDir, 'certificates');
  }

  // 输出目录
  private get outputDir(): string {
    return path.join(this.buildDir, 'dist');
  }

  // 证书路径
  private get certPfxPath(): string {
    return path.join(this.certDir, 'jzai-code-signing.pfx');
  }

  constructor(private readonly workspace: WorkspaceService) {
    // 确保构建目录存在
    this.ensureBuildDirs();
  }

  /**
   * 获取当前构建状态
   */
  getProgress(): BuildProgress {
    return { ...this.progress };
  }

  /**
   * 检查构建环境
   */
  async checkEnvironment(): Promise<{
    ok: boolean;
    nodeVersion?: string;
    wine?: boolean;
    osslsigncode?: boolean;
    errors?: string[];
  }> {
    const errors: string[] = [];
    let nodeVersion: string | null = null;
    let wine = false;
    let osslsigncode = false;

    try {
      // 检查 Node.js
      const nodeResult = await execFileAsync('node', ['--version']);
      nodeVersion = nodeResult.stdout.trim();
      const major = parseInt(nodeVersion.replace('v', '').split('.')[0], 10);
      if (major < 18) {
        errors.push(`Node.js 版本过低: ${nodeVersion} (需要 >=18)`);
      }
    } catch {
      errors.push('未找到 Node.js');
    }

    try {
      // 检查 wine
      await execFileAsync('wine', ['--version']);
      wine = true;
    } catch {
      errors.push('未安装 wine（Linux 上构建 Windows 安装器需要）');
    }

    try {
      // 检查 osslsigncode
      await execFileAsync('osslsigncode', ['--version']);
      osslsigncode = true;
    } catch {
      errors.push('未安装 osslsigncode（签名需要）');
    }

    return {
      ok: errors.length === 0,
      nodeVersion: nodeVersion || undefined,
      wine,
      osslsigncode,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  /**
   * 生成或复用自签名证书
   */
  async ensureCertificate(): Promise<{ exists: boolean; path: string }> {
    if (fs.existsSync(this.certPfxPath)) {
      this.logger.log('证书已存在，复用现有证书');
      return { exists: true, path: this.certPfxPath };
    }

    this.logger.log('证书不存在，生成新证书...');

    // 确保证书目录存在
    if (!fs.existsSync(this.certDir)) {
      fs.mkdirSync(this.certDir, { recursive: true });
    }

    // 生成自签名证书
    const certScript = path.join(this.sourceDir, 'certificates', 'generate-self-signed-cert.sh');

    if (fs.existsSync(certScript)) {
      try {
        // 在证书目录中执行脚本
        await execFileAsync(certScript, [], {
          cwd: this.certDir,
          env: { ...process.env, CERT_DIR: this.certDir },
        });

        if (fs.existsSync(this.certPfxPath)) {
          this.logger.log('证书生成成功');
          return { exists: true, path: this.certPfxPath };
        }
      } catch (err) {
        this.logger.error(`证书生成失败: ${err}`);
        throw new Error('证书生成失败');
      }
    }

    throw new Error('证书脚本不存在');
  }

  /**
   * 安装 Electron 依赖
   */
  async installDependencies(): Promise<void> {
    const npm = process.env.NPM_PATH || 'npm';

    this.logger.log('安装 Electron 依赖...');

    try {
      await execFileAsync(npm, ['ci'], {
        cwd: this.sourceDir,
        env: process.env,
      });
      this.logger.log('依赖安装成功');
    } catch (err) {
      this.logger.error(`依赖安装失败: ${err}`);
      throw new Error('依赖安装失败');
    }
  }

  /**
   * 构建 Electron 安装器
   */
  async buildInstaller(): Promise<BuildResult> {
    this.logger.log('开始构建 Electron 安装器...');

    const npm = process.env.NPM_PATH || 'npm';

    try {
      // 运行 npm run build
      const { stdout, stderr } = await execFileAsync(npm, ['run', 'build'], {
        cwd: this.sourceDir,
        env: {
          ...process.env,
          CERT_DIR: this.certDir,
        },
      });

      this.logger.log('构建输出: ' + stdout);

      if (stderr) {
        this.logger.warn('构建警告: ' + stderr);
      }

      // 检查输出文件
      const expectedOutput = path.join(this.sourceDir, 'dist', '见智CoWorker-Setup-x64.exe');

      if (!fs.existsSync(expectedOutput)) {
        return {
          success: false,
          error: '构建产物未找到',
        };
      }

      // 获取文件信息
      const stats = fs.statSync(expectedOutput);

      return {
        success: true,
        installerPath: expectedOutput,
        version: '1.0.0',
        size: stats.size,
      };
    } catch (err) {
      this.logger.error(`构建失败: ${err}`);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 签名安装器
   */
  async signInstaller(installerPath: string): Promise<boolean> {
    this.logger.log('签名安装器...');

    const signScript = path.join(this.sourceDir, 'certificates', 'sign-windows.sh');

    if (!fs.existsSync(signScript)) {
      this.logger.warn('签名脚本不存在，跳过签名');
      return false;
    }

    try {
      await execFileAsync(signScript, [installerPath], {
        env: {
          ...process.env,
          CERT_DIR: this.certDir,
        },
      });

      this.logger.log('签名成功');
      return true;
    } catch (err) {
      this.logger.error(`签名失败: ${err}`);
      return false;
    }
  }

  /**
   * 启动构建流程（异步）
   */
  async startBuild(): Promise<{ started: boolean; reason?: string }> {
    if (this.progress.running) {
      return { started: false, reason: '已有构建任务进行中' };
    }

    this.progress = {
      running: true,
      phase: 'checking',
      message: '检查构建环境',
      startedAt: new Date().toISOString(),
    };

    // 异步执行构建
    this.runBuild().catch(err => {
      this.logger.error(`构建失败: ${err}`);
      this.progress = {
        ...this.progress,
        running: false,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
        finishedAt: new Date().toISOString(),
      };
    });

    return { started: true };
  }

  /**
   * 内部构建流程
   */
  private async runBuild(): Promise<void> {
    try {
      // 1. 检查环境
      this.progress.phase = 'checking';
      this.progress.message = '检查构建环境';
      const envCheck = await this.checkEnvironment();
      if (!envCheck.ok) {
        throw new Error(`环境检查失败: ${envCheck.errors?.join(', ')}`);
      }

      // 2. 生成/复用证书
      this.progress.phase = 'cert';
      this.progress.message = '准备证书';
      await this.ensureCertificate();

      // 3. 安装依赖
      this.progress.phase = 'deps';
      this.progress.message = '安装依赖';
      await this.installDependencies();

      // 4. 构建
      this.progress.phase = 'build';
      this.progress.message = '构建 Electron 应用';
      const buildResult = await this.buildInstaller();
      if (!buildResult.success || !buildResult.installerPath) {
        throw new Error(buildResult.error || '构建失败');
      }

      // 5. 签名
      this.progress.phase = 'sign';
      this.progress.message = '签名安装器';
      await this.signInstaller(buildResult.installerPath);

      // 6. 完成
      this.progress = {
        running: false,
        phase: 'done',
        message: `构建成功 (${(buildResult.size! / 1024 / 1024).toFixed(1)} MB)`,
        startedAt: this.progress.startedAt,
        finishedAt: new Date().toISOString(),
      };

      this.logger.log('构建完成');
    } catch (err) {
      throw err;
    }
  }

  /**
   * 获取已构建的安装器信息
   */
  getInstallerInfo(): { available: boolean; path?: string; version?: string; size?: number } | null {
    const expectedOutput = path.join(this.sourceDir, 'dist', '见智CoWorker-Setup-x64.exe');

    if (!fs.existsSync(expectedOutput)) {
      return { available: false };
    }

    const stats = fs.statSync(expectedOutput);

    return {
      available: true,
      path: expectedOutput,
      version: '1.0.0',
      size: stats.size,
    };
  }

  /**
   * 生成 token 配置文件内容
   */
  generateTokenConfig(token: string, mainUrl: string): string {
    return JSON.stringify({
      token,
      mainUrl,
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
    }, null, 2);
  }

  /**
   * 确保构建目录存在
   */
  private ensureBuildDirs(): void {
    const dirs = [
      this.buildDir,
      this.certDir,
      this.outputDir,
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }
}
