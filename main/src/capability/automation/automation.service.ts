import { Injectable, Logger } from '@nestjs/common';
import { SystemRegistryService } from './system-registry.service';
import { FileParserService, ParsedFile } from './file-parser.service';

@Injectable()
export class AutomationService {
  private readonly logger = new Logger(AutomationService.name);

  constructor(
    private readonly registry: SystemRegistryService,
    private readonly fileParser: FileParserService,
  ) {}

  /**
   * Get all registered systems (from YAML)
   */
  getAllSystems() {
    return this.registry.getSystems().map(s => ({
      name: s.name,
      description: s.description,
      baseUrl: s.baseUrl,
      tools: s.tools.map(t => ({ name: t.name, description: t.description })),
    }));
  }

  /**
   * Parse an uploaded file
   */
  async parseFile(fileId: string, hint?: string): Promise<ParsedFile> {
    return this.fileParser.parseFile(fileId, hint);
  }

  /**
   * Parse a file from path (for testing)
   */
  async parseFilePath(filePath: string): Promise<ParsedFile> {
    return this.fileParser.parseFilePath(filePath);
  }

  /**
   * Apply data template to map raw data to system fields
   */
  applyTemplate(templateKey: string, rawData: Record<string, any>) {
    return this.registry.applyTemplate(templateKey, rawData);
  }

  /**
   * Save an uploaded file
   */
  saveFile(buffer: Buffer, originalName: string, userId?: string): string {
    return this.fileParser.saveFile(buffer, originalName, userId);
  }

  /**
   * Get the file parsing tool for the agent
   */
  getParseAttachmentTool() {
    return {
      name: 'parse_attachment',
      description: `解析用户上传的附件文件（PDF/Excel/CSV），提取结构化数据。
当用户上传了文件并要求处理时调用此工具。
支持格式：PDF（订单/发票/合同）、Excel(.xlsx)、CSV`,
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '文件路径' },
          hint: { type: 'string', description: '解析提示，如"这是一个订单"' },
          templateKey: { type: 'string', description: '数据映射模板key，如"erp/create_order"' },
        },
        required: ['filePath'],
      },
      execute: async (_id: string, params: { filePath: string; hint?: string; templateKey?: string }) => {
        try {
          const parsed = await this.fileParser.parseFilePath(params.filePath);

          let mappedData = parsed.fields;
          if (params.templateKey) {
            mappedData = this.registry.applyTemplate(params.templateKey, parsed.fields);
          }

          const fieldsStr = Object.entries(mappedData).length > 0
            ? '\n\n提取的字段:\n' + Object.entries(mappedData).map(([k, v]) => `  ${k}: ${v}`).join('\n')
            : '';
          const summary = `文件: ${parsed.fileName}\n类型: ${parsed.fileType}\n${parsed.summary}${fieldsStr}\n\n文件原文内容:\n${parsed.rawText.substring(0, 3000)}`;

          return {
            content: [{ type: 'text', text: summary }],
            parsedData: mappedData,
            rawFields: parsed.fields,
            rawText: parsed.rawText.substring(0, 3000),
          };
        } catch (err: any) {
          return { content: [{ type: 'text', text: `解析失败: ${err.message}` }] };
        }
      },
    };
  }
}
