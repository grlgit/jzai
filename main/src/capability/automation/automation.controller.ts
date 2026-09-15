import { Controller, Get, Post, Put, Delete, Body, Param, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AutomationService } from './automation.service';
import { SystemRegistryService } from './system-registry.service';
import { Public } from '../../platform/auth/public.decorator';

@Controller('api')
export class AutomationController {
  constructor(
    private readonly automation: AutomationService,
    private readonly registry: SystemRegistryService,
  ) {}

  // ===== Systems =====

  @Get('systems')
  listSystems() {
    return this.registry.getSystems();
  }

  @Post('systems')
  createSystem(@Body() body: any) {
    return this.registry.saveSystem(body);
  }

  @Put('systems/:name')
  updateSystem(@Param('name') name: string, @Body() body: any) {
    return this.registry.saveSystem(body, name);
  }

  @Delete('systems/:name')
  deleteSystem(@Param('name') name: string) {
    return { deleted: this.registry.deleteSystem(name) };
  }

  // ===== Templates =====

  @Get('templates')
  listTemplates() {
    return this.registry.listTemplates();
  }

  @Get('templates/:key')
  getTemplate(@Param('key') key: string) {
    return this.registry.getTemplate(key.replace(/-/g, '/'));
  }

  @Post('templates')
  saveTemplate(@Body() body: { key: string; template: any }) {
    this.registry.saveTemplate(body.key, body.template);
    return { success: true };
  }

  @Delete('templates/:key')
  deleteTemplate(@Param('key') key: string) {
    return { deleted: this.registry.deleteTemplate(key.replace(/-/g, '/')) };
  }

  // ===== Files =====

  @Post('files/upload')
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(@UploadedFile() file: any, @Body('fileName') bodyFileName?: string, @Query('userId') queryUserId?: string, @Req() req?: any) {
    if (!file) return { error: 'No file uploaded' };
    // Prefer fileName from body (sent as plain text, avoids multer latin1 encoding issue with CJK filenames)
    const fileName = bodyFileName || file.originalname;
    // Extract userId from JWT token, fallback to query param
    const userId = queryUserId || req?.user?.id || undefined;
    const filePath = this.automation.saveFile(file.buffer, fileName, userId);
    return { filePath, fileName, size: file.size };
  }

  @Post('files/parse')
  async parseFile(@Body() body: { filePath: string; hint?: string; templateKey?: string }) {
    const parsed = await this.automation.parseFilePath(body.filePath);
    let mappedData = parsed.fields;
    if (body.templateKey) {
      mappedData = this.automation.applyTemplate(body.templateKey, parsed.fields);
    }
    return { ...parsed, rawText: parsed.rawText.substring(0, 2000), mappedData };
  }

  @Public()
  @Get('files/view')
  viewFile(@Query('path') filePath: string, @Req() req: any, @Res() res: any) {
    if (!filePath) return res.status(400).send('Missing file path');

    // 解码URL编码的文件名（特别是中文字符）
    filePath = decodeURIComponent(filePath);

    // 安全检查：只允许特定路径
    const allowedPrefixes = ['/workspace/', '/app/'];
    const isAllowed = allowedPrefixes.some(prefix => filePath.startsWith(prefix));
    if (!isAllowed) {
      return res.status(403).send('Access denied');
    }

    const fs = require('fs');
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('File not found');
    }
    const ext = filePath.split('.').pop()?.toLowerCase() || '';
    const contentTypes: Record<string, string> = {
      pdf: 'application/pdf',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
    };
    res.setHeader('Content-Type', contentTypes[ext] || 'application/octet-stream');
    // 对文件名进行URL编码以支持中文字符
    const fileName = filePath.split('/').pop() || 'download';
    const encodedFileName = encodeURIComponent(fileName);
    res.setHeader('Content-Disposition', `inline; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`);

    // 流式传输文件
    const fileStream = fs.createReadStream(filePath);
    fileStream.on('error', () => {
      if (!res.headersSent) res.status(500).send('File read error');
    });
    fileStream.pipe(res);
  }
}
