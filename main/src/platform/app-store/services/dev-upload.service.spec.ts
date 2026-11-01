import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DevUploadService } from './dev-upload.service';

describe('DevUploadService', () => {
  let service: DevUploadService;
  let pkgPath: string;

  beforeEach(() => {
    service = new DevUploadService();
    pkgPath = path.join(os.tmpdir(), `dev-upload-spec-${Date.now()}.jzapp`);
    fs.writeFileSync(pkgPath, 'fake-zip-bytes');
  });

  afterEach(() => {
    fs.rmSync(pkgPath, { force: true });
  });

  it('runs the full lifecycle: begin → attach → ready → consume → release', async () => {
    const begun = service.begin();
    expect(begun.status).toBe('pending');
    expect(begun.uploadId).toMatch(/^upl_[0-9a-f]{16}$/);

    const attached = await service.attach(begun.uploadId, pkgPath, 14);
    expect(attached.status).toBe('ready');
    expect(attached.size).toBe(14);
    expect(attached.sha256).toMatch(/^[0-9a-f]{64}$/);

    expect(service.get(begun.uploadId).status).toBe('ready');

    const consumedPath = service.consume(begun.uploadId);
    expect(consumedPath).toBe(pkgPath);
    expect(service.get(begun.uploadId).status).toBe('consumed');

    service.release(begun.uploadId);
    expect(fs.existsSync(pkgPath)).toBe(false);
    expect(() => service.get(begun.uploadId)).toThrow(/不存在或已过期/);
  });

  it('attaches without begin (single-step upload creates the handle)', async () => {
    const record = await service.attach(undefined, pkgPath, 14);
    expect(record.status).toBe('ready');
    expect(service.get(record.uploadId).sha256).toBe(record.sha256);
    service.release(record.uploadId);
  });

  it('rejects attach to a non-pending handle and double consume', async () => {
    const { uploadId } = service.begin();
    await service.attach(uploadId, pkgPath, 14);
    await expect(service.attach(uploadId, pkgPath, 14)).rejects.toThrow(/不可写入/);
    service.consume(uploadId);
    expect(() => service.consume(uploadId)).toThrow(/不可执行/);
    service.release(uploadId);
  });

  it('rejects unknown uploadId on attach/consume/get', async () => {
    await expect(service.attach('upl_missing', pkgPath, 14)).rejects.toThrow(/不存在或已过期/);
    expect(() => service.consume('upl_missing')).toThrow(/不存在或已过期/);
    expect(() => service.get('upl_missing')).toThrow(/不存在或已过期/);
  });

  it('expires a pending handle after TTL and sweeps it later', () => {
    jest.useFakeTimers();
    try {
      const { uploadId } = service.begin();
      jest.advanceTimersByTime(30 * 60 * 1000);
      expect(service.get(uploadId).status).toBe('expired');
      expect(() => service.consume(uploadId)).toThrow(/不可执行/);
      jest.advanceTimersByTime(5 * 60 * 1000);
      expect(() => service.get(uploadId)).toThrow(/不存在或已过期/);
    } finally {
      jest.useRealTimers();
    }
  });

  it('expires a ready handle and deletes its file', async () => {
    jest.useFakeTimers();
    try {
      const { uploadId } = service.begin();
      // attach 内部有异步 hashFile——fake timers 下直接驱动微任务
      const attachPromise = service.attach(uploadId, pkgPath, 14);
      await attachPromise;
      jest.advanceTimersByTime(30 * 60 * 1000);
      expect(service.get(uploadId).status).toBe('expired');
      expect(fs.existsSync(pkgPath)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});
