import { Controller, Get, Post, Param, Query, Body, Res, Headers, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { PdfExportService } from '../pdf/pdf-export.service';
import { UserService } from '../../user/user.service';
import * as fs from 'fs';

@Controller('api/pdf-exports')
export class PdfExportController {
  constructor(
    private readonly pdfService: PdfExportService,
    private readonly userService: UserService,
  ) {}

  private requireUser(auth: string, queryToken?: string) {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : queryToken || '';
    if (!token) throw new NotFoundException('未认证');
    const user = this.userService.verifyToken(token);
    if (!user) throw new NotFoundException('未认证');
    return user;
  }

  /** List user's PDF files */
  @Get()
  listFiles(@Headers('authorization') auth: string) {
    const user = this.requireUser(auth);
    return this.pdfService.listFiles(user.id);
  }

  /** View PDF in browser (inline) */
  @Get(':fileId/view')
  view(@Headers('authorization') auth: string, @Query('token') queryToken: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const user = this.requireUser(auth, queryToken);
    const filePath = this.pdfService.getFilePath(user.id, fileId);
    if (!filePath) throw new NotFoundException('文件不存在');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(filePath).pipe(res);
  }

  /** Download PDF file */
  @Get(':fileId/download')
  download(@Headers('authorization') auth: string, @Query('token') queryToken: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const user = this.requireUser(auth, queryToken);
    const filePath = this.pdfService.getFilePath(user.id, fileId);
    if (!filePath) throw new NotFoundException('文件不存在');

    const displayName = fileId.replace(/^\d+_[a-z0-9]+_/, '');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(displayName)}`);
    fs.createReadStream(filePath).pipe(res);
  }

  /** Preview: generate a temporary PDF and stream it (not saved) */
  @Post('preview')
  async preview(@Headers('authorization') auth: string, @Body() spec: any, @Res() res: Response) {
    const user = this.requireUser(auth);
    const result = await this.pdfService.generatePdf(user.id, { ...spec, filename: spec.filename || '预览.pdf' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    fs.createReadStream(result.filePath).pipe(res);
    // Clean up preview file after streaming
    res.on('finish', () => {
      this.pdfService.deleteFile(user.id, result.fileId);
    });
  }

  /** Delete PDF file */
  @Post(':fileId/delete')
  deleteFile(@Headers('authorization') auth: string, @Param('fileId') fileId: string) {
    const user = this.requireUser(auth);
    this.pdfService.deleteFile(user.id, fileId);
    return { success: true };
  }
}
