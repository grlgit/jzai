import { Controller, Get, Post, Put, Param, Body, Query, Res, Headers, NotFoundException } from '@nestjs/common';
import type { Response } from 'express';
import { ExcelExportService } from './excel-export.service';
import { UserService } from '../../user/user.service';
import { FileCleanupService } from '../../workspace/file-cleanup.service';
import * as fs from 'fs';

@Controller('api/exports')
export class ExportController {
  constructor(
    private readonly excelService: ExcelExportService,
    private readonly userService: UserService,
    private readonly fileCleanup: FileCleanupService,
  ) {}

  private requireUser(auth: string, queryToken?: string) {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : queryToken || '';
    if (!token) throw new NotFoundException('未认证');
    const user = this.userService.verifyToken(token);
    if (!user) throw new NotFoundException('未认证');
    return user;
  }

  /** List user's export files */
  @Get()
  listFiles(@Headers('authorization') auth: string) {
    const user = this.requireUser(auth);
    return this.excelService.listFiles(user.id);
  }

  /** Read Excel as JSON for Univer frontend */
  @Get(':fileId/json')
  async readAsJson(@Headers('authorization') auth: string, @Param('fileId') fileId: string) {
    const user = this.requireUser(auth);
    const data = await this.excelService.readExcelAsJson(user.id, fileId);
    if (!data) throw new NotFoundException('文件不存在');
    return data;
  }

  /** Save Univer JSON back to xlsx */
  @Put(':fileId')
  async saveFromJson(@Headers('authorization') auth: string, @Param('fileId') fileId: string, @Body() body: { sheets: any[] }) {
    const user = this.requireUser(auth);
    const ok = await this.excelService.saveJsonToExcel(user.id, fileId, body);
    if (!ok) throw new NotFoundException('文件不存在');
    return { success: true };
  }

  /** Update specific cells (AI tool uses this) */
  @Post(':fileId/cells')
  async updateCells(@Headers('authorization') auth: string, @Param('fileId') fileId: string, @Body() body: { updates: any[]; addColumn?: any }) {
    const user = this.requireUser(auth);
    const result = await this.excelService.updateCells(user.id, fileId, body.updates || [], body.addColumn);
    return result;
  }

  /** Download xlsx file */
  @Get(':fileId/download')
  async download(@Headers('authorization') auth: string, @Query('token') queryToken: string, @Param('fileId') fileId: string, @Res() res: Response) {
    const user = this.requireUser(auth, queryToken);
    const filePath = this.fileCleanup.resolveExportPath(user.id, fileId);
    if (!filePath || !fs.existsSync(filePath)) throw new NotFoundException('文件不存在或已过期');

    const displayName = fileId.replace(/^\d+_[a-z0-9]+_/, '');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(displayName)}`);
    fs.createReadStream(filePath).pipe(res);
  }

  /** Delete export file */
  @Post(':fileId/delete')
  async deleteFile(@Headers('authorization') auth: string, @Param('fileId') fileId: string) {
    const user = this.requireUser(auth);
    this.fileCleanup.deleteExportFile(user.id, fileId);
    return { success: true };
  }
}
