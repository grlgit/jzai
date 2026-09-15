import { Controller, Get, Post, Put, Delete, Param, Body, Headers, NotFoundException } from '@nestjs/common';
import { PdfTemplateService } from './pdf-template.service';
import { UserService } from '../../user/user.service';

@Controller('api/pdf-templates')
export class PdfTemplateController {
  constructor(
    private readonly templateService: PdfTemplateService,
    private readonly userService: UserService,
  ) {}

  private requireUser(auth: string) {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw new NotFoundException('未认证');
    const user = this.userService.verifyToken(token);
    if (!user) throw new NotFoundException('未认证');
    return user;
  }

  @Get()
  list(@Headers('authorization') auth: string) {
    const user = this.requireUser(auth);
    return this.templateService.listTemplates(user.id);
  }

  @Get(':id')
  getOne(@Headers('authorization') auth: string, @Param('id') id: string) {
    const user = this.requireUser(auth);
    const tpl = this.templateService.getTemplate(user.id, id);
    if (!tpl) throw new NotFoundException('模板不存在');
    return tpl;
  }

  @Post()
  create(@Headers('authorization') auth: string, @Body() body: any) {
    const user = this.requireUser(auth);
    return this.templateService.createTemplate(user.id, body);
  }

  @Put(':id')
  update(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any) {
    const user = this.requireUser(auth);
    const tpl = this.templateService.getTemplate(user.id, id);
    if (!tpl) throw new NotFoundException('模板不存在');
    return this.templateService.updateTemplate(user.id, id, body);
  }

  @Delete(':id')
  remove(@Headers('authorization') auth: string, @Param('id') id: string) {
    const user = this.requireUser(auth);
    const tpl = this.templateService.getTemplate(user.id, id);
    if (!tpl) throw new NotFoundException('模板不存在');
    this.templateService.deleteTemplate(user.id, id);
    return { success: true };
  }

  @Post(':id/duplicate')
  duplicate(@Headers('authorization') auth: string, @Param('id') id: string) {
    const user = this.requireUser(auth);
    const result = this.templateService.duplicateTemplate(user.id, id);
    if (!result) throw new NotFoundException('模板不存在');
    return result;
  }
}
