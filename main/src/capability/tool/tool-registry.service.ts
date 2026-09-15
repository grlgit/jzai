import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WorkspaceService } from '../../workspace/workspace.service';

export interface ToolParameter {
  name: string;
  type: string;
  required?: boolean;
  description: string;
  label?: string;
}

export interface ConnectorPermissions {
  allowedRoles?: string[];  // e.g. ['admin', 'member']
  allowedUsers?: string[];  // specific user IDs
}

export interface ConnectorStatus {
  loaded: boolean;
  lastUsed?: string;
  error?: string;
  phase?: 'building' | 'unconfigured' | 'available';  // building=未构建完成, unconfigured=缺凭证, available=已加载
}

export interface AuthFieldDef {
  key: string;
  label: string;
  type?: string;
  required?: boolean;
}

export interface ConfirmFormField {
  key: string;
  label: string;
  type: string;
  required?: boolean;
  default?: any;
  columns?: { key: string; label: string }[];
}

export interface ToolDefinition {
  name: string;
  system: string;
  description: string;
  parameters: ToolParameter[];
  llmHint?: string;
  handlerCode?: string;
  authSystem?: string;
  authFields?: AuthFieldDef[];
  confirm?: boolean;
  confirmForm?: ConfirmFormField[];
  dirName: string;
  enabled: boolean;
  permissions: ConnectorPermissions;
  status: ConnectorStatus;
}

@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly toolsDir: string;
  private tools = new Map<string, ToolDefinition>();

  constructor(private readonly workspace: WorkspaceService) {
    this.toolsDir = path.join(this.workspace.getConfigDir(), 'tools');
    this.loadAll();
  }

  loadAll() {
    this.tools.clear();
    if (!fs.existsSync(this.toolsDir)) { fs.mkdirSync(this.toolsDir, { recursive: true }); return; }

    const dirs = fs.readdirSync(this.toolsDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const yamlPath = path.join(this.toolsDir, dir.name, 'tool.yaml');
      if (!fs.existsSync(yamlPath)) continue;
      try {
        const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as any;
        const t = raw.tool || raw;
        const auth = t.auth || {};
        const handlerPath = path.join(this.toolsDir, dir.name, 'handler.ts');
        const def: ToolDefinition = {
          name: t.name || dir.name,
          system: t.system || '',
          description: t.description || '',
          parameters: (t.parameters || []).map((p: any) => ({
            name: p.name, type: p.type || 'string',
            required: p.required ?? false, description: p.description || '',
            label: p.label || undefined,
          })),
          llmHint: t.llm_hint || t.llmHint || undefined,
          handlerCode: fs.existsSync(handlerPath) ? fs.readFileSync(handlerPath, 'utf-8') : undefined,
          authSystem: auth.system || undefined,
          authFields: Array.isArray(auth.fields)
            ? auth.fields.map((f: any) => ({ key: f.key, label: f.label || f.key, type: f.type, required: f.required }))
            : undefined,
          confirm: t.confirm === true,
          confirmForm: Array.isArray(t.confirmForm)
            ? t.confirmForm.map((f: any) => ({
                key: f.key, label: f.label, type: f.type || 'string',
                required: f.required, default: f.default,
                columns: Array.isArray(f.columns) ? f.columns.map((c: any) => ({ key: c.key, label: c.label })) : undefined,
              }))
            : undefined,
          dirName: dir.name,
          enabled: t.enabled !== false,
          permissions: t.permissions || {},
          status: { loaded: true },
        };
        this.tools.set(def.name, def);
        this.logger.log(`Loaded tool: ${def.name} (enabled=${def.enabled})`);
      } catch (err: any) {
        this.logger.error(`Failed to load tool ${dir.name}: ${err.message}`);
      }
    }
    this.logger.log(`Total: ${this.tools.size} tools loaded`);
  }

  getAll(): ToolDefinition[] { return Array.from(this.tools.values()); }
  getEnabled(): ToolDefinition[] { return this.getAll().filter(t => t.enabled); }
  get(name: string): ToolDefinition | undefined { return this.tools.get(name); }

  enable(name: string): boolean { return this.setEnabled(name, true); }
  disable(name: string): boolean { return this.setEnabled(name, false); }

  private setEnabled(name: string, enabled: boolean): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    tool.enabled = enabled;
    this.saveYaml(tool);
    return true;
  }

  setLlmHint(name: string, hint: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    tool.llmHint = hint || undefined;
    // Persist to tool.yaml
    const yamlPath = path.join(this.toolsDir, tool.dirName, 'tool.yaml');
    if (fs.existsSync(yamlPath)) {
      try {
        const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as any;
        const t = raw.tool || raw;
        t.llm_hint = hint || undefined;
        fs.writeFileSync(yamlPath, yaml.dump(raw.tool ? raw : { tool: t }, { lineWidth: 120 }), 'utf-8');
      } catch { /* ignore */ }
    }
    return true;
  }

  setPermissions(name: string, perms: ConnectorPermissions): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    tool.permissions = perms;
    this.saveYaml(tool);
    return true;
  }

  markUsed(name: string) {
    const tool = this.tools.get(name);
    if (tool) tool.status.lastUsed = new Date().toISOString();
  }

  isAllowedForUser(name: string, userId: string, roleId: string): boolean {
    const tool = this.tools.get(name);
    if (!tool || !tool.enabled) return false;
    const p = tool.permissions;
    if (!p.allowedRoles?.length && !p.allowedUsers?.length) return true; // no restrictions
    if (p.allowedUsers?.includes(userId)) return true;
    if (p.allowedRoles?.includes(roleId)) return true;
    return false;
  }

  delete(name: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    const srcDir = path.join(this.toolsDir, tool.dirName);
    const deletedDir = path.join(this.toolsDir, '.deleted');
    if (!fs.existsSync(deletedDir)) fs.mkdirSync(deletedDir, { recursive: true });
    const destDir = path.join(deletedDir, `${tool.dirName}_${Date.now()}`);
    if (fs.existsSync(srcDir)) {
      fs.renameSync(srcDir, destDir);
      this.logger.log(`Tool files moved: ${srcDir} → ${destDir}`);
    }
    this.tools.delete(name);
    this.logger.log(`Deleted tool: ${name}`);
    return true;
  }

  listDeleted(): { dirName: string; originalName: string; deletedAt: string; name?: string; description?: string }[] {
    const deletedDir = path.join(this.toolsDir, '.deleted');
    if (!fs.existsSync(deletedDir)) return [];
    const results: any[] = [];
    const dirs = fs.readdirSync(deletedDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const match = dir.name.match(/^(.+)_(\d+)$/);
      if (!match) continue;
      let info: any = {};
      const yamlPath = path.join(deletedDir, dir.name, 'tool.yaml');
      if (fs.existsSync(yamlPath)) {
        try {
          const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as any;
          const t = raw.tool || raw;
          info = { name: t.name, description: t.description };
        } catch {}
      }
      results.push({ dirName: dir.name, originalName: match[1], deletedAt: new Date(parseInt(match[2])).toISOString(), ...info });
    }
    return results.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  restore(dirName: string): { success: boolean; name?: string; error?: string } {
    const deletedDir = path.join(this.toolsDir, '.deleted');
    const srcDir = path.join(deletedDir, dirName);
    if (!fs.existsSync(srcDir)) return { success: false, error: '未找到该已删除项' };
    const match = dirName.match(/^(.+)_(\d+)$/);
    if (!match) return { success: false, error: '目录名格式异常' };
    const originalName = match[1];
    const destDir = path.join(this.toolsDir, originalName);
    if (fs.existsSync(destDir)) return { success: false, error: `同名工具 "${originalName}" 已存在` };
    fs.renameSync(srcDir, destDir);
    this.loadAll();
    this.logger.log(`Tool restored: ${originalName}`);
    return { success: true, name: originalName };
  }

  purge(dirName: string): { success: boolean } {
    const targetDir = path.join(this.toolsDir, '.deleted', dirName);
    if (!fs.existsSync(targetDir)) return { success: false };
    fs.rmSync(targetDir, { recursive: true });
    this.logger.log(`Tool purged: ${dirName}`);
    return { success: true };
  }

  getManifest(name: string): string | null {
    const tool = this.tools.get(name);
    if (!tool) return null;
    const yamlPath = path.join(this.toolsDir, tool.dirName, 'tool.yaml');
    return fs.existsSync(yamlPath) ? fs.readFileSync(yamlPath, 'utf-8') : null;
  }

  saveManifest(name: string, content: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    const yamlPath = path.join(this.toolsDir, tool.dirName, 'tool.yaml');
    fs.writeFileSync(yamlPath, content, 'utf-8');
    this.loadAll(); // reload to pick up changes
    return true;
  }

  getHandler(name: string): string | null {
    const tool = this.tools.get(name);
    if (!tool) return null;
    const handlerPath = path.join(this.toolsDir, tool.dirName, 'handler.ts');
    return fs.existsSync(handlerPath) ? fs.readFileSync(handlerPath, 'utf-8') : null;
  }

  saveHandler(name: string, code: string): boolean {
    const tool = this.tools.get(name);
    if (!tool) return false;
    const handlerPath = path.join(this.toolsDir, tool.dirName, 'handler.ts');
    fs.writeFileSync(handlerPath, code, 'utf-8');
    tool.handlerCode = code;
    return true;
  }

  private saveYaml(tool: ToolDefinition) {
    const dirPath = path.join(this.toolsDir, tool.dirName);
    const yamlPath = path.join(dirPath, 'tool.yaml');
    if (!fs.existsSync(yamlPath)) return;
    try {
      const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as any;
      const t = raw.tool || raw;
      t.enabled = tool.enabled;
      t.permissions = Object.keys(tool.permissions).length > 0 ? tool.permissions : undefined;
      fs.writeFileSync(yamlPath, yaml.dump(raw.tool ? raw : { tool: t }), 'utf-8');
    } catch { /* ignore save errors */ }
  }
}
