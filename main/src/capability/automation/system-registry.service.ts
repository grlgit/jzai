import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const SYSTEMS_DIR = path.join(process.cwd(), 'config', 'systems');
const TEMPLATES_DIR = path.join(process.cwd(), 'config', 'templates');

export interface SystemTool {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
  rpa_skill: string;
  data_template?: string;
}

export interface SystemAuth {
  type: string;
  loginUrl: string;
  fields: Record<string, string>;
  submitButton: string;
  credentials: Record<string, string>;
}

export interface RegisteredSystem {
  name: string;
  description: string;
  baseUrl: string;
  auth?: SystemAuth;
  tools: SystemTool[];
}

export interface FieldMapping {
  source: string[];
  target: string;
}

export interface DataTemplate {
  name: string;
  description: string;
  field_mapping: FieldMapping[];
  transforms?: Record<string, any>;
  required?: string[];
  defaults?: Record<string, any>;
}

@Injectable()
export class SystemRegistryService implements OnModuleInit {
  private readonly logger = new Logger(SystemRegistryService.name);
  private systems: RegisteredSystem[] = [];
  private templates = new Map<string, DataTemplate>();

  onModuleInit() {
    this.loadSystems();
    this.loadTemplates();
  }

  private loadSystems() {
    if (!fs.existsSync(SYSTEMS_DIR)) {
      this.logger.warn(`Systems directory not found: ${SYSTEMS_DIR}`);
      return;
    }
    const files = fs.readdirSync(SYSTEMS_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(SYSTEMS_DIR, file), 'utf-8');
        const doc = yaml.load(content) as any;
        const system: RegisteredSystem = {
          name: doc.system.name,
          description: doc.system.description,
          baseUrl: doc.system.baseUrl,
          auth: doc.system.auth,
          tools: (doc.tools || []).map((t: any) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters || {},
            rpa_skill: t.rpa_skill,
            data_template: t.data_template,
          })),
        };
        this.systems.push(system);
        this.logger.log(`Loaded system: ${system.name} (${system.tools.length} tools) from ${file}`);
      } catch (err: any) {
        this.logger.error(`Failed to load ${file}: ${err.message}`);
      }
    }
    this.logger.log(`Total: ${this.systems.length} systems, ${this.systems.reduce((s, sys) => s + sys.tools.length, 0)} tools`);
  }

  private loadTemplates() {
    if (!fs.existsSync(TEMPLATES_DIR)) return;
    const walk = (dir: string, prefix = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
        } else if (entry.name.endsWith('.yaml') || entry.name.endsWith('.yml')) {
          try {
            const content = fs.readFileSync(path.join(dir, entry.name), 'utf-8');
            const doc = yaml.load(content) as DataTemplate;
            const key = `${prefix}${entry.name.replace(/\.ya?ml$/, '')}`;
            this.templates.set(key, doc);
            this.logger.log(`Loaded template: ${key}`);
          } catch (err: any) {
            this.logger.error(`Failed to load template ${entry.name}: ${err.message}`);
          }
        }
      }
    };
    walk(TEMPLATES_DIR);
  }

  /**
   * Get all registered systems
   */
  getSystems(): RegisteredSystem[] {
    return this.systems;
  }

  /**
   * Get a system by name
   */
  getSystem(name: string): RegisteredSystem | undefined {
    return this.systems.find(s => s.name === name);
  }

  /**
   * Get a data template
   */
  getTemplate(key: string): DataTemplate | undefined {
    return this.templates.get(key);
  }

  /**
   * Apply data template to raw extracted data.
   * Maps source field names to target field names using the template.
   */
  applyTemplate(templateKey: string, rawData: Record<string, any>): Record<string, any> {
    const template = this.templates.get(templateKey);
    if (!template) return rawData;

    const result: Record<string, any> = { ...(template.defaults || {}) };

    for (const mapping of template.field_mapping) {
      // Find matching source field in raw data
      for (const sourceName of mapping.source) {
        const lowerSource = sourceName.toLowerCase();
        const matchingKey = Object.keys(rawData).find(k => k.toLowerCase() === lowerSource);
        if (matchingKey && rawData[matchingKey] !== undefined && rawData[matchingKey] !== '') {
          let value = rawData[matchingKey];
          // Apply transform if defined
          const transform = template.transforms?.[mapping.target];
          if (transform) {
            value = this.applyTransform(value, transform);
          }
          result[mapping.target] = value;
          break;
        }
      }
    }

    return result;
  }

  private applyTransform(value: any, transform: any): any {
    let str = String(value);
    if (transform.remove) {
      for (const r of transform.remove) {
        str = str.split(r).join('');
      }
    }
    if (transform.pattern) {
      const match = str.match(new RegExp(transform.pattern));
      if (match) str = match[1] || match[0];
    }
    if (transform.type === 'number') {
      return parseFloat(str) || 0;
    }
    return str.trim();
  }

  /**
   * List all templates with key and summary
   */
  listTemplates(): { key: string; name: string; description: string }[] {
    return Array.from(this.templates.entries()).map(([key, tpl]) => ({
      key, name: tpl.name || key, description: tpl.description || '',
    }));
  }

  /**
   * Save a system config to YAML file
   */
  saveSystem(data: any, existingName?: string): RegisteredSystem {
    const name = data.name || existingName;
    if (!name) throw new Error('System name required');
    const doc = {
      system: { name: data.name, description: data.description, baseUrl: data.baseUrl, auth: data.auth },
      tools: (data.tools || []).map((t: any) => ({
        name: t.name, description: t.description, parameters: t.parameters || {},
        rpa_skill: t.rpa_skill || '', data_template: t.data_template || '',
      })),
    };
    const fileName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').toLowerCase() + '.yaml';
    if (!fs.existsSync(SYSTEMS_DIR)) fs.mkdirSync(SYSTEMS_DIR, { recursive: true });
    fs.writeFileSync(path.join(SYSTEMS_DIR, fileName), yaml.dump(doc, { lineWidth: -1 }));
    if (existingName && existingName !== data.name) {
      const oldFile = existingName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').toLowerCase() + '.yaml';
      const oldPath = path.join(SYSTEMS_DIR, oldFile);
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      this.systems = this.systems.filter(s => s.name !== existingName);
    }
    const system: RegisteredSystem = { name: data.name, description: data.description, baseUrl: data.baseUrl, auth: data.auth, tools: doc.tools };
    const idx = this.systems.findIndex(s => s.name === name);
    if (idx >= 0) this.systems[idx] = system; else this.systems.push(system);
    this.logger.log(`System saved: ${name}`);
    return system;
  }

  deleteSystem(name: string): boolean {
    const idx = this.systems.findIndex(s => s.name === name);
    if (idx === -1) return false;
    this.systems.splice(idx, 1);
    const files = fs.readdirSync(SYSTEMS_DIR).filter(f => f.endsWith('.yaml'));
    for (const file of files) {
      try {
        const doc = yaml.load(fs.readFileSync(path.join(SYSTEMS_DIR, file), 'utf-8')) as any;
        if (doc?.system?.name === name) { fs.unlinkSync(path.join(SYSTEMS_DIR, file)); break; }
      } catch { /* ignore */ }
    }
    return true;
  }

  saveTemplate(key: string, template: DataTemplate) {
    this.templates.set(key, template);
    const parts = key.split('/');
    const dir = path.join(TEMPLATES_DIR, ...parts.slice(0, -1));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(TEMPLATES_DIR, ...parts) + '.yaml', yaml.dump(template, { lineWidth: -1 }));
    this.logger.log(`Template saved: ${key}`);
  }

  deleteTemplate(key: string): boolean {
    if (!this.templates.has(key)) return false;
    this.templates.delete(key);
    const fp = path.join(TEMPLATES_DIR, ...key.split('/')) + '.yaml';
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    return true;
  }

  /**
   * Build Agent tool descriptions from all registered systems.
   */
  buildAgentToolDescriptions(): string {
    return this.systems.map(sys => {
      const toolsDesc = sys.tools.map(t => {
        const params = Object.entries(t.parameters)
          .map(([k, v]) => `${k}(${v.description})`)
          .join(', ');
        return `  - ${t.name}: ${t.description} [参数: ${params}]`;
      }).join('\n');
      return `【${sys.name}】${sys.description}\n${toolsDesc}`;
    }).join('\n\n');
  }
}
