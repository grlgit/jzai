import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';

export type DevUploadStatus = 'pending' | 'ready' | 'consumed' | 'expired';

export interface DevUploadRecord {
  uploadId: string;
  status: DevUploadStatus;
  size?: number;
  sha256?: string;
  createdAt: string;
  expiresAt: string;
}

interface DevUploadEntry extends DevUploadRecord {
  filePath?: string;
}

const TTL_MS = 30 * 60 * 1000;
const SWEEP_MS = 5 * 60 * 1000;

/**
 * Dev MCP 大包上传句柄注册表（/api/dev/uploads 的支撑服务）。
 *
 * 生命周期：pending（jd_upload_begin 预留）→ ready（multipart 落盘）
 * → consumed（install/upgrade/validate 执行取用）/expired（30 分钟未用）。
 * 文件落 os.tmpdir()，consume 后由执行方用毕调 release 删除。
 *
 * 与 DevMcpService 同为进程内注册表：单实例约束一致（devMcp.enabled 不多实例开）。
 */
@Injectable()
export class DevUploadService {
  private readonly logger = new Logger(DevUploadService.name);
  private readonly uploads = new Map<string, DevUploadEntry>();

  /** 预留上传句柄（jd_upload_begin）。 */
  begin(): DevUploadRecord {
    const entry: DevUploadEntry = {
      uploadId: `upl_${crypto.randomBytes(8).toString('hex')}`,
      status: 'pending',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
    };
    this.uploads.set(entry.uploadId, entry);
    this.scheduleExpiry(entry.uploadId);
    return this.toRecord(entry);
  }

  /** multipart 落盘后绑定文件；uploadId 缺省时直接建档（不经 begin 的单步上传）。 */
  async attach(uploadId: string | undefined, filePath: string, size: number): Promise<DevUploadRecord> {
    let entry = uploadId ? this.uploads.get(uploadId) : undefined;
    if (uploadId && !entry) throw new NotFoundException('上传句柄不存在或已过期');
    if (entry && entry.status !== 'pending') {
      throw new Error(`上传句柄状态 ${entry.status} 不可写入（一句柄一包，重新 begin）`);
    }
    if (!entry) {
      const record = this.begin();
      entry = this.uploads.get(record.uploadId)!;
    }
    entry.filePath = filePath;
    entry.size = size;
    entry.sha256 = await this.hashFile(filePath);
    entry.status = 'ready';
    return this.toRecord(entry);
  }

  /** 查询句柄状态（jd_upload_status / GET /api/dev/uploads/:id）。 */
  get(uploadId: string): DevUploadRecord {
    return this.toRecord(this.require(uploadId));
  }

  /** 执行方取用包路径：要求 ready，标记 consumed（一句柄一次性）。 */
  consume(uploadId: string): string {
    const entry = this.require(uploadId);
    if (entry.status !== 'ready' || !entry.filePath) {
      throw new Error(`上传句柄状态 ${entry.status} 不可执行（需 ready）`);
    }
    entry.status = 'consumed';
    return entry.filePath;
  }

  /** 执行方用毕释放：删文件并移除句柄。 */
  release(uploadId: string): void {
    const entry = this.uploads.get(uploadId);
    if (!entry) return;
    if (entry.filePath) fs.rmSync(entry.filePath, { force: true });
    this.uploads.delete(uploadId);
  }

  private require(uploadId: string): DevUploadEntry {
    const entry = this.uploads.get(uploadId);
    if (!entry) throw new NotFoundException('上传句柄不存在或已过期');
    return entry;
  }

  private toRecord(entry: DevUploadEntry): DevUploadRecord {
    const { filePath: _filePath, ...record } = entry;
    return record;
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  private scheduleExpiry(uploadId: string): void {
    setTimeout(() => {
      const entry = this.uploads.get(uploadId);
      if (!entry) return;
      if (entry.filePath) fs.rmSync(entry.filePath, { force: true });
      entry.filePath = undefined;
      if (entry.status !== 'consumed') entry.status = 'expired';
      setTimeout(() => this.uploads.delete(uploadId), SWEEP_MS).unref();
    }, TTL_MS).unref();
  }
}
