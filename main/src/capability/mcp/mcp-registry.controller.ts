import { Controller, Get, Post, Patch, Put, Delete, Param, Body, Req } from '@nestjs/common';
import { McpRegistryService } from './mcp-registry.service';
import { DbService } from '../../db/db.service';
import { CredentialService } from '../skill/credential.service';
import { UserService } from '../../user/user.service';
import * as fs from 'fs';
import * as path from 'path';

@Controller('api/mcp')
export class McpRegistryController {
  constructor(
    private readonly mcp: McpRegistryService,
    private readonly db: DbService,
    private readonly credentialService: CredentialService,
    private readonly userService: UserService,
  ) {}

  @Get()
  list(@Req() req: any) {
    const userId = req.user?.id || this.extractUserId(req);
    const roleIds = [
      req.user?.role?.id,
      ...(Array.isArray(req.user?.roles) ? req.user.roles.map((role: any) => role?.id ?? role) : []),
    ].filter((roleId): roleId is string => typeof roleId === 'string' && roleId.length > 0);
    const permissions = req.user?.permissions ?? req.user?.role?.permissions ?? [];
    const isAdmin = Array.isArray(permissions) && permissions.includes('sys:admin');
    return this.mcp.getAll()
      .filter(m => isAdmin || this.mcp.isAllowedForUser(m.name, userId ?? undefined, roleIds))
      .map(m => {
      const authSystem = m.authSystem || m.system || m.name;
      const basePhase = m.status.phase || 'available';

      // Determine effective phase: building > unconfigured > available
      let phase = basePhase;
      if (basePhase === 'available' && m.authFields && m.authFields.length > 0) {
        const creds = this.credentialService.resolveCredentials(userId || '', authSystem, m.authScope);
        if (!creds || Object.keys(creds).length === 0) phase = 'unconfigured';
      }

      return {
        name: m.name, system: m.system, description: m.description,
        llmHint: m.llmHint || null,
        authSystem, authScope: m.authScope || undefined, authFields: m.authFields || null,
        toolCount: m.tools.length,
        tools: m.tools.map(t => ({ name: t.name, description: t.description || '' })),
        enabled: m.enabled, permissions: m.permissions,
        status: { ...m.status, phase },
      };
    });
  }

  private extractUserId(req: any): string | null {
    const auth = req.headers?.authorization;
    if (!auth?.startsWith('Bearer ')) return null;
    const user = this.userService.verifyToken(auth.slice(7));
    return user?.id || null;
  }

  // ===== Recycle Bin (must be before :name to avoid param capture) =====

  @Get('deleted')
  listDeleted() {
    return this.mcp.listDeleted();
  }

  @Post('deleted/:dirName/restore')
  restore(@Param('dirName') dirName: string) {
    return this.mcp.restore(dirName);
  }

  @Delete('deleted/:dirName')
  purge(@Param('dirName') dirName: string) {
    return this.mcp.purge(dirName);
  }

  // ===== CRUD =====

  @Get(':name')
  getDetail(@Param('name') name: string) {
    const m = this.mcp.get(name);
    return m || { error: 'Not found' };
  }

  @Patch(':name')
  toggle(@Param('name') name: string, @Body() body: { enabled?: boolean }) {
    if (body.enabled === undefined) return { error: 'No update provided' };
    const ok = body.enabled ? this.mcp.enable(name) : this.mcp.disable(name);
    return ok ? { success: true, name, enabled: body.enabled } : { error: 'Not found' };
  }

  @Put(':name/llm-hint')
  setLlmHint(@Param('name') name: string, @Body() body: { llmHint: string }) {
    return this.mcp.setLlmHint(name, body.llmHint) ? { success: true } : { error: 'Not found' };
  }

  @Put(':name/permissions')
  setPermissions(@Param('name') name: string, @Body() perms: { allowedRoles?: string[]; allowedUsers?: string[] }) {
    return this.mcp.setPermissions(name, perms) ? { success: true } : { error: 'Not found' };
  }

  @Get(':name/manifest')
  getManifest(@Param('name') name: string) {
    const yaml = this.mcp.getManifestYaml(name);
    return yaml ? { name, manifest: yaml } : { error: 'Not found' };
  }

  @Get(':name/handler')
  getHandler(@Param('name') name: string) {
    const handler = this.mcp.getHandler(name);
    return handler !== null ? { handler } : { error: 'Not found' };
  }

  @Put(':name/handler')
  saveHandler(@Param('name') name: string, @Body() body: { handler: string }) {
    return this.mcp.saveHandler(name, body.handler) ? { success: true } : { error: 'Not found' };
  }

  @Get(':name/schema-status')
  getSchemaStatus(@Param('name') name: string) {
    const status = this.mcp.getSchemaStatus(name);
    return status || { error: 'Not found' };
  }

  @Get(':name/schema-files')
  getSchemaFiles(@Param('name') name: string) {
    const m = this.mcp.get(name);
    if (!m) return { error: 'Not found' };
    const schemaDir = path.join(this.mcp.getBaseDir(), m.dirName, 'schema');
    if (!fs.existsSync(schemaDir)) return { files: [] };
    // Read index for comments
    const indexPath = path.join(schemaDir, '_index.json');
    let commentMap: Record<string, string> = {};
    if (fs.existsSync(indexPath)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
        for (const t of idx.tables || []) commentMap[t.name] = t.comment || '';
      } catch {}
    }
    const files = fs.readdirSync(schemaDir).filter(f => f.endsWith('.md')).sort();
    return { files: files.map(f => {
      const tableName = f.replace('.md', '');
      return { name: tableName, file: f, comment: commentMap[tableName] || '' };
    }) };
  }

  @Get(':name/schema-files/:file')
  getSchemaFile(@Param('name') name: string, @Param('file') file: string) {
    const m = this.mcp.get(name);
    if (!m) return { error: 'Not found' };
    const filePath = path.join(this.mcp.getBaseDir(), m.dirName, 'schema', file.endsWith('.md') ? file : `${file}.md`);
    if (!fs.existsSync(filePath)) return { error: 'File not found' };
    return { content: fs.readFileSync(filePath, 'utf-8') };
  }

  @Put(':name/schema-files/:file')
  saveSchemaFile(@Param('name') name: string, @Param('file') file: string, @Body() body: { content: string }) {
    const m = this.mcp.get(name);
    if (!m) return { error: 'Not found' };
    const schemaDir = path.join(this.mcp.getBaseDir(), m.dirName, 'schema');
    if (!fs.existsSync(schemaDir)) return { error: 'Schema directory not found' };
    const filePath = path.join(schemaDir, file.endsWith('.md') ? file : `${file}.md`);
    fs.writeFileSync(filePath, body.content, 'utf-8');
    return { success: true };
  }

  @Post(':name/refresh-schema')
  async refreshSchema(@Param('name') name: string) {
    const m = this.mcp.get(name);
    if (!m) return { error: 'Not found' };
    const authSystem = m.authSystem || m.system || m.name;
    const creds = this.credentialService.resolveCredentials('', authSystem, m.authScope);
    if (!creds || Object.keys(creds).length === 0) return { error: '凭证缺失，无法刷新' };
    return this.mcp.refreshSchema(name, creds);
  }

  @Delete(':name')
  async deleteMcp(@Param('name') name: string) {
    const result = this.mcp.delete(name);
    if (!result.success) return { error: 'Not found' };

    // Cascade: remove from CoWorker mcp_servers JSON arrays
    let cleanedCoworkers = 0;
    try {
      const { rows } = await this.db.query(
        `SELECT id, mcp_servers FROM jz_coworkers WHERE mcp_servers::text LIKE $1`,
        [`%${name}%`],
      );
      for (const row of rows) {
        const servers: string[] = typeof row.mcp_servers === 'string' ? JSON.parse(row.mcp_servers) : (row.mcp_servers || []);
        const filtered = servers.filter((s: string) => s !== name);
        if (filtered.length !== servers.length) {
          await this.db.query(
            `UPDATE jz_coworkers SET mcp_servers = $1 WHERE id = $2`,
            [JSON.stringify(filtered), row.id],
          );
          cleanedCoworkers++;
        }
      }
    } catch { /* table may not exist yet */ }

    return { success: true, name, cleanedCoworkers };
  }

  // ===== Registration =====

  @Post('register')
  register(@Body() body: { manifest: string }) {
    if (!body.manifest) return { error: '请提供 manifest YAML 内容' };
    return this.mcp.register(body.manifest);
  }

  @Post('reload')
  reload() {
    this.mcp.loadAll();
    return { mcp: this.mcp.getAll().length };
  }
}
