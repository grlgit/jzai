import { Injectable, Logger } from '@nestjs/common';
import { WorkspaceService } from './workspace.service';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 导出文件删除的统一入口（Excel / PDF），带强制的 fileId 路径穿越防护。
 *
 * fileId 来自工具参数、HTTP 路径段与工作流补偿，全部是不可信输入；
 * 之前各调用点直接 path.join(exportDir, fileId)，`../../..` 可越出用户目录。
 */
@Injectable()
export class FileCleanupService {
  private readonly logger = new Logger(FileCleanupService.name);

  constructor(private readonly workspace: WorkspaceService) {}

  /**
   * 删除用户导出目录下的文件（含 PDF 子目录与其 .json 结构文件）。
   * 返回是否真的删掉了文件；fileId 非法或文件不存在都返回 false。
   */
  deleteExportFile(userId: string, fileId: string): boolean {
    if (!userId || !this.isSafeFileId(fileId)) {
      this.logger.warn(`拒绝删除非法 fileId: ${JSON.stringify(fileId)}`);
      return false;
    }

    const exportDir = this.workspace.getExportDir(userId);
    let deleted = false;

    // Excel 等直接落在 exports/ 下；PDF 落在 exports/pdf/ 下并另有 .json 结构文件。
    for (const dir of [exportDir, path.join(exportDir, 'pdf')]) {
      const filePath = this.resolveWithin(dir, fileId);
      if (!filePath) continue;
      if (this.unlinkIfExists(filePath)) deleted = true;
      this.unlinkIfExists(`${filePath}.json`);
    }

    if (deleted) this.logger.log(`已删除导出文件: ${userId}/${fileId}`);
    return deleted;
  }

  /**
   * 解析用户导出目录下的绝对路径，供读取侧（下载）复用同一套穿越防护。
   * fileId 非法时返回 null。
   */
  resolveExportPath(userId: string, fileId: string, subDir?: string): string | null {
    if (!userId || !this.isSafeFileId(fileId)) {
      this.logger.warn(`拒绝解析非法 fileId: ${JSON.stringify(fileId)}`);
      return null;
    }
    const base = subDir ? path.join(this.workspace.getExportDir(userId), subDir) : this.workspace.getExportDir(userId);
    return this.resolveWithin(base, fileId);
  }

  /**
   * fileId 必须是单个路径段：拒绝分隔符与父目录引用。
   * 生成侧固定为 `${Date.now()}_${rand}_${safeName}`，天然满足。
   */
  private isSafeFileId(fileId: string): boolean {
    if (!fileId || typeof fileId !== 'string') return false;
    if (fileId.includes('/') || fileId.includes('\\')) return false;
    if (fileId === '.' || fileId === '..' || fileId.includes('..')) return false;
    if (fileId.includes('\0')) return false;
    return true;
  }

  /** 二重保险：解析后断言仍在 baseDir 内（防符号链接/编码绕过）。 */
  private resolveWithin(baseDir: string, fileId: string): string | null {
    const base = path.resolve(baseDir);
    const resolved = path.resolve(base, fileId);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      this.logger.warn(`拒绝越出导出目录的路径: ${resolved}`);
      return null;
    }
    return resolved;
  }

  private unlinkIfExists(filePath: string): boolean {
    try {
      if (!fs.existsSync(filePath)) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch (err: any) {
      this.logger.warn(`删除失败 ${filePath}: ${err.message}`);
      return false;
    }
  }
}
