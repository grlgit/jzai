import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import extractZip from 'extract-zip';
import { AppManifestSchema } from '../validators/manifest.schema';
import { AppValidatorService } from '../validators/app-validator.service';
import { AppRegistryService } from './app-registry.service';
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
  ) {}

  start(packagePath: string): AppInstallOperationStatus {
    const operation = this.operations.create();
    void this.stage(packagePath, operation.stageId);
    return operation;
  }

  private async stage(packagePath: string, stageId: string): Promise<void> {
    let stageDir: string | undefined;
    try {
      stageDir = path.join(os.tmpdir(), `jzapp_stage_${stageId}`);
      fs.mkdirSync(stageDir, { recursive: true });
      this.operations.setStageDir(stageId, stageDir);
      this.operations.update(stageId, 'unpacking', 15, '正在解包应用包…');
      await extractZip(packagePath, { dir: stageDir });

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
      this.operations.setReady(
        stageId,
        { appId: manifest.appId, version: manifest.version, name: manifest.name },
        report.warnings.map(result => result.message),
      );
    } catch (err: any) {
      this.logger.error(`Failed to stage app package ${stageId}: ${err.message}`, err.stack);
      this.operations.fail(stageId, '应用包无法解包或校验，请确认它是有效的 .jzapp 文件');
      if (stageDir) this.operations.clearStageDir(stageId);
    } finally {
      fs.rmSync(packagePath, { force: true });
    }
  }
}
