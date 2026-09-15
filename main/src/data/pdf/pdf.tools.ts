import { Injectable } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { PdfExportService } from './pdf-export.service';
import { PdfTemplateService } from './pdf-template.service';
import { PdfWatermarkRemovalService } from './pdf-watermark-removal.service';
import * as fs from 'fs';
import * as path from 'path';

@Injectable()
export class PdfToolProvider implements ToolProvider {
  readonly toolIds = ['generate_pdf', 'update_pdf', 'list_pdf_templates', 'get_pdf_structure', 'pdf_draw_bubbles', 'pdf_remove_watermark'];

  constructor(
    private readonly pdfService: PdfExportService,
    private readonly templateService: PdfTemplateService,
    private readonly watermarkRemoval: PdfWatermarkRemovalService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'generate_pdf', label: 'PDF生成', group: '数据' },
      { id: 'update_pdf', label: '编辑PDF', group: '数据' },
      { id: 'list_pdf_templates', label: 'PDF模板列表', group: '数据' },
      { id: 'get_pdf_structure', label: 'PDF结构查询', group: '数据' },
      { id: 'pdf_draw_bubbles', label: 'PDF气泡标注', group: '工程图纸' },
      { id: 'pdf_remove_watermark', label: 'PDF去水印', group: '工程图纸' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    const tools: ToolInstance[] = [];

    // generate_pdf
    tools.push({
      name: 'generate_pdf',
      label: 'PDF生成',
      description: `生成 PDF 文档。支持两种模式：

## 模式一：模板模式
先调用 list_pdf_templates 获取可用模板，然后传入 template（模板ID）和 template_vars（变量）。
\`\`\`json
{
  "filename": "2026年Q2销售报告.pdf",
  "template": "sales_report",
  "template_vars": {
    "title": "2026年Q2销售报告",
    "company_name": "XX公司",
    "report_date": "2026-06-19",
    "date_range": "2026-04-01 ~ 2026-06-30",
    "total_sales": "¥1,234,567",
    "trend_sql": "SELECT month, SUM(amount) as total FROM orders GROUP BY month",
    "detail_sql": "SELECT * FROM orders WHERE date >= '2026-04-01' LIMIT 100",
    "mcp_name": "db-ERP"
  }
}
\`\`\`

## 模式二：自由模式
直接传入 sections 数组组装文档：
\`\`\`json
{
  "filename": "自定义报告.pdf",
  "title": "报告标题",
  "sections": [
    { "type": "heading", "level": 1, "text": "标题" },
    { "type": "paragraph", "text": "正文内容" },
    { "type": "table", "data_source": "SELECT ...", "mcp": "db-name" },
    { "type": "chart", "chartType": "bar", "data_source": "SELECT ...", "mcp": "db-name", "title": "图表标题" },
    { "type": "key_values", "title": "关键指标", "items": [{"label": "总数", "value": "100"}], "layout": "grid" },
    { "type": "page_break" }
  ],
  "header": { "left": "公司名", "right": "日期" },
  "footer": { "center": "第 {{page}} 页 / 共 {{pages}} 页" }
}
\`\`\`

## Section 类型
- heading: 标题（level 1/2/3）
- paragraph: 段落文本
- table: 数据表格（data_source 传 SQL + mcp，或直接传 data 数组）
- chart: 图表（chartType: bar/line/pie/area/stacked_bar，data_source 传 SQL + mcp）
- key_values: 指标卡（items 数组，layout: grid/list）
- image: 图片（base64 编码）
- page_break: 分页符

## 数据获取
table 和 chart 的 data_source 传 SQL 语句，mcp 传 MCP 名称（如 "db-MOM-dev"），后端自动执行查询。
也可以直接传 data 数组（已经获取好的数据）。`,
      parameters: Type.Object({
        filename: Type.String({ description: '文件名，如"销售报告.pdf"' }),
        template: Type.Optional(Type.String({ description: '模板ID（从 list_pdf_templates 获取）' })),
        template_vars: Type.Optional(Type.Any({ description: '模板变量，键值对' })),
        title: Type.Optional(Type.String({ description: '文档标题（自由模式）' })),
        sections: Type.Optional(Type.Array(Type.Any({ description: 'PDF内容区块数组（自由模式）' }))),
        page: Type.Optional(Type.Any({ description: '页面设置 {size, orientation, margins}' })),
        header: Type.Optional(Type.Any({ description: '页眉 {left, right}' })),
        footer: Type.Optional(Type.Any({ description: '页脚 {center, right}' })),
      }),
      execute: async (_id: string, args: any) => {
        const userId = ctx?.userId || '';
        try {
          let spec: any;

          if (args.template) {
            // Template mode
            const template = this.templateService.getTemplate(userId, args.template);
            if (!template) {
              return { content: [{ type: 'text' as const, text: `模板 "${args.template}" 不存在。请先调用 list_pdf_templates 查看可用模板。` }] };
            }
            spec = this.templateService.resolveTemplate(template, args.template_vars || {});
            spec.filename = args.filename;
          } else {
            // Free mode
            spec = {
              filename: args.filename,
              title: args.title,
              sections: args.sections || [],
              page: args.page,
              header: args.header,
              footer: args.footer,
            };
          }

          const result = await this.pdfService.generatePdf(userId, spec);
          const viewUrl = `/api/pdf-exports/${result.fileId}/view`;
          const downloadUrl = `/api/pdf-exports/${result.fileId}/download`;

          return {
            content: [{ type: 'text' as const, text: `PDF 已生成：**${args.filename}**\n\n- [📄 在线预览](${viewUrl})\n- [📥 下载](${downloadUrl})\n\n文件ID: \`${result.fileId}\`（用于 update_pdf 编辑此文件）\n\n可在"数据仪表 → PDF文档"标签中查看和打印。` }],
            details: {
              fileId: result.fileId, viewUrl, downloadUrl,
              __action: true, actionType: 'ui_hook',
              actionData: { panel: 'dashboard', hook: 'show-pdf', params: { fileId: result.fileId, fileName: args.filename } },
            },
          };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `PDF 生成失败: ${err.message}` }] };
        }
      },
    });

    // update_pdf
    tools.push({
      name: 'update_pdf',
      label: '编辑PDF',
      description: `编辑已生成的 PDF 文档。基于文档结构修改内容后重新渲染。

## 修改内容
updates 数组，每项可以：
- 修改某个区块的字段: { "sectionIndex": 0, "field": "text", "value": "新标题" }
- 替换整个区块: { "sectionIndex": 2, "replace": { "type": "paragraph", "text": "新内容" } }
- 修改页眉/页脚: { "header": { "left": "新公司名" } }
- 添加区块: { "addSection": { "type": "paragraph", "text": "追加内容" }, "insertAt": 3 }
- 删除区块: { "removeSection": 2 }

## 示例
用户说"把标题改为Q3报告"：
\`\`\`json
{ "file_id": "xxx", "updates": [{ "sectionIndex": 0, "field": "text", "value": "Q3报告" }] }
\`\`\``,
      parameters: Type.Object({
        file_id: Type.String({ description: '文件ID（从 generate_pdf 返回的 fileId）' }),
        updates: Type.Array(Type.Any({ description: '修改操作数组' })),
      }),
      execute: async (_id: string, args: any) => {
        const userId = ctx?.userId || '';
        try {
          const result = await this.pdfService.updatePdf(userId, args.file_id, args.updates || []);
          return {
            content: [{ type: 'text' as const, text: `PDF 已更新（${result.updated} 项修改）。请刷新预览查看最新版本。` }],
            details: {
              ...result,
              __action: true, actionType: 'ui_hook',
              actionData: { panel: 'dashboard', hook: 'refresh-pdf', params: { fileId: args.file_id } },
            },
          };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `PDF 编辑失败: ${err.message}` }] };
        }
      },
    });

    // list_pdf_templates
    tools.push({
      name: 'list_pdf_templates',
      label: 'PDF模板列表',
      description: '列出所有可用的 PDF 模板（系统模板 + 用户自定义模板）。用于 generate_pdf 的模板模式。',
      parameters: Type.Object({}),
      execute: async (_id: string) => {
        const userId = ctx?.userId || '';
        const templates = this.templateService.listTemplates(userId);
        const list = templates.map(t => ({
          id: t.id,
          name: t.name,
          description: t.description,
          icon: t.icon,
          isSystem: t.isSystem,
          sectionCount: t.sections.length,
        }));
        return {
          content: [{ type: 'text' as const, text: `共 ${list.length} 个模板：\n\n${list.map(t => `- ${t.icon} **${t.name}** (\`${t.id}\`) — ${t.description}${t.isSystem ? ' [系统]' : ''}`).join('\n')}` }],
        };
      },
    });

    // get_pdf_structure
    tools.push({
      name: 'get_pdf_structure',
      label: 'PDF结构查询',
      description: `查询已生成 PDF 文件的内容结构（区块列表及索引），用于 update_pdf 编辑前了解文档布局。
返回每个 section 的 index、type 和内容摘要。也可不传 file_id，返回用户最近的 PDF 文件列表。`,
      parameters: Type.Object({
        file_id: Type.Optional(Type.String({ description: '文件ID。不传则返回最近文件列表。' })),
      }),
      execute: async (_id: string, args: any) => {
        const userId = ctx?.userId || '';
        if (!args?.file_id) {
          // List recent files
          const files = this.pdfService.listFiles(userId);
          if (files.length === 0) return { content: [{ type: 'text' as const, text: '当前没有已生成的 PDF 文件。' }] };
          return { content: [{ type: 'text' as const, text: `最近的 PDF 文件：\n\n${files.slice(0, 10).map(f => `- \`${f.fileId}\` — ${f.filename} (${(f.size / 1024).toFixed(0)}KB)`).join('\n')}` }] };
        }
        const structure = this.pdfService.getStructure(userId, args.file_id);
        if (!structure) return { content: [{ type: 'text' as const, text: `文件 "${args.file_id}" 的结构信息不存在。` }] };
        const lines = structure.sections.map(s => `  [${s.index}] ${s.type}: ${s.summary}`);
        return {
          content: [{ type: 'text' as const, text: `**${structure.filename}** 的文档结构（${structure.sections.length} 个区块）：\n\n${lines.join('\n')}` }],
        };
      },
    });

    // pdf_draw_bubbles - Draw numbered bubbles on PDF
    tools.push({
      name: 'pdf_draw_bubbles',
      label: 'PDF气泡标注',
      description: `在PDF图纸上绘制序号气泡（用于机械图纸尺寸标注）。直接在原PDF上绘制，不丢失原有内容。

参数说明：
- filePath: 源PDF文件路径
- bubbles: 气泡数组，每项包含 {x, y, number}，x/y为气泡中心坐标，number为序号
- outputPath: 输出路径（可选，默认在原文件名后加_annotated）
- radius: 气泡半径（可选，默认20）

返回：输出文件路径`,
      parameters: Type.Object({
        filePath: Type.String({ description: '源PDF文件路径' }),
        bubbles: Type.Array(Type.Object({
          x: Type.Number({ description: '气泡中心X坐标' }),
          y: Type.Number({ description: '气泡中心Y坐标' }),
          number: Type.Number({ description: '气泡序号' }),
        }), { description: '气泡位置和序号数组' }),
        outputPath: Type.Optional(Type.String({ description: '输出路径（留空则自动生成）' })),
        radius: Type.Optional(Type.Number({ description: '气泡半径，默认20' })),
      }),
      execute: async (_id: string, args: { filePath: string; bubbles: Array<{x: number; y: number; number: string | number}>; outputPath?: string; radius?: number }) => {
        try {
          const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

          if (!fs.existsSync(args.filePath)) {
            return { content: [{ type: 'text' as const, text: `文件不存在: ${args.filePath}` }], details: null };
          }

          // Load PDF
          const pdfBytes = fs.readFileSync(args.filePath);
          const pdfDoc = await PDFDocument.load(pdfBytes);
          const pages = pdfDoc.getPages();

          if (pages.length === 0) {
            return { content: [{ type: 'text' as const, text: 'PDF没有页面' }], details: null };
          }

          // Embed font for numbers (Helvetica - 常规字体，不加粗)
          const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

          const radius = args.radius || 20;
          const results: string[] = [];

          // Draw bubbles on first page
          const page = pages[0];
          const { width, height } = page.getSize();

          // Draw each bubble
          for (const bubble of args.bubbles) {
            const bx = bubble.x;
            const by = bubble.y;
            const num = String(bubble.number);

            // Draw circle (white fill with red border)
            page.drawEllipse({
              x: bx - radius,
              y: by - radius,
              xScale: radius * 2,
              yScale: radius * 2,
              color: rgb(1, 1, 1), // white fill
              borderColor: rgb(0.91, 0.296, 0.235), // red border (#e74c3c)
              borderWidth: 1,
            });

            // Draw number (centered in bubble)
            const fontSize = 11; // 字号改为11号
            const textWidth = font.widthOfTextAtSize(num, fontSize);
            // 调整位置使序号居中：x向左偏移，y向下偏移
            page.drawText(num, {
              x: bx - textWidth / 2 - 3,  // 向左偏移3px使序号水平居中
              y: by - fontSize / 2 - 1,   // 向下偏移使序号垂直居中
              size: fontSize,
              font,
              color: rgb(0.91, 0.296, 0.235),
            });

            results.push(`气泡 #${num} 在 (${Math.round(bx)}, ${Math.round(by)})`);
          }

          // Save
          const outputBytes = await pdfDoc.save();

          // Determine output path
          let outPath = args.outputPath;
          if (!outPath) {
            const ext = path.extname(args.filePath);
            const base = args.filePath.slice(0, -ext.length);
            outPath = `${base}_annotated${ext}`;
          }

          // Ensure output directory exists
          const outDir = path.dirname(outPath);
          if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
          }

          fs.writeFileSync(outPath, outputBytes);

          return {
            content: [{ type: 'text' as const, text: `PDF气泡标注完成\n\n${results.join('\n')}\n\n输出: ${outPath}` }],
            details: { outputPath: outPath, bubbleCount: args.bubbles.length },
          };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `PDF气泡标注失败: ${err.message}\n\n${err.stack}` }], details: null };
        }
      },
    });

    // pdf_remove_watermark
    tools.push({
      name: 'pdf_remove_watermark',
      label: 'PDF去水印',
      description: `检测并删除PDF中的水印，支持多种水印类型。

## 支持的水印类型
- **Annotation注释**: 文本/图像注释型水印
- **OCG图层**: 可选内容组图层水印
- **XObject嵌入**: 嵌入的图像/表单对象

## 参数说明
- filePath: PDF文件路径（必填）
- detectOnly: 仅检测不删除（默认false）
- removeAnnotations: 删除注释水印（默认true）
- removeOcgLayers: 删除图层水印（默认true）
- removeXObjects: 删除XObject水印（默认true）
- outputPath: 输出路径（可选，默认原文件名_cleaned.pdf）

## 返回结果
返回检测到的水印详情和删除结果，包括水印类型、数量、置信度。`,
      parameters: Type.Object({
        filePath: Type.String({ description: 'PDF文件路径' }),
        detectOnly: Type.Optional(Type.Boolean({ description: '仅检测不删除' })),
        removeAnnotations: Type.Optional(Type.Boolean({ description: '删除注释水印' })),
        removeOcgLayers: Type.Optional(Type.Boolean({ description: '删除图层水印' })),
        removeXObjects: Type.Optional(Type.Boolean({ description: '删除XObject水印' })),
        outputPath: Type.Optional(Type.String({ description: '输出路径' })),
      }),
      execute: async (_id: string, args: any) => {
        try {
          const result = await this.watermarkRemoval.removeWatermarks(args.filePath, args);

          const outputLines: string[] = [];

          if (result.detection.hasWatermark) {
            outputLines.push(`**检测到水印**: ${result.detection.watermarkTypes.join(', ')}`);
            outputLines.push(`**水印数量**: ${result.detection.removalCandidates.length} 个候选`);
            if (result.removedCount > 0) {
              outputLines.push(`**已删除**: ${result.removedCount} 个水印项`);
            }
            outputLines.push(`**输出文件**: ${result.outputPath}`);
          } else {
            outputLines.push(`未检测到水印`);
          }

          outputLines.push('');
          outputLines.push(`### 检测详情`);
          for (const detail of result.detection.details) {
            outputLines.push(`- ${detail}`);
          }

          return {
            content: [{ type: 'text' as const, text: outputLines.join('\n') }],
            details: {
              outputPath: result.outputPath,
              detection: result.detection,
              removed: result.removed,
              removedCount: result.removedCount,
            },
          };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `PDF去水印失败: ${err.message}` }] };
        }
      },
    });

    return tools;
  }
}
