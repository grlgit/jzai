import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { AppManifestSchema } from '../validators/manifest.schema';
import { AppValidatorService } from '../validators/app-validator.service';
import { AppRegistryService } from './app-registry.service';
import { SafeArchiveService } from './safe-archive.service';
import { PackageSignatureService } from './package-signature.service';
import { FIRST_PARTY_APP_ID } from './app-platform.service';
import {
  AppInstallOperationService,
  AppInstallOperationStatus,
} from './app-install-operation.service';

@Injectable()
export class AppStagingService {
  private readonly logger = new Logger(AppStagingService.name);

  constructor(
    private readonly validator: AppValidatorService,
    private readonly registry: AppRegistryService,
    private readonly operations: AppInstallOperationService,
    private readonly archives: SafeArchiveService,
    private readonly signatures: PackageSignatureService,
  ) {}

  /**
   * @param stageId 传入时挂到已存在的安装操作上（如商城链路已创建的 downloading 记录），
   *                不传则新建操作（本机上传安装路径）。
   */
  start(packagePath: string, stageId?: string): AppInstallOperationStatus {
    const operation = stageId
      ? this.operations.get(stageId)
      : this.operations.create();
    void this.stage(packagePath, operation.stageId);
    return operation;
  }

  private async stage(packagePath: string, stageId: string): Promise<void> {
    let stageDir: string | undefined;
    try {
      // 包文件 hash 先行（stage 结束后包文件会被删除）
      const packageSha256 = await this.signatures.hashFile(packagePath);

      stageDir = path.join(os.tmpdir(), `jzapp_stage_${stageId}`);
      this.operations.setStageDir(stageId, stageDir);
      this.operations.update(stageId, 'unpacking', 15, '正在解包应用包…');
      await this.archives.extract(packagePath, stageDir);

      this.operations.update(stageId, 'validating', 30, '正在校验应用包…');
      const ids = await this.registry.getExistingIds();
      const report = await this.validator.validate(
        stageDir,
        ids.appIds,
        ids.shortNames,
        ids.nsPrefixes,
        ids.schemaNames,
        ids.panelIds,
        ids.toolIds,
      );

      if (!report.passed) {
        this.operations.fail(stageId, report.criticals.map(result => result.message));
        this.operations.clearStageDir(stageId);
        return;
      }

      const manifest = AppManifestSchema.parse(
        JSON.parse(fs.readFileSync(path.join(stageDir, 'manifest.json'), 'utf-8')),
      );

      // 包签名验签：官方包（com.jianzhi.*/com.menhu.*）强制，第三方包无签名仅告警
      const sigResult = this.signatures.verifyDirectory(stageDir);
      const sigCheck = this.signatures.check(sigResult, FIRST_PARTY_APP_ID.test(manifest.appId));
      if (!sigCheck.ok) {
        this.operations.fail(stageId, sigCheck.warning!);
        this.operations.clearStageDir(stageId);
        return;
      }
      const signatureVerified = sigResult.status === 'valid';
      this.operations.setIntegrity(stageId, { packageSha256, signatureVerified });

      const warnings = report.warnings.map(result => result.message);
      if (sigCheck.warning && sigResult.status !== 'valid') warnings.push(sigCheck.warning);

      this.operations.setReady(
        stageId,
        { appId: manifest.appId, version: manifest.version, name: manifest.name },
        warnings,
      );
    } catch (err: any) {
      this.logger.error(`Failed to stage app package ${stageId}: ${err.message}`, err.stack);
      // 真实原因（zip 损坏 / manifest 缺失 / schema 不符等）透出给面板，避免只见"失败"不见原因
      const detail = String(err?.message || '未知错误').slice(0, 500);
      this.operations.fail(stageId, `应用包无法解包或校验: ${detail}`);
      if (stageDir) this.operations.clearStageDir(stageId);
    } finally {
      fs.rmSync(packagePath, { force: true });
    }
  }
}
