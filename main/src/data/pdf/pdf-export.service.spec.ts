import { Test, TestingModule } from '@nestjs/testing';
import { PdfExportService } from './pdf-export.service';
import { PdfChartRenderer } from './pdf-chart.renderer';
import { WorkspaceService } from '../../workspace/workspace.service';
import { FileCleanupService } from '../../workspace/file-cleanup.service';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { CredentialService } from '../../capability/skill/credential.service';
import * as fs from 'fs';
import * as path from 'path';

describe('PdfExportService', () => {
  let service: PdfExportService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = path.join(__dirname, '__test_pdf_output__');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PdfExportService,
        PdfChartRenderer,
        FileCleanupService,
        {
          provide: WorkspaceService,
          useValue: { getExportDir: () => tmpDir },
        },
        {
          provide: McpRegistryService,
          useValue: {
            get: jest.fn().mockReturnValue(null), // No MCP in test — tables/charts with data_source will return empty
          },
        },
        {
          provide: CredentialService,
          useValue: {
            resolveCredentials: jest.fn().mockReturnValue(null),
          },
        },
      ],
    }).compile();

    service = module.get<PdfExportService>(PdfExportService);
  });

  afterAll(() => {
    // Cleanup test output
    if (fs.existsSync(tmpDir)) {
      fs.readdirSync(tmpDir).forEach(f => {
        const fp = path.join(tmpDir, f);
        if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
      });
      // Clean subdirs
      const pdfDir = path.join(tmpDir, 'pdf');
      if (fs.existsSync(pdfDir)) {
        fs.readdirSync(pdfDir).forEach(f => fs.unlinkSync(path.join(pdfDir, f)));
        fs.rmdirSync(pdfDir);
      }
      fs.rmdirSync(tmpDir);
    }
  });

  it('should generate a simple PDF with heading and paragraph', async () => {
    const result = await service.generatePdf('test-user', {
      filename: '测试文档.pdf',
      sections: [
        { type: 'heading', level: 1, text: '测试标题' },
        { type: 'paragraph', text: '这是一个测试段落。' },
      ],
    });

    expect(result.fileId).toBeTruthy();
    expect(result.filename).toBe('测试文档.pdf');
    expect(result.filePath).toContain('测试文档.pdf');

    // PDF file should exist
    expect(fs.existsSync(result.filePath)).toBe(true);
    const stat = fs.statSync(result.filePath);
    expect(stat.size).toBeGreaterThan(100); // Non-trivial PDF

    // Structure JSON should also exist
    expect(fs.existsSync(result.filePath + '.json')).toBe(true);
  });

  it('should generate PDF with table from inline data', async () => {
    const result = await service.generatePdf('test-user', {
      filename: '数据表.pdf',
      sections: [
        { type: 'heading', level: 1, text: '数据报告' },
        {
          type: 'table',
          columns: [
            { key: 'name', header: '名称' },
            { key: 'value', header: '数值' },
          ],
          data: [
            { name: '项目A', value: 100 },
            { name: '项目B', value: 200 },
            { name: '项目C', value: 300 },
          ],
        },
      ],
    });

    expect(result.fileId).toBeTruthy();
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('should generate PDF with chart section', async () => {
    const result = await service.generatePdf('test-user', {
      filename: '图表报告.pdf',
      sections: [
        {
          type: 'chart',
          chartType: 'bar',
          title: '销售数据',
          data: {
            xAxis: ['1月', '2月', '3月'],
            series: [{ name: '销售额', data: [1000, 1500, 1200] }],
          },
        },
      ],
    });

    expect(result.fileId).toBeTruthy();
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('should generate PDF with key_values section', async () => {
    const result = await service.generatePdf('test-user', {
      filename: '指标卡.pdf',
      sections: [
        {
          type: 'key_values',
          title: '核心指标',
          layout: 'grid',
          items: [
            { label: '总收入', value: '¥1,234,567' },
            { label: '订单数', value: '456' },
            { label: '客户数', value: '89' },
            { label: '增长率', value: '+23%' },
          ],
        },
      ],
    });

    expect(result.fileId).toBeTruthy();
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('should generate PDF with page break', async () => {
    const result = await service.generatePdf('test-user', {
      filename: '多页文档.pdf',
      sections: [
        { type: 'heading', level: 1, text: '第一页' },
        { type: 'paragraph', text: '第一页内容' },
        { type: 'page_break' },
        { type: 'heading', level: 1, text: '第二页' },
        { type: 'paragraph', text: '第二页内容' },
      ],
    });

    expect(result.fileId).toBeTruthy();
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('should generate PDF with header and footer', async () => {
    const result = await service.generatePdf('test-user', {
      filename: '带页眉.pdf',
      header: { left: '测试公司', right: '2026-06-19' },
      footer: { center: '第 {{page}} 页 / 共 {{pages}} 页' },
      sections: [
        { type: 'heading', level: 1, text: '正式报告' },
        { type: 'paragraph', text: '正文内容' },
      ],
    });

    expect(result.fileId).toBeTruthy();
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('should list PDF files', async () => {
    const files = service.listFiles('test-user');
    expect(Array.isArray(files)).toBe(true);
    expect(files.length).toBeGreaterThanOrEqual(1);
    expect(files[0].fileId).toBeTruthy();
    expect(files[0].filename).toBeTruthy();
    expect(files[0].size).toBeGreaterThan(0);
  });

  it('should update an existing PDF', async () => {
    // Generate first
    const result = await service.generatePdf('test-user', {
      filename: '可编辑.pdf',
      sections: [
        { type: 'heading', level: 1, text: '原始标题' },
        { type: 'paragraph', text: '原始段落' },
      ],
    });

    // Update
    const updated = await service.updatePdf('test-user', result.fileId, [
      { sectionIndex: 0, field: 'text', value: '修改后的标题' },
    ]);

    expect(updated.success).toBe(true);
    expect(updated.updated).toBe(1);

    // Verify structure was updated
    const structPath = path.join(service['getPdfDir']('test-user'), result.fileId + '.json');
    const structure = JSON.parse(fs.readFileSync(structPath, 'utf-8'));
    expect(structure.spec.sections[0].text).toBe('修改后的标题');
  });

  it('should delete a PDF file', async () => {
    const result = await service.generatePdf('test-user', {
      filename: '删除测试.pdf',
      sections: [{ type: 'paragraph', text: '临时文件' }],
    });

    expect(fs.existsSync(result.filePath)).toBe(true);
    const deleted = service.deleteFile('test-user', result.fileId);
    expect(deleted).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(false);
  });
});
