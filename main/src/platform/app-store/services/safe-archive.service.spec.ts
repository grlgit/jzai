import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { APP_ARCHIVE_LIMITS, SafeArchiveService } from './safe-archive.service';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');

async function createArchive(entries: Array<{ name: string; content?: string; symlink?: string }>): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-archive-source-'));
  const archivePath = path.join(dir, 'package.jzapp');
  await new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(archivePath);
    const archive = archiver('zip', { zlib: { level: 1 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const entry of entries) {
      if (entry.symlink !== undefined) archive.symlink(entry.name, entry.symlink);
      else archive.append(entry.content ?? '', { name: entry.name });
    }
    void archive.finalize();
  });
  return archivePath;
}

describe('SafeArchiveService', () => {
  const service = new SafeArchiveService();
  const cleanupRoots = new Set<string>();

  afterEach(() => {
    for (const root of cleanupRoots) fs.rmSync(root, { recursive: true, force: true });
    cleanupRoots.clear();
  });

  async function extract(entries: Array<{ name: string; content?: string; symlink?: string }>) {
    const archive = await createArchive(entries);
    const output = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-archive-output-'));
    cleanupRoots.add(path.dirname(archive));
    cleanupRoots.add(output);
    return { archive, output, run: service.extract(archive, output) };
  }

  it('extracts a normal package', async () => {
    const { output, run } = await extract([{ name: 'manifest.json', content: '{}' }]);
    await expect(run).resolves.toBeUndefined();
    expect(fs.readFileSync(path.join(output, 'manifest.json'), 'utf-8')).toBe('{}');
  });

  it.each([
    ['duplicate entries', [{ name: 'a.txt' }, { name: 'a.txt' }], 'APP_ARCHIVE_DUPLICATE_PATH'],
    ['case-conflicting entries', [{ name: 'A.txt' }, { name: 'a.txt' }], 'APP_ARCHIVE_CASE_CONFLICT'],
    ['symlinks', [{ name: 'link', symlink: '../outside' }], 'APP_ARCHIVE_SYMLINK'],
  ])('rejects %s and removes partial output', async (_label, entries, code) => {
    const { output, run } = await extract(entries as Array<{ name: string; content?: string; symlink?: string }>);
    await expect(run).rejects.toThrow(code as string);
    expect(fs.existsSync(output)).toBe(false);
  });

  it.each([
    ['../escape.txt', 'APP_ARCHIVE_PATH_TRAVERSAL'],
    ['safe/../escape.txt', 'APP_ARCHIVE_PATH_TRAVERSAL'],
    ['/escape.txt', 'APP_ARCHIVE_ABSOLUTE_PATH'],
    ['C:/escape.txt', 'APP_ARCHIVE_ABSOLUTE_PATH'],
    ['folder/file:stream', 'APP_ARCHIVE_INVALID_PATH'],
    ['folder/CON.txt', 'APP_ARCHIVE_INVALID_PATH'],
    ['folder/name. ', 'APP_ARCHIVE_INVALID_PATH'],
    [`${'folder/'.repeat(APP_ARCHIVE_LIMITS.maxPathDepth)}file.txt`, 'APP_ARCHIVE_PATH_TOO_DEEP'],
  ])('rejects unsafe entry path %s', (name, code) => {
    expect(() => (service as any).validateEntryPath(name)).toThrow(code);
  });

  it('counts directory entries against the archive entry limit', async () => {
    const originalLimit = APP_ARCHIVE_LIMITS.maxFiles;
    APP_ARCHIVE_LIMITS.maxFiles = 2;
    try {
      const { run } = await extract([
        { name: 'one/' },
        { name: 'two/' },
        { name: 'three/' },
      ]);
      await expect(run).rejects.toThrow('APP_ARCHIVE_TOO_MANY_FILES');
    } finally {
      APP_ARCHIVE_LIMITS.maxFiles = originalLimit;
    }
  });
});
