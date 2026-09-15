import { PdfToolProvider } from './pdf.tools';
import { PdfExportService } from './pdf-export.service';
import { PdfTemplateService } from './pdf-template.service';
import { PdfWatermarkRemovalService } from './pdf-watermark-removal.service';

describe('PdfToolProvider', () => {
  let provider: PdfToolProvider;
  let mockPdfService: Partial<PdfExportService>;
  let mockTemplateService: Partial<PdfTemplateService>;
  let mockWatermarkRemoval: Partial<PdfWatermarkRemovalService>;

  const allToolIds = [
    'generate_pdf', 'update_pdf', 'list_pdf_templates', 'get_pdf_structure',
    'pdf_draw_bubbles', 'pdf_remove_watermark',
  ];

  beforeAll(() => {
    mockPdfService = {
      generatePdf: jest.fn().mockResolvedValue({
        filePath: '/tmp/test.pdf',
        filename: '测试.pdf',
        fileId: '123_abc_测试.pdf',
      }),
      updatePdf: jest.fn().mockResolvedValue({ success: true, updated: 1 }),
    };

    mockTemplateService = {
      listTemplates: jest.fn().mockReturnValue([
        { id: 'sales_report', name: '销售报告', description: '销售数据', icon: '📊', isSystem: true, sections: [{}, {}] },
        { id: 'tpl_user1', name: '自定义', description: '用户模板', icon: '📄', isSystem: false, sections: [{}] },
      ]),
      getTemplate: jest.fn().mockReturnValue({
        id: 'sales_report',
        name: '销售报告',
        sections: [{ type: 'heading', text: '{{title}}' }],
      }),
      resolveTemplate: jest.fn().mockReturnValue({
        filename: '报告.pdf',
        sections: [{ type: 'heading', text: '已填充' }],
      }),
    };

    mockWatermarkRemoval = {
      removeWatermarks: jest.fn().mockResolvedValue({
        success: true,
        outputPath: '/tmp/cleaned.pdf',
        removed: [],
        removedCount: 0,
        detection: {
          hasWatermark: false,
          watermarkTypes: [],
          annotations: 0,
          ocgLayers: 0,
          xObjects: 0,
          details: [],
          removalCandidates: [],
        },
      }),
    };

    provider = new PdfToolProvider(
      mockPdfService as PdfExportService,
      mockTemplateService as PdfTemplateService,
      mockWatermarkRemoval as PdfWatermarkRemovalService,
    );
  });

  it('should have correct toolIds', () => {
    expect(provider.toolIds).toEqual(allToolIds);
  });

  it('should return catalog entries', () => {
    const catalog = provider.getCatalog();
    expect(catalog).toHaveLength(allToolIds.length);
    expect(catalog.map(c => c.id)).toEqual(allToolIds);
    expect(catalog.filter(c => c.group === '数据')).toHaveLength(4);
  });

  it('should create all tools with piAi.Type', async () => {
    // Minimal Type mock (TypeBox-like)
    const Type = {
      Object: (schema: any) => ({ type: 'object', properties: schema }),
      String: (opts?: any) => ({ type: 'string', ...opts }),
      Optional: (t: any) => ({ ...t, optional: true }),
      Array: (t: any) => ({ type: 'array', items: t }),
      Any: (opts?: any) => ({ type: 'any', ...opts }),
      Number: (opts?: any) => ({ type: 'number', ...opts }),
      Boolean: (opts?: any) => ({ type: 'boolean', ...opts }),
    };

    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    expect(tools).toHaveLength(allToolIds.length);
    expect(tools.map(t => t.name)).toEqual(allToolIds);
  });

  it('should return empty tools without piAi.Type', async () => {
    const tools = await provider.createTools({});
    expect(tools).toHaveLength(0);
  });

  it('should execute generate_pdf in free mode', async () => {
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o, Optional: (t: any) => t,
      Array: (t: any) => t, Any: (o?: any) => o,
      Number: (o?: any) => o, Boolean: (o?: any) => o,
    };
    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    const generateTool = tools.find(t => t.name === 'generate_pdf')!;

    const result = await generateTool.execute('call1', {
      filename: '自由模式.pdf',
      sections: [{ type: 'heading', text: '标题' }],
    });

    expect(result.content[0].text).toContain('PDF 已生成');
    expect(result.details.__action).toBe(true);
    expect(result.details.actionType).toBe('ui_hook');
    expect(result.details.actionData.hook).toBe('show-pdf');
  });

  it('should execute generate_pdf in template mode', async () => {
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o, Optional: (t: any) => t,
      Array: (t: any) => t, Any: (o?: any) => o,
      Number: (o?: any) => o, Boolean: (o?: any) => o,
    };
    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    const generateTool = tools.find(t => t.name === 'generate_pdf')!;

    const result = await generateTool.execute('call2', {
      filename: '模板模式.pdf',
      template: 'sales_report',
      template_vars: { title: 'Q2报告' },
    });

    expect(result.content[0].text).toContain('PDF 已生成');
    expect(mockTemplateService.getTemplate).toHaveBeenCalled();
    expect(mockTemplateService.resolveTemplate).toHaveBeenCalled();
  });

  it('should execute list_pdf_templates', async () => {
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o, Optional: (t: any) => t,
      Array: (t: any) => t, Any: (o?: any) => o,
      Number: (o?: any) => o, Boolean: (o?: any) => o,
    };
    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    const listTool = tools.find(t => t.name === 'list_pdf_templates')!;

    const result = await listTool.execute('call3');
    expect(result.content[0].text).toContain('2 个模板');
    expect(result.content[0].text).toContain('销售报告');
  });

  it('should execute update_pdf', async () => {
    const Type = {
      Object: (s: any) => s, String: (o?: any) => o, Optional: (t: any) => t,
      Array: (t: any) => t, Any: (o?: any) => o,
      Number: (o?: any) => o, Boolean: (o?: any) => o,
    };
    const tools = await provider.createTools({ piAi: { Type }, userId: 'user1' });
    const updateTool = tools.find(t => t.name === 'update_pdf')!;

    const result = await updateTool.execute('call4', {
      file_id: '123_abc_test.pdf',
      updates: [{ sectionIndex: 0, field: 'text', value: '新标题' }],
    });

    expect(result.content[0].text).toContain('已更新');
    expect(result.details.__action).toBe(true);
    expect(result.details.actionData.hook).toBe('refresh-pdf');
  });
});
