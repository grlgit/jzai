import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WorkspaceService } from '../../workspace/workspace.service';
import { validateNameForTool } from '../../utils/tool-name.validator';

// === Agent Skills Standard (agentskills.io/specification) ===

export interface SkillDefinition {
  name: string;                          // frontmatter: 小写+连字符, 1-64字符
  description: string;                   // frontmatter: 1-1024字符
  instructions: string;                  // SKILL.md body (Markdown)
  metadata?: Record<string, string>;     // frontmatter.metadata
  allowedTools?: string[];               // frontmatter.allowed-tools (空格分隔 → 数组)
  knowledgeDomains?: string[];           // frontmatter.knowledge-domains (关联知识库路径/标签)
  compatibility?: string;                // frontmatter.compatibility
  license?: string;                      // frontmatter.license
  confirmForm?: { key: string; label: string; type: string; required?: boolean; default?: any; format?: string; columns?: { key: string; label: string }[] }[];
  dirName: string;                       // 目录名
  hasHandler: boolean;                   // scripts/handler.ts 存在
  hasReferences: boolean;                // references/ 目录存在
  hasAssets: boolean;                    // assets/ 目录存在
}

@Injectable()
export class SkillRegistryService {
  private readonly logger = new Logger(SkillRegistryService.name);
  private readonly skillsDir: string;
  private skills = new Map<string, SkillDefinition>();

  constructor(private readonly workspace: WorkspaceService) {
    this.skillsDir = path.join(this.workspace.getConfigDir(), 'skills');
    this.loadAll();
  }

  loadAll() {
    this.skills.clear();
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true });
      return;
    }

    const dirs = fs.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const dir of dirs) {
      const skillMdPath = path.join(this.skillsDir, dir.name, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) continue;

      try {
        const raw = fs.readFileSync(skillMdPath, 'utf-8');
        const { frontmatter, body } = this.parseFrontmatter(raw);

        if (!frontmatter.name || !frontmatter.description) {
          this.logger.warn(`Skill ${dir.name}/SKILL.md missing required name or description`);
          continue;
        }

        const allowedToolsRaw = frontmatter['allowed-tools'] || '';
        const allowedTools = typeof allowedToolsRaw === 'string' && allowedToolsRaw.trim()
          ? allowedToolsRaw.trim().split(/\s+/) : undefined;

        // Parse knowledge-domains: array of KB paths/tags this skill relates to
        const kdRaw = frontmatter['knowledge-domains'];
        const knowledgeDomains = Array.isArray(kdRaw) ? kdRaw.filter((d: any) => typeof d === 'string')
          : typeof kdRaw === 'string' && kdRaw.trim() ? kdRaw.trim().split(/[,\s]+/) : undefined;

        const dirPath = path.join(this.skillsDir, dir.name);
        const skill: SkillDefinition = {
          name: frontmatter.name,
          description: frontmatter.description,
          instructions: body.trim(),
          metadata: frontmatter.metadata || undefined,
          allowedTools,
          knowledgeDomains,
          confirmForm: Array.isArray(frontmatter['confirm-form']) ? frontmatter['confirm-form'] : undefined,
          compatibility: frontmatter.compatibility || undefined,
          license: frontmatter.license || undefined,
          dirName: dir.name,
          hasHandler: this.findHandler(dirPath) !== null,
          hasReferences: fs.existsSync(path.join(dirPath, 'references')),
          hasAssets: fs.existsSync(path.join(dirPath, 'assets')),
        };

        this.skills.set(skill.name, skill);
        this.logger.log(`Loaded skill: ${skill.name}${skill.hasHandler ? ' [handler]' : ''}${skill.allowedTools?.length ? ` [tools: ${skill.allowedTools.length}]` : ''}`);
      } catch (err: any) {
        this.logger.error(`Failed to load skill ${dir.name}: ${err.message}`);
      }
    }
    this.logger.log(`Total: ${this.skills.size} skills loaded`);
  }

  // === Frontmatter parser ===

  private parseFrontmatter(content: string): { frontmatter: any; body: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!match) return { frontmatter: {}, body: content };
    try {
      return { frontmatter: yaml.load(match[1]) || {}, body: match[2] };
    } catch {
      return { frontmatter: {}, body: content };
    }
  }

  // === Handler file finder ===

  private findHandler(dirPath: string): string | null {
    const standardPath = path.join(dirPath, 'scripts', 'handler.ts');
    if (fs.existsSync(standardPath)) return standardPath;
    return null;
  }

  // === CRUD ===

  getAll(): SkillDefinition[] { return Array.from(this.skills.values()); }
  get(name: string): SkillDefinition | undefined { return this.skills.get(name); }

  /** Aggregate knowledge domains from all skills (or a subset by name). */
  getKnowledgeDomains(skillNames?: string[]): string[] {
    const domains = new Set<string>();
    const skills = skillNames
      ? skillNames.map(n => this.skills.get(n)).filter(Boolean) as SkillDefinition[]
      : this.getAll();
    for (const s of skills) {
      for (const d of s.knowledgeDomains || []) domains.add(d);
    }
    return Array.from(domains);
  }

  save(skill: SkillDefinition, handlerCode?: string) {
    // 验证技能名称是否符合工具命名规范
    try {
      validateNameForTool(skill.name, 'skill_');
    } catch (err: any) {
      this.logger.error(`Skill name validation failed: ${err.message}`);
      throw new Error(`技能名称不符合规范：${err.message}`);
    }

    const dirPath = path.join(this.skillsDir, skill.dirName || skill.name);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });

    // Write SKILL.md
    const fm: any = { name: skill.name, description: skill.description };
    if (skill.license) fm.license = skill.license;
    if (skill.compatibility) fm.compatibility = skill.compatibility;
    if (skill.metadata) fm.metadata = skill.metadata;
    if (skill.allowedTools?.length) fm['allowed-tools'] = skill.allowedTools.join(' ');
    if (skill.knowledgeDomains?.length) fm['knowledge-domains'] = skill.knowledgeDomains;
    const content = `---\n${yaml.dump(fm, { lineWidth: 120 }).trim()}\n---\n\n${skill.instructions || ''}`;
    fs.writeFileSync(path.join(dirPath, 'SKILL.md'), content, 'utf-8');

    // Write handler to scripts/
    if (handlerCode) {
      const scriptsDir = path.join(dirPath, 'scripts');
      if (!fs.existsSync(scriptsDir)) fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(scriptsDir, 'handler.ts'), handlerCode, 'utf-8');
    }

    this.skills.set(skill.name, { ...skill, dirName: skill.dirName || skill.name, hasHandler: !!handlerCode || skill.hasHandler });
    this.logger.log(`Saved skill: ${skill.name}`);
  }

  delete(name: string): boolean {
    const skill = this.skills.get(name);
    if (!skill) return false;
    const srcDir = path.join(this.skillsDir, skill.dirName);
    const deletedDir = path.join(this.skillsDir, '.deleted');
    if (!fs.existsSync(deletedDir)) fs.mkdirSync(deletedDir, { recursive: true });
    const destDir = path.join(deletedDir, `${skill.dirName}_${Date.now()}`);
    if (fs.existsSync(srcDir)) fs.renameSync(srcDir, destDir);
    this.skills.delete(name);
    this.logger.log(`Deleted skill: ${name}`);
    return true;
  }

  listDeleted(): { dirName: string; originalName: string; deletedAt: string; name?: string; description?: string }[] {
    const deletedDir = path.join(this.skillsDir, '.deleted');
    if (!fs.existsSync(deletedDir)) return [];
    const results: any[] = [];
    const dirs = fs.readdirSync(deletedDir, { withFileTypes: true }).filter(d => d.isDirectory());
    for (const dir of dirs) {
      const match = dir.name.match(/^(.+)_(\d+)$/);
      if (!match) continue;
      let info: any = {};
      const skillMdPath = path.join(deletedDir, dir.name, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        const { frontmatter } = this.parseFrontmatter(fs.readFileSync(skillMdPath, 'utf-8'));
        info = { name: frontmatter.name, description: frontmatter.description };
      }
      results.push({ dirName: dir.name, originalName: match[1], deletedAt: new Date(parseInt(match[2])).toISOString(), ...info });
    }
    return results.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  restore(dirName: string): { success: boolean; name?: string; error?: string } {
    const deletedDir = path.join(this.skillsDir, '.deleted');
    const srcDir = path.join(deletedDir, dirName);
    if (!fs.existsSync(srcDir)) return { success: false, error: '未找到该已删除项' };
    const match = dirName.match(/^(.+)_(\d+)$/);
    if (!match) return { success: false, error: '目录名格式异常' };
    const originalName = match[1];
    const destDir = path.join(this.skillsDir, originalName);
    if (fs.existsSync(destDir)) return { success: false, error: `同名技能 "${originalName}" 已存在` };
    fs.renameSync(srcDir, destDir);
    this.loadAll();
    return { success: true, name: originalName };
  }

  purge(dirName: string): { success: boolean } {
    const targetDir = path.join(this.skillsDir, '.deleted', dirName);
    if (!fs.existsSync(targetDir)) return { success: false };
    fs.rmSync(targetDir, { recursive: true });
    return { success: true };
  }

  // === Content accessors ===

  getHandlerCode(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;
    const handlerPath = this.findHandler(path.join(this.skillsDir, skill.dirName));
    return handlerPath ? fs.readFileSync(handlerPath, 'utf-8') : null;
  }

  getRawSkillMd(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;
    const p = path.join(this.skillsDir, skill.dirName, 'SKILL.md');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
  }

  getInstructions(name: string): string | null {
    const skill = this.skills.get(name);
    return skill?.instructions || null;
  }

  getReferences(name: string): string[] {
    const skill = this.skills.get(name);
    if (!skill) return [];
    const refDir = path.join(this.skillsDir, skill.dirName, 'references');
    if (!fs.existsSync(refDir)) return [];
    return fs.readdirSync(refDir).filter(f => !f.startsWith('.'));
  }

  getReferenceContent(name: string, file: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;
    const safeName = path.basename(file);
    const filePath = path.join(this.skillsDir, skill.dirName, 'references', safeName);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  getScripts(name: string): string[] {
    const skill = this.skills.get(name);
    if (!skill) return [];
    const scriptsDir = path.join(this.skillsDir, skill.dirName, 'scripts');
    if (!fs.existsSync(scriptsDir)) return [];
    return fs.readdirSync(scriptsDir).filter(f => !f.startsWith('.'));
  }

  getScriptContent(name: string, file: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;
    const safeName = path.basename(file);
    const filePath = path.join(this.skillsDir, skill.dirName, 'scripts', safeName);
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath, 'utf-8');
  }

  /**
   * Save content to a file within a skill directory.
   * For SKILL.md 'instructions' mode: updates only the body, preserving frontmatter.
   */
  saveFileContent(name: string, relativePath: string, content: string, mode?: 'instructions' | 'full'): { success: boolean; error?: string } {
    const skill = this.skills.get(name);
    if (!skill) return { success: false, error: '技能未找到' };

    if (mode === 'instructions') {
      // Update SKILL.md body while preserving frontmatter
      const skillMdPath = path.join(this.skillsDir, skill.dirName, 'SKILL.md');
      if (!fs.existsSync(skillMdPath)) return { success: false, error: 'SKILL.md 不存在' };
      const raw = fs.readFileSync(skillMdPath, 'utf-8');
      const { frontmatter } = this.parseFrontmatter(raw);
      const newContent = `---\n${yaml.dump(frontmatter, { lineWidth: 120 }).trim()}\n---\n\n${content}`;
      fs.writeFileSync(skillMdPath, newContent, 'utf-8');
      skill.instructions = content;
      return { success: true };
    }

    if (mode === 'full') {
      // Save entire SKILL.md (frontmatter + body) and reload skill
      const skillMdPath = path.join(this.skillsDir, skill.dirName, 'SKILL.md');
      fs.writeFileSync(skillMdPath, content, 'utf-8');
      // Re-parse to update in-memory definition
      const { frontmatter, body } = this.parseFrontmatter(content);
      skill.name = frontmatter.name || skill.name;
      skill.description = frontmatter.description || skill.description;
      skill.instructions = body.trim();
      skill.metadata = frontmatter.metadata || undefined;
      skill.license = frontmatter.license || undefined;
      skill.compatibility = frontmatter.compatibility || undefined;
      const allowedToolsRaw = frontmatter['allowed-tools'] || '';
      skill.allowedTools = typeof allowedToolsRaw === 'string' && allowedToolsRaw.trim() ? allowedToolsRaw.trim().split(/\s+/) : undefined;
      return { success: true };
    }

    // General file save with path traversal protection
    const safePath = relativePath.split('/').map(s => path.basename(s)).join('/');
    const filePath = path.join(this.skillsDir, skill.dirName, safePath);
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    this.logger.log(`Saved file: ${skill.dirName}/${safePath}`);
    return { success: true };
  }

  deleteFile(name: string, dir: string, file: string): { success: boolean; error?: string } {
    const skill = this.skills.get(name);
    if (!skill) return { success: false, error: '技能未找到' };
    if (!['scripts', 'references', 'assets'].includes(dir)) return { success: false, error: '不允许的目录' };
    const safeName = path.basename(file);
    const filePath = path.join(this.skillsDir, skill.dirName, dir, safeName);
    if (!fs.existsSync(filePath)) return { success: false, error: '文件不存在' };
    fs.unlinkSync(filePath);
    this.logger.log(`Deleted file: ${skill.dirName}/${dir}/${safeName}`);
    return { success: true };
  }

  getAssets(name: string): string[] {
    const skill = this.skills.get(name);
    if (!skill) return [];
    const assetsDir = path.join(this.skillsDir, skill.dirName, 'assets');
    if (!fs.existsSync(assetsDir)) return [];
    return fs.readdirSync(assetsDir).filter(f => !f.startsWith('.'));
  }
}
