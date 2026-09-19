import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import extractZip from 'extract-zip';
import * as yauzl from 'yauzl';

export const APP_ARCHIVE_LIMITS = {
  maxFiles: 5000,
  maxArchiveBytes: 200 * 1024 * 1024,
  maxEntryBytes: 100 * 1024 * 1024,
  maxUncompressedBytes: 200 * 1024 * 1024,
  maxPathBytes: 1024,
  maxPathDepth: 32,
};

@Injectable()
export class SafeArchiveService {
  async extract(archivePath: string, destination: string): Promise<void> {
    const archiveSize = fs.statSync(archivePath).size;
    if (archiveSize > APP_ARCHIVE_LIMITS.maxArchiveBytes) {
      throw new Error('APP_ARCHIVE_TOO_LARGE');
    }

    const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzapp-archive-'));
    const privateArchive = path.join(privateDir, 'package.jzapp');
    fs.copyFileSync(archivePath, privateArchive);
    fs.rmSync(destination, { recursive: true, force: true });

    try {
      await this.validateArchive(privateArchive);
      fs.mkdirSync(destination, { recursive: true });
      await extractZip(privateArchive, { dir: destination });
    } catch (error) {
      fs.rmSync(destination, { recursive: true, force: true });
      throw error;
    } finally {
      fs.rmSync(privateDir, { recursive: true, force: true });
    }
  }

  private validateArchive(archivePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      yauzl.open(archivePath, { lazyEntries: true }, (openError, zipFile) => {
        if (openError || !zipFile) {
          reject(openError ?? new Error('APP_ARCHIVE_INVALID'));
          return;
        }

        const exact = new Set<string>();
        const folded = new Map<string, string>();
        let entryCount = 0;
        let totalSize = 0;
        let settled = false;
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          zipFile.close();
          reject(error);
        };

        zipFile.on('error', fail);
        zipFile.on('end', () => {
          if (settled) return;
          settled = true;
          resolve();
        });
        zipFile.on('entry', entry => {
          try {
            const name = entry.fileName;
            const normalized = this.validateEntryPath(name);
            const isDirectory = name.endsWith('/');
            const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff;
            const fileType = unixMode & 0o170000;
            if (fileType === 0o120000) throw new Error(`APP_ARCHIVE_SYMLINK: ${name}`);
            if (fileType !== 0 && fileType !== 0o100000 && fileType !== 0o040000) {
              throw new Error(`APP_ARCHIVE_UNSUPPORTED_ENTRY: ${name}`);
            }

            if (exact.has(normalized)) throw new Error(`APP_ARCHIVE_DUPLICATE_PATH: ${name}`);
            exact.add(normalized);
            const lower = normalized.toLocaleLowerCase('en-US');
            const previous = folded.get(lower);
            if (previous && previous !== normalized) {
              throw new Error(`APP_ARCHIVE_CASE_CONFLICT: ${previous} / ${name}`);
            }
            folded.set(lower, normalized);

            entryCount += 1;
            if (entryCount > APP_ARCHIVE_LIMITS.maxFiles) throw new Error('APP_ARCHIVE_TOO_MANY_FILES');
            if (!isDirectory) {
              totalSize += entry.uncompressedSize;
              if (entry.uncompressedSize > APP_ARCHIVE_LIMITS.maxEntryBytes) {
                throw new Error(`APP_ARCHIVE_ENTRY_TOO_LARGE: ${name}`);
              }
              if (totalSize > APP_ARCHIVE_LIMITS.maxUncompressedBytes) {
                throw new Error('APP_ARCHIVE_UNCOMPRESSED_TOO_LARGE');
              }
            }
            zipFile.readEntry();
          } catch (error) {
            fail(error as Error);
          }
        });
        zipFile.readEntry();
      });
    });
  }

  private validateEntryPath(name: string): string {
    if (!name || name.includes('\0') || name.includes('\\')) {
      throw new Error(`APP_ARCHIVE_INVALID_PATH: ${name}`);
    }
    if (Buffer.byteLength(name, 'utf-8') > APP_ARCHIVE_LIMITS.maxPathBytes) {
      throw new Error(`APP_ARCHIVE_PATH_TOO_LONG: ${name}`);
    }
    if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name) || /^[A-Za-z]:/.test(name)) {
      throw new Error(`APP_ARCHIVE_ABSOLUTE_PATH: ${name}`);
    }

    const sourceSegments = name.replace(/\/$/, '').split('/');
    if (sourceSegments.includes('..')) throw new Error(`APP_ARCHIVE_PATH_TRAVERSAL: ${name}`);
    const normalized = path.posix.normalize(name).replace(/\/$/, '');
    const segments = normalized.split('/');
    if (!normalized || normalized === '.' || normalized.startsWith('../')) {
      throw new Error(`APP_ARCHIVE_PATH_TRAVERSAL: ${name}`);
    }
    if (segments.length > APP_ARCHIVE_LIMITS.maxPathDepth) {
      throw new Error(`APP_ARCHIVE_PATH_TOO_DEEP: ${name}`);
    }
    for (const segment of segments) {
      if (!segment || Buffer.byteLength(segment, 'utf-8') > 255 || segment.includes(':') || /[. ]$/.test(segment)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) {
        throw new Error(`APP_ARCHIVE_INVALID_PATH: ${name}`);
      }
    }
    return normalized;
  }
}
