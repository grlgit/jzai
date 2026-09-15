import { Controller, Get, Post, Put, Delete, Body, Param, Query, Headers, UseInterceptors, UploadedFile, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { UserService } from '../../user/user.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkillRegistryService } from './skill-registry.service';
import { SkillDiscoveryService } from './skill-discovery.service';
import { SkillExecutorService } from './skill-executor.service';
import { SkillGeneratorService } from './skill-generator.service';
import { CredentialService } from './credential.service';
import { AppCapabilityService } from '../../platform/app-store/services/app-capability.service';

@Controller('api/skills')
export class SkillController {
  constructor(
    private readonly registry: SkillRegistryService,
    private readonly discovery: SkillDiscoveryService,
    private readonly executor: SkillExecutorService,
    private readonly generator: SkillGeneratorService,
    private readonly credentials: CredentialService,
    private readonly userService: UserService,
    private readonly appCapabilities: AppCapabilityService,
  ) {}

  @Get()
  async listSkills() {
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('skill');
    return this.registry.getAll().map(s => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      allowedTools: s.allowedTools,
      hasHandler: s.hasHandler,
      hasReferences: s.hasReferences,
      hasAssets: s.hasAssets,
      sourceApp: sourceMap?.get(s.name) ?? null,
    }));
  }

  // ===== Recycle Bin (before :name to avoid param capture) =====

  @Get('deleted')
  listDeleted() {
    return this.registry.listDeleted();
  }

  @Post('deleted/:dirName/restore')
  restore(@Param('dirName') dirName: string) {
    return this.registry.restore(dirName);
  }

  @Delete('deleted/:dirName')
  purge(@Param('dirName') dirName: string) {
    return this.registry.purge(dirName);
  }

  // ===== CRUD =====

  @Get(':name')
  getSkill(@Param('name') name: string) {
    const skill = this.registry.get(name);
    if (!skill) return { error: 'Skill not found' };
    return {
      ...skill,
      rawSkillMd: this.registry.getRawSkillMd(name),
      handlerCode: this.registry.getHandlerCode(name),
      references: this.registry.getReferences(name),
      scripts: this.registry.getScripts(name),
      assets: this.registry.getAssets(name),
    };
  }

  @Get(':name/instructions')
  getInstructions(@Param('name') name: string) {
    const instructions = this.registry.getInstructions(name);
    return instructions !== null ? { instructions } : { error: 'Not found' };
  }

  @Get(':name/references')
  listReferences(@Param('name') name: string) {
    return { files: this.registry.getReferences(name) };
  }

  @Get(':name/references/:file')
  getReferenceContent(@Param('name') name: string, @Param('file') file: string) {
    const content = this.registry.getReferenceContent(name, file);
    return content !== null ? { content } : { error: 'Not found' };
  }

  @Get(':name/scripts')
  listScripts(@Param('name') name: string) {
    return { files: this.registry.getScripts(name) };
  }

  @Get(':name/scripts/:file')
  getScriptContent(@Param('name') name: string, @Param('file') file: string) {
    const content = this.registry.getScriptContent(name, file);
    return content !== null ? { content } : { error: 'Not found' };
  }

  @Get(':name/assets')
  listAssets(@Param('name') name: string) {
    return { files: this.registry.getAssets(name) };
  }

  // ===== Save file content =====

  @Put(':name/instructions')
  saveInstructions(@Param('name') name: string, @Body() body: { content: string }) {
    return this.registry.saveFileContent(name, 'SKILL.md', body.content, 'instructions');
  }

  @Put(':name/skillmd')
  saveSkillMd(@Param('name') name: string, @Body() body: { content: string }) {
    return this.registry.saveFileContent(name, 'SKILL.md', body.content, 'full');
  }

  @Post(':name/upload/:dir')
  @UseInterceptors(FileInterceptor('file'))
  uploadFile(@Param('name') name: string, @Param('dir') dir: string, @UploadedFile() file: Express.Multer.File) {
    if (!file) return { error: '未收到文件' };
    if (!['references', 'assets', 'scripts'].includes(dir)) return { error: '不支持的目录' };
    return this.registry.saveFileContent(name, `${dir}/${file.originalname}`, file.buffer.toString('utf-8'));
  }

  @Put(':name/scripts/:file')
  saveScript(@Param('name') name: string, @Param('file') file: string, @Body() body: { content: string }) {
    return this.registry.saveFileContent(name, `scripts/${file}`, body.content);
  }

  @Put(':name/references/:file')
  saveReference(@Param('name') name: string, @Param('file') file: string, @Body() body: { content: string }) {
    return this.registry.saveFileContent(name, `references/${file}`, body.content);
  }

  @Put(':name/assets/:file')
  saveAsset(@Param('name') name: string, @Param('file') file: string, @Body() body: { content: string }) {
    return this.registry.saveFileContent(name, `assets/${file}`, body.content);
  }

  @Delete(':name/files/:dir/:file')
  deleteFile(@Param('name') name: string, @Param('dir') dir: string, @Param('file') file: string) {
    return this.registry.deleteFile(name, dir, file);
  }

  @Post('discover')
  async discover(@Body() body: {
    systemUrl: string;
    systemName: string;
    loginUrl?: string;
    credentials?: { username: string; password: string };
    navigationSteps: string[];
    skillName: string;
  }) {
    const result = await this.discovery.discover(body);
    return {
      success: true,
      skill: this.registry.get(body.skillName),
      fieldsFound: result.formFields.length,
      apisFound: result.businessApis.length,
      hasLoginApi: !!result.loginApi,
      screenshots: result.screenshots.length,
    };
  }

  @Post('generate')
  @UseInterceptors(FileInterceptor('harFile'))
  async generateFromHar(
    @UploadedFile() harFile: any,
    @Body() body: {
      description: string;
      skillName: string;
      systemName: string;
      credentials?: string;
    },
  ) {
    if (!harFile) return { success: false, message: 'HAR 文件不能为空' };
    try {
      const credentials = body.credentials ? JSON.parse(body.credentials) : undefined;
      return this.generator.generateFromHar({
        harFile: harFile.buffer,
        description: body.description,
        skillName: body.skillName,
        systemName: body.systemName,
        credentials,
      });
    } catch (err: any) {
      return { success: false, message: err.message || '生成失败' };
    }
  }

  @Put(':name')
  updateSkill(@Param('name') name: string, @Body() body: { skill: any; handlerCode?: string }) {
    const existing = this.registry.get(name);
    if (!existing) return { error: 'Skill not found' };

    try {
      const updated = { ...existing, ...body.skill, dirName: existing.dirName };
      this.registry.save(updated, body.handlerCode);
      return { success: true };
    } catch (err: any) {
      return { error: err.message || '保存失败' };
    }
  }

  @Delete(':name')
  deleteSkill(@Param('name') name: string) {
    return { success: this.registry.delete(name) };
  }

  @Post(':name/test')
  async testSkill(@Param('name') name: string) {
    return this.executor.test(name);
  }

  @Post(':name/execute')
  async executeSkill(@Param('name') name: string, @Body() params: Record<string, any>) {
    return this.executor.execute(name, params);
  }

  @Post('reload')
  reloadAll() {
    this.registry.loadAll();
    return { success: true, count: this.registry.getAll().length };
  }

  // ===== Credentials =====

  @Get('credentials/list')
  listCredentials(@Query('userId') userId: string) {
    if (!userId) return { error: 'userId required' };
    return this.credentials.listUserSystems(userId);
  }

  @Post('credentials/save')
  saveCredentials(@Body() body: { userId: string; systemName: string; credentials: Record<string, string> }) {
    this.credentials.saveUserCredentials(body.userId, body.systemName, body.credentials);
    return { success: true };
  }

  @Delete('credentials/:systemName')
  deleteCredentials(@Param('systemName') systemName: string, @Query('userId') userId: string) {
    if (!userId) return { error: 'userId required' };
    this.credentials.deleteUserCredentials(userId, systemName);
    return { success: true };
  }

  // ===== Global Credentials (admin only) =====

  @Get('credentials/global/list')
  listGlobalCredentials(@Headers('authorization') auth: string) {
    this.requireAdmin(auth);
    return this.credentials.listGlobalSystems();
  }

  @Post('credentials/global/save')
  saveGlobalCredentials(@Headers('authorization') auth: string, @Body() body: { systemName: string; credentials: Record<string, string> }) {
    this.requireAdmin(auth);
    this.credentials.saveGlobalCredentials(body.systemName, body.credentials);
    return { success: true };
  }

  @Delete('credentials/global/:systemName')
  deleteGlobalCredentials(@Headers('authorization') auth: string, @Param('systemName') systemName: string) {
    this.requireAdmin(auth);
    this.credentials.deleteGlobalCredentials(systemName);
    return { success: true };
  }

  private requireAdmin(auth: string) {
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) throw new UnauthorizedException();
    if (!this.userService.hasPermission(token, 'sys:admin')) throw new ForbiddenException('需要管理员权限');
  }
}
