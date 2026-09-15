import { Test, TestingModule } from '@nestjs/testing';
import { PdfTemplateService } from './pdf-template.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import * as fs from 'fs';
import * as path from 'path';

describe('PdfTemplateService', () => {
  let service: PdfTemplateService;
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = path.join(__dirname, '__test_tpl_output__');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PdfTemplateService,
        {
          provide: WorkspaceService,
          useValue: { getRoot: () => tmpDir, getExportDir: () => tmpDir },
        },
      ],
    }).compile();

    service = module.get<PdfTemplateService>(PdfTemplateService);
    service.onModuleInit();
  });

  afterAll(() => {
    if (fs.existsSync(tmpDir)) {
      // Recursively clean up
      const rmDir = (dir: string) => {
        if (!fs.existsSync(dir)) return;
        fs.readdirSync(dir).forEach(f => {
          const fp = path.join(dir, f);
          if (fs.statSync(fp).isDirectory()) rmDir(fp);
          else fs.unlinkSync(fp);
        });
        fs.rmdirSync(dir);
      };
      rmDir(tmpDir);
    }
  });

  it('should load system templates from config', () => {
    const templates = service.listTemplates('test-user');
    const systemTemplates = templates.filter(t => t.isSystem);
    expect(systemTemplates.length).toBeGreaterThanOrEqual(1);

    // Check sales_report exists
    const sales = systemTemplates.find(t => t.id === 'sales_report');
    expect(sales).toBeTruthy();
    expect(sales!.name).toBe('销售报告');
    expect(sales!.sections.length).toBeGreaterThan(0);
  });

  it('should create a user template', () => {
    const tpl = service.createTemplate('test-user', {
      name: '测试模板',
      description: '单元测试用',
      icon: '🧪',
      sections: [
        { type: 'heading', level: 1, text: '{{title}}' },
        { type: 'paragraph', text: '{{content}}' },
      ],
    });

    expect(tpl.id).toBeTruthy();
    expect(tpl.name).toBe('测试模板');
    expect(tpl.isSystem).toBe(false);
    expect(tpl.userId).toBe('test-user');
    expect(tpl.sections).toHaveLength(2);
  });

  it('should list both system and user templates', () => {
    const templates = service.listTemplates('test-user');
    const system = templates.filter(t => t.isSystem);
    const user = templates.filter(t => !t.isSystem);
    expect(system.length).toBeGreaterThanOrEqual(1);
    expect(user.length).toBeGreaterThanOrEqual(1);
  });

  it('should get a template by ID', () => {
    // System template
    const sys = service.getTemplate('test-user', 'sales_report');
    expect(sys).toBeTruthy();
    expect(sys!.isSystem).toBe(true);

    // User template
    const all = service.listTemplates('test-user');
    const userTpl = all.find(t => !t.isSystem);
    if (userTpl) {
      const got = service.getTemplate('test-user', userTpl.id);
      expect(got).toBeTruthy();
      expect(got!.id).toBe(userTpl.id);
    }
  });

  it('should update a user template', () => {
    const tpl = service.createTemplate('test-user', { name: '待更新' });
    const updated = service.updateTemplate('test-user', tpl.id, { name: '已更新', description: '更新后' });
    expect(updated).toBeTruthy();
    expect(updated!.name).toBe('已更新');
    expect(updated!.description).toBe('更新后');
  });

  it('should update a system (shared) template', () => {
    const result = service.updateTemplate('test-user', 'sales_report', { name: '销售报告(已编辑)' });
    expect(result).toBeTruthy();
    expect(result!.name).toBe('销售报告(已编辑)');
    expect(result!.isSystem).toBe(true);
    // Restore original name
    service.updateTemplate('test-user', 'sales_report', { name: '销售报告' });
  });

  it('should duplicate a template', () => {
    const dup = service.duplicateTemplate('test-user', 'sales_report');
    expect(dup).toBeTruthy();
    expect(dup!.name).toContain('副本');
    expect(dup!.isSystem).toBe(false);
    expect(dup!.sections.length).toBeGreaterThan(0);
  });

  it('should delete a user template', () => {
    const tpl = service.createTemplate('test-user', { name: '待删除' });
    const deleted = service.deleteTemplate('test-user', tpl.id);
    expect(deleted).toBe(true);

    const got = service.getTemplate('test-user', tpl.id);
    expect(got).toBeNull();
  });

  it('should delete and re-seed a system template', () => {
    const deleted = service.deleteTemplate('test-user', 'sales_report');
    expect(deleted).toBe(true);
    // Re-seed to restore for other tests
    service.onModuleInit();
    const restored = service.getTemplate('test-user', 'sales_report');
    expect(restored).toBeTruthy();
  });

  it('should resolve template variables', () => {
    const tpl = service.getTemplate('test-user', 'sales_report')!;
    const resolved = service.resolveTemplate(tpl, {
      title: 'Q2报告',
      company_name: '测试公司',
      report_date: '2026-06-19',
      date_range: '2026-04-01 ~ 2026-06-30',
    });

    expect(resolved.sections[0].text).toBe('Q2报告');
    // Header should have variables resolved
    if (resolved.header?.left) {
      expect(resolved.header.left).toBe('测试公司');
    }
  });
});
