import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';

export type AppInstallPhase =
  | 'downloading'
  | 'unpacking'
  | 'validating'
  | 'ready'
  | 'installing'
  | 'provisioning'
  | 'migrating'
  | 'activating'
  | 'succeeded'
  | 'failed'
  | 'expired';

export type AppInstallRecovery = 'purge-orphaned-data';

export interface AppPackageIntegrity {
  packageSha256: string | null;
  signatureVerified: boolean;
}

export interface AppInstallOperationStatus {
  stageId: string;
  phase: AppInstallPhase;
  percent: number;
  message: string;
  recovery?: AppInstallRecovery;
  appId?: string;
  version?: string;
  manifest?: { appId: string; version: string; name: unknown };
  integrity?: AppPackageIntegrity;
  /** true = 商城链路：ready 为过渡态（不停留等确认），面板轮询不应在 ready 停下 */
  autoInstall?: boolean;
  warnings: string[];
  errors: string[];
  startedAt: string;
  updatedAt: string;
  expiresAt: string;
}

interface AppInstallOperation extends AppInstallOperationStatus {
  stageDir?: string;
}

@Injectable()
export class AppInstallOperationService {
  private readonly operations = new Map<string, AppInstallOperation>();

  create(initial?: { phase: AppInstallPhase; percent: number; message: string; autoInstall?: boolean }): AppInstallOperationStatus {
    const stageId = crypto.randomBytes(12).toString('hex');
    const now = new Date();
    const operation: AppInstallOperation = {
      stageId,
      phase: initial?.phase ?? 'unpacking',
      percent: initial?.percent ?? 5,
      message: initial?.message ?? '正在解包应用包…',
      autoInstall: initial?.autoInstall,
      warnings: [],
      errors: [],
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    };
    this.operations.set(stageId, operation);
    this.scheduleExpiry(stageId);
    return this.toStatus(operation);
  }

  get(stageId: string): AppInstallOperationStatus {
    const operation = this.operations.get(stageId);
    if (!operation) throw new NotFoundException('安装操作不存在或已过期');
    return this.toStatus(operation);
  }

  getReadyStageDir(stageId: string): string {
    const operation = this.operations.get(stageId);
    if (!operation) throw new NotFoundException('安装操作不存在或已过期');
    if (operation.phase !== 'ready' || !operation.stageDir) {
      throw new BadRequestException('应用包尚未完成校验，无法安装');
    }
    return operation.stageDir;
  }

  getInstallStageDir(stageId: string, retryOrphanedData = false): string {
    const operation = this.operations.get(stageId);
    if (!operation) throw new NotFoundException('安装操作不存在或已过期');
    const readyToInstall = operation.phase === 'ready';
    const retryingResidue = retryOrphanedData
      && operation.phase === 'failed'
      && operation.recovery === 'purge-orphaned-data';
    if ((!readyToInstall && !retryingResidue) || !operation.stageDir) {
      throw new BadRequestException('应用包尚未完成校验，无法安装');
    }
    return operation.stageDir;
  }

  update(stageId: string, phase: AppInstallPhase, percent: number, message: string): void {
    const operation = this.require(stageId);
    operation.phase = phase;
    operation.percent = percent;
    operation.message = message;
    if (phase !== 'failed') operation.recovery = undefined;
    operation.updatedAt = new Date().toISOString();
  }

  setStageDir(stageId: string, stageDir: string): void {
    this.require(stageId).stageDir = stageDir;
  }

  setIntegrity(stageId: string, integrity: AppPackageIntegrity): void {
    this.require(stageId).integrity = integrity;
  }

  getIntegrity(stageId: string): AppPackageIntegrity | undefined {
    return this.require(stageId).integrity;
  }

  setReady(
    stageId: string,
    manifest: { appId: string; version: string; name: unknown },
    warnings: string[],
  ): void {
    const operation = this.require(stageId);
    operation.appId = manifest.appId;
    operation.version = manifest.version;
    operation.manifest = manifest;
    operation.warnings = warnings;
    operation.phase = 'ready';
    operation.percent = 45;
    operation.message = '应用包校验通过，等待安装确认';
    operation.updatedAt = new Date().toISOString();
  }

  fail(
    stageId: string,
    errors: string | string[],
    message = '应用安装失败',
    recovery?: AppInstallRecovery,
  ): void {
    const operation = this.require(stageId);
    operation.phase = 'failed';
    operation.percent = 100;
    operation.message = message;
    operation.errors = Array.isArray(errors) ? errors : [errors];
    operation.recovery = recovery;
    operation.updatedAt = new Date().toISOString();
  }

  succeed(stageId: string): void {
    this.update(stageId, 'succeeded', 100, '应用安装并激活完成');
  }

  clearStageDir(stageId: string): void {
    const operation = this.require(stageId);
    if (operation.stageDir) fs.rmSync(operation.stageDir, { recursive: true, force: true });
    operation.stageDir = undefined;
  }

  private require(stageId: string): AppInstallOperation {
    const operation = this.operations.get(stageId);
    if (!operation) throw new NotFoundException('安装操作不存在或已过期');
    return operation;
  }

  private toStatus(operation: AppInstallOperation): AppInstallOperationStatus {
    const { stageDir: _stageDir, ...status } = operation;
    return status;
  }

  private scheduleExpiry(stageId: string): void {
    setTimeout(() => {
      const operation = this.operations.get(stageId);
      if (!operation) return;
      if (operation.stageDir) fs.rmSync(operation.stageDir, { recursive: true, force: true });
      operation.stageDir = undefined;
      if (!['succeeded', 'failed'].includes(operation.phase)) {
        operation.phase = 'expired';
        operation.percent = 100;
        operation.message = '安装操作已过期，请重新上传应用包';
        operation.updatedAt = new Date().toISOString();
      }
      setTimeout(() => this.operations.delete(stageId), 5 * 60 * 1000);
    }, 30 * 60 * 1000);
  }
}
