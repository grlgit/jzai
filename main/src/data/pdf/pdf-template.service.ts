import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WorkspaceService } from '../../workspace/workspace.service';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

export interface PdfTemplate {
  id: string;
  name: string;
  description: string;
  icon: string;
  isSystem: boolean;
  userId: string;        // 'system' (shared) or user ID

  page: { size: string; orientation: string; margins: number[] };
  header?: { left?: string; right?: string; logo?: boolean; borderBottom?: boolean };
  footer?: { center?: string; right?: string };
  styles?: Record<string, any>;
  sections: any[];

  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PdfTemplateService implements OnModuleInit {
  private readonly logger = new Logger(PdfTemplateService.name);

  constructor(private readonly workspace: WorkspaceService) {}

  onModuleInit() {
    this.seedSharedTemplates();
  }

  /**
   * Seed shared templates from config/pdf-templates/*.yaml into workspace.
   * Only imports templates whose ID doesn't already exist (won't overwrite edits).
   */
  private seedSharedTemplates() {
    const seedDir = path.join(process.cwd(), 'config', 'pdf-templates');
    if (!fs.existsSync(seedDir)) {
      this.logger.warn(`Seed template dir not found: ${seedDir}`);
      return;
    }

    const sharedDir = this.getSharedTemplateDir();
    const existing = this.loadTemplatesFromDir(sharedDir);
    const existingIds = new Set(existing.map(t => t.id));
    let seeded = 0;

    const files = fs.readdirSync(seedDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(seedDir, file), 'utf-8');
        const raw = yaml.load(content) as any;
        if (!raw?.id || !raw?.name) continue;
        if (existingIds.has(raw.id)) continue; // Already exists, don't overwrite

        const template: PdfTemplate = {
          id: raw.id,
          name: raw.name,
          description: raw.description || '',
          icon: raw.icon || '📄',
          isSystem: true,
          userId: 'system',
          page: raw.page || { size: 'A4', orientation: 'portrait', margins: [40, 60, 40, 60] },
          header: raw.header,
          footer: raw.footer,
          styles: raw.styles,
          sections: raw.sections || [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        fs.writeFileSync(path.join(sharedDir, `${template.id}.json`), JSON.stringify(template, null, 2));
        seeded++;
      } catch (err: any) {
        this.logger.error(`Failed to seed template ${file}: ${err.message}`);
      }
    }

    const total = this.loadTemplatesFromDir(sharedDir).length;
    this.logger.log(`Shared PDF templates: ${total} total (${seeded} newly seeded)`);
  }

  /**
   * List all templates: shared (system) + user's personal.
   */
  listTemplates(userId: string): PdfTemplate[] {
    const shared = this.loadTemplatesFromDir(this.getSharedTemplateDir());
    const user = this.loadTemplatesFromDir(this.getUserTemplateDir(userId));
    return [...shared, ...user];
  }

  /**
   * Get a single template by ID. Checks shared first, then user.
   */
  getTemplate(userId: string, templateId: string): PdfTemplate | null {
    // Check shared templates
    const sharedPath = path.join(this.getSharedTemplateDir(), `${templateId}.json`);
    if (fs.existsSync(sharedPath)) {
      try { return JSON.parse(fs.readFileSync(sharedPath, 'utf-8')); } catch {}
    }
    // Check user templates
    const userPath = path.join(this.getUserTemplateDir(userId), `${templateId}.json`);
    if (fs.existsSync(userPath)) {
      try { return JSON.parse(fs.readFileSync(userPath, 'utf-8')); } catch {}
    }
    return null;
  }

  /**
   * Create a new template. isSystem=true → shared dir, otherwise user dir.
   */
  createTemplate(userId: string, data: Partial<PdfTemplate>): PdfTemplate {
    const isSystem = data.isSystem || false;
    const template: PdfTemplate = {
      id: `tpl_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: data.name || '未命名模板',
      description: data.description || '',
      icon: data.icon || '📄',
      isSystem,
      userId: isSystem ? 'system' : userId,
      page: data.page || { size: 'A4', orientation: 'portrait', margins: [40, 60, 40, 60] },
      header: data.header,
      footer: data.footer,
      styles: data.styles,
      sections: data.sections || [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const dir = isSystem ? this.getSharedTemplateDir() : this.getUserTemplateDir(userId);
    fs.writeFileSync(path.join(dir, `${template.id}.json`), JSON.stringify(template, null, 2));
    return template;
  }

  /**
   * Update a template (shared or user).
   */
  updateTemplate(userId: string, templateId: string, data: Partial<PdfTemplate>): PdfTemplate | null {
    const template = this.getTemplate(userId, templateId);
    if (!template) return null;

    const updated: PdfTemplate = {
      ...template,
      ...data,
      id: templateId,
      isSystem: template.isSystem,
      userId: template.userId,
      updatedAt: new Date().toISOString(),
    };

    const dir = template.isSystem ? this.getSharedTemplateDir() : this.getUserTemplateDir(userId);
    fs.writeFileSync(path.join(dir, `${templateId}.json`), JSON.stringify(updated, null, 2));
    return updated;
  }

  /**
   * Delete a template.
   */
  deleteTemplate(userId: string, templateId: string): boolean {
    // Try shared dir first
    const sharedPath = path.join(this.getSharedTemplateDir(), `${templateId}.json`);
    if (fs.existsSync(sharedPath)) { fs.unlinkSync(sharedPath); return true; }
    // Try user dir
    const userPath = path.join(this.getUserTemplateDir(userId), `${templateId}.json`);
    if (fs.existsSync(userPath)) { fs.unlinkSync(userPath); return true; }
    return false;
  }

  /**
   * Duplicate a template as a new user template.
   */
  duplicateTemplate(userId: string, templateId: string): PdfTemplate | null {
    const source = this.getTemplate(userId, templateId);
    if (!source) return null;

    return this.createTemplate(userId, {
      name: `${source.name} (副本)`,
      description: source.description,
      icon: source.icon,
      isSystem: false,
      page: { ...source.page },
      header: source.header ? { ...source.header } : undefined,
      footer: source.footer ? { ...source.footer } : undefined,
      styles: source.styles ? { ...source.styles } : undefined,
      sections: JSON.parse(JSON.stringify(source.sections)),
    });
  }

  /**
   * Resolve template: merge template skeleton with variables.
   */
  resolveTemplate(template: PdfTemplate, vars: Record<string, any>): any {
    const resolved = JSON.parse(JSON.stringify({
      filename: template.name,
      title: template.name,
      page: template.page,
      header: template.header,
      footer: template.footer,
      styles: template.styles,
      sections: template.sections,
    }));

    const resolveStr = (s: string): string => {
      return s.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        const val = vars[key];
        return val !== undefined ? String(val) : `{{${key}}}`;
      });
    };

    const resolveObj = (obj: any): any => {
      if (typeof obj === 'string') return resolveStr(obj);
      if (Array.isArray(obj)) return obj.map(resolveObj);
      if (obj && typeof obj === 'object') {
        const result: any = {};
        for (const [k, v] of Object.entries(obj)) {
          result[k] = resolveObj(v);
        }
        return result;
      }
      return obj;
    };

    return resolveObj(resolved);
  }

  // --- Private helpers ---

  /** Shared templates directory: {workspace}/shared/pdf-templates/ */
  private getSharedTemplateDir(): string {
    const dir = path.join(this.workspace.getRoot(), 'shared', 'pdf-templates');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** User templates directory: {workspace}/{userId}/exports/pdf-templates/ */
  private getUserTemplateDir(userId: string): string {
    const dir = path.join(this.workspace.getExportDir(userId), 'pdf-templates');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private loadTemplatesFromDir(dir: string): PdfTemplate[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as PdfTemplate;
        } catch {
          return null;
        }
      })
      .filter((t): t is PdfTemplate => t !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
