import { Controller, Get, Post, Put, Delete, Body, Param, Req, Headers, UseInterceptors, UploadedFile, ForbiddenException, UnauthorizedException, NotFoundException } from '@nestjs/common';
import { UserService } from '../../user/user.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkillRegistryService } from './skill-registry.service';
import { SkillDiscoveryService } from './skill-discovery.service';
import { SkillExecutorService } from './skill-executor.service';
import { SkillGeneratorService } from './skill-generator.service';
import { CredentialService } from './credential.service';
import { AppCapabilityService } from '../../platform/app-store/services/app-capability.service';
import { ResourceAccessService } from '../../platform/authz/resource-access.service';
import { RequireAdmin } from '../../platform/authz/require-permission.decorator';
import { createUserPrincipal, InvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';

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
    private readonly access: ResourceAccessService,
  ) {}

  private principalOf(req: any): InvocationPrincipal {
    return createUserPrincipal(req.user, 'http:skills');
  }

  /** P1：写端点统一前置——user 类仅 owner、global 类仅 admin 可编辑（修 V4 技能侧） */
  private async assertSkillEditable(name: string, req: any): Promise<void> {
    if (!this.registry.get(name)) throw new NotFoundException('Skill not found');
    await this.access.assertCanEdit('skill', name, this.principalOf(req));
  }

  @Get()
  async listSkills(@Req() req: any) {
    const sourceMap = (await this.appCapabilities.getSourceMap()).get('skill');
    const skills = await this.registry.getAllForPrincipal(this.principalOf(req));
    return skills.map(s => ({
      name: s.name,
      description: s.description,
      metadata: s.metadata,
      allowedTools: s.allowedTools,
      hasHandler: s.hasHandler,
      hasReferences: s.hasReferences,
      hasAssets: s.hasAssets,
      scope: s.scope, ownerUserId: s.ownerUserId, canEdit: s.canEdit,
      sourceApp: sourceMap?.get(s.name) ?? null,
    }));
  }

  // ===== Recycle Bin (before :name to avoid param capture) =====

  @Get('deleted')
  listDeleted() {
    return this.registry.listDeleted();
  }

  @RequireAdmin()
  @Post('deleted/:dirName/restore')
  restore(@Param('dirName') dirName: string) {
    return this.registry.restore(dirName);
  }

  @RequireAdmin()
  @Delete('deleted/:dirName')
  purge(@Param('dirName') dirName: string) {
    return this.registry.purge(dirName);
  }

  // ===== CRUD =====

  @Get(':name')
  async getSkill(@Param('name') name: string, @Req() req: any) {
    const skill = this.registry.get(name);
    if (!skill) return { error: 'Skill not found' };
    // 权限修复：详情与列表同真值表——未授权按 404 处理（不回显存在性）
    if (!(await this.access.canView('skill', name, this.principalOf(req)))) {
      throw new NotFoundException('Skill not found');
    }
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
  async saveInstructions(@Param('name') name: string, @Body() body: { content: string }, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    return this.registry.saveFileContent(name, 'SKILL.md', body.content, 'instructions');
  }

  @Put(':name/skillmd')
  async saveSkillMd(@Param('name') name: string, @Body() body: { content: string }, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    return this.registry.saveFileContent(name, 'SKILL.md', body.content, 'full');
  }

  @Post(':name/upload/:dir')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(@Param('name') name: string, @Param('dir') dir: string, @UploadedFile() file: Express.Multer.File, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    if (!file) return { error: '未收到文件' };
    if (!['references', 'assets', 'scripts'].includes(dir)) return { error: '不支持的目录' };
    return this.registry.saveFileContent(name, `${dir}/${file.originalname}`, file.buffer.toString('utf-8'));
  }

  @Put(':name/scripts/:file')
  async saveScript(@Param('name') name: string, @Param('file') file: string, @Body() body: { content: string }, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    return this.registry.saveFileContent(name, `scripts/${file}`, body.content);
  }

  @Put(':name/references/:file')
  async saveReference(@Param('name') name: string, @Param('file') file: string, @Body() body: { content: string }, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    return this.registry.saveFileContent(name, `references/${file}`, body.content);
  }

  @Put(':name/assets/:file')
  async saveAsset(@Param('name') name: string, @Param('file') file: string, @Body() body: { content: string }, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    return this.registry.saveFileContent(name, `assets/${file}`, body.content);
  }

  @Delete(':name/files/:dir/:file')
  async deleteFile(@Param('name') name: string, @Param('dir') dir: string, @Param('file') file: string, @Req() req: any) {
    await this.assertSkillEditable(name, req);
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
  }, @Req() req: any) {
    const p = this.principalOf(req);
    body.skillName = this.registry.allocateSkillName(body.skillName, p);
    const result = await this.discovery.discover(body, p);
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
    @Req() req: any,
  ) {
    if (!harFile) return { success: false, message: 'HAR 文件不能为空' };
    try {
      const credentials = body.credentials ? JSON.parse(body.credentials) : undefined;
      const p = this.principalOf(req);
      return this.generator.generateFromHar({
        harFile: harFile.buffer,
        description: body.description,
        skillName: this.registry.allocateSkillName(body.skillName, p),
        systemName: body.systemName,
        credentials,
      }, p);
    } catch (err: any) {
      return { success: false, message: err.message || '生成失败' };
    }
  }

  @Put(':name')
  async updateSkill(@Param('name') name: string, @Body() body: { skill: any; handlerCode?: string }, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    const existing = this.registry.get(name)!;

    try {
      const updated = { ...existing, ...body.skill, name: existing.name, dirName: existing.dirName };
      await this.registry.save(updated, body.handlerCode);
      return { success: true };
    } catch (err: any) {
      return { error: err.message || '保存失败' };
    }
  }

  @Delete(':name')
  async deleteSkill(@Param('name') name: string, @Req() req: any) {
    await this.assertSkillEditable(name, req);
    return { success: await this.registry.delete(name) };
  }

  @Post(':name/test')
  async testSkill(@Param('name') name: string, @Req() req: any) {
    if (!(await this.access.canView('skill', name, this.principalOf(req)))) {
      throw new ForbiddenException('无权使用该技能');
    }
    return this.executor.test(name);
  }

  @Post(':name/execute')
  async executeSkill(@Param('name') name: string, @Body() params: Record<string, any>, @Req() req: any) {
    if (!(await this.access.canView('skill', name, this.principalOf(req)))) {
      throw new ForbiddenException('无权使用该技能');
    }
    return this.executor.execute(name, params);
  }

  @Post('reload')
  reloadAll() {
    this.registry.loadAll();
    return { success: true, count: this.registry.getAll().length };
  }

  // ===== Credentials =====

  @Get('credentials/list')
  listCredentials(@Req() req: any) {
    // P1 安全修复（V5）：凭证归属一律取登录身份，忽略入参 userId
    return this.credentials.listUserSystems(req.user.id);
  }

  @Post('credentials/save')
  saveCredentials(@Body() body: { userId?: string; systemName: string; credentials: Record<string, string> }, @Req() req: any) {
    // P1 安全修复（V5）：忽略 body.userId，凭证写入登录用户名下
    this.credentials.saveUserCredentials(req.user.id, body.systemName, body.credentials);
    return { success: true };
  }

  @Delete('credentials/:systemName')
  deleteCredentials(@Param('systemName') systemName: string, @Req() req: any) {
    // P1 安全修复（V5）：只能删自己的凭证
    this.credentials.deleteUserCredentials(req.user.id, systemName);
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
