import { Test, TestingModule } from '@nestjs/testing';
import { FileCleanupService } from './file-cleanup.service';
import { WorkspaceService } from './workspace.service';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('FileCleanupService', () => {
  let service: FileCleanupService;
  let exportDir: string;
  let outside: string;

  beforeEach(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jz-cleanup-'));
    exportDir = path.join(root, 'users', 'u1', 'exports');
    fs.mkdirSync(path.join(exportDir, 'pdf'), { recursive: true });
    outside = path.join(root, 'secret.txt');
    fs.writeFileSync(outside, 'x');

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        FileCleanupService,
        { provide: WorkspaceService, useValue: { getExportDir: () => exportDir } },
      ],
    }).compile();
    service = mod.get(FileCleanupService);
  });

  it('删除导出目录下的 Excel 文件', () => {
    const file = path.join(exportDir, '1_ab_report.xlsx');
    fs.writeFileSync(file, 'x');

    expect(service.deleteExportFile('u1', '1_ab_report.xlsx')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('删除 PDF 时一并删除 .json 结构文件', () => {
    const file = path.join(exportDir, 'pdf', '1_ab_doc.pdf');
    fs.writeFileSync(file, 'x');
    fs.writeFileSync(`${file}.json`, '{}');

    expect(service.deleteExportFile('u1', '1_ab_doc.pdf')).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.json`)).toBe(false);
  });

  it('拒绝路径穿越的 fileId 且不删除目录外文件', () => {
    for (const evil of ['../../../secret.txt', '..', 'pdf/1_ab_doc.pdf', 'a\\b', '..\\secret.txt']) {
      expect(service.deleteExportFile('u1', evil)).toBe(false);
    }
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('缺少 userId 或空 fileId 时返回 false', () => {
    expect(service.deleteExportFile('', 'a.xlsx')).toBe(false);
    expect(service.deleteExportFile('u1', '')).toBe(false);
  });

  it('resolveExportPath 对合法 fileId 返回目录内路径，对穿越返回 null', () => {
    expect(service.resolveExportPath('u1', '1_ab_report.xlsx')).toBe(path.join(exportDir, '1_ab_report.xlsx'));
    expect(service.resolveExportPath('u1', 'pdf/../../x')).toBeNull();
    expect(service.resolveExportPath('u1', '1_ab_doc.pdf', 'pdf')).toBe(path.join(exportDir, 'pdf', '1_ab_doc.pdf'));
  });
});
