import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { AppManifest, AppManifestSchema } from './manifest.schema';

export type CheckLevel = 'critical' | 'warning';

export interface CheckResult {
  id: number;
  level: CheckLevel;
  code: string;
  message: string;
  details?: string;
}

export interface ValidationReport {
  appId?: string;
  version?: string;
  passed: boolean;          // true = no critical errors
  criticals: CheckResult[];
  warnings: CheckResult[];
  all: CheckResult[];
}

/** Tables the platform is willing to share as read-only with extension packages */
const SHARED_TABLE_WHITELIST = new Set([
  'jz_users',
  'jz_departments',
  'jz_kb_categories',
  'jz_panels',
  'jz_installed_apps',
]);

/** IDs of panels seeded by the platform (must not conflict) */
const BUILTIN_PANEL_IDS = new Set([
  'kb', 'cw', 'dashboard', 'skills', 'connectors', 'agents', 'cfg',
]);

/** Forbidden node built-in modules in dist/skills */
const FORBIDDEN_MODULES = ['child_process', 'worker_threads', 'vm', 'cluster', 'net', 'dgram', 'repl', 'inspector'];

/** Known heterogeneous framework markers */
const HETERO_FRAMEWORKS = ['vue', '@angular/', 'svelte', 'solid-js'];

/** React bundle inline markers */
const REACT_INLINE_MARKERS = ['__SECRET_INTERNALS', 'react.production.min'];

/** Backend dependency whitelist */
const BACKEND_DEP_WHITELIST = new Set([
  '@nestjs/common', '@nestjs/core', 'rxjs', 'zod', 'yaml', 'dayjs', 'lodash',
  'exceljs', 'pdf-lib', 'pdfjs-dist', 'dxf-parser', 'sharp',
]);

/**
 * 平台内置工具可暴露白名单（manifest.usesPlatformTools 校验），按风险分级：
 * L1 数据生成类 / L2 连接器只读类 / L3 界面控制类。
 * shell、文件读写、凭据管理类工具永不进入此名单。
 */
const PLATFORM_TOOL_WHITELIST = new Set([
  // L1 数据生成类
  'generate_pdf', 'update_pdf', 'list_pdf_templates', 'get_pdf_structure',
  'export_excel', 'update_excel_cells',
  'dashboard_manage', 'dashboard_widget', 'inline_chart',
  // L2 连接器只读类
  'knowledge', 'kb_mcp', 'mcp', 'dashboard_query', 'search_db_schema',
  // L3 界面控制类
  'ui_control',
]);

/** Sensitive data patterns */
const SENSITIVE_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN\s+\w+\s+PRIVATE KEY-----/,
  /password\s*[:=]\s*['"][^'"]{4,}/i,
];

@Injectable()
export class AppValidatorService {
  private readonly logger = new Logger(AppValidatorService.name);

  async validate(
    extractDir: string,
    existingAppIds: Set<string>,
    existingShortNames: Set<string>,
    existingNsPrefixes: Set<string>,
    existingSchemaNames: Set<string>,
    existingPanelIds: Set<string>,
    existingToolIds: Set<string>,
  ): Promise<ValidationReport> {
    const results: CheckResult[] = [];

    const check = (id: number, level: CheckLevel, code: string, message: string, details?: string) => {
      results.push({ id, level, code, message, details });
    };

    // ── Check 1: Package structure ──
    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      check(1, 'critical', 'MISSING_MANIFEST', 'manifest.json not found in package root');
      return this.buildReport(results, undefined);
    }

    // Check zip path traversal (already extracted — check filenames)
    const allFiles = this.listAllFiles(extractDir);
    const traversalFile = allFiles.find(f => f.includes('..'));
    if (traversalFile) {
      check(1, 'critical', 'PATH_TRAVERSAL', `Zip entry contains path traversal: ${traversalFile}`);
    }

    // Size checks
    const totalSize = allFiles.reduce((sum, f) => {
      try { return sum + fs.statSync(f).size; } catch { return sum; }
    }, 0);
    if (totalSize > 200 * 1024 * 1024) {
      check(1, 'critical', 'PKG_TOO_LARGE', `Package size ${(totalSize / 1024 / 1024).toFixed(1)}MB exceeds 200MB limit`);
    }
    if (allFiles.length > 5000) {
      check(1, 'critical', 'TOO_MANY_FILES', `Package contains ${allFiles.length} files, exceeds 5000 limit`);
    }

    // ── Check 2: Manifest Zod validation ──
    let manifest: AppManifest;
    try {
      const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const parsed = AppManifestSchema.safeParse(raw);
      if (!parsed.success) {
        const issues = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
        check(2, 'critical', 'MANIFEST_INVALID', `manifest.json schema validation failed: ${issues}`);
        return this.buildReport(results, undefined);
      }
      manifest = parsed.data;
    } catch (err: any) {
      check(2, 'critical', 'MANIFEST_PARSE_ERROR', `Failed to parse manifest.json: ${err.message}`);
      return this.buildReport(results, undefined);
    }

    const { appId, shortName, nsPrefix } = manifest;
    const schemaName = manifest.database?.schemaName;

    // ── Check 3: Uniqueness ──
    if (existingAppIds.has(appId)) {
      check(3, 'critical', 'DUPLICATE_APP_ID', `appId "${appId}" is already installed`);
    }
    if (existingShortNames.has(shortName)) {
      check(3, 'critical', 'DUPLICATE_SHORT_NAME', `shortName "${shortName}" is already in use`);
    }
    if (existingNsPrefixes.has(nsPrefix)) {
      check(3, 'critical', 'DUPLICATE_NS_PREFIX', `nsPrefix "${nsPrefix}" is already in use`);
    }
    if (schemaName && existingSchemaNames.has(schemaName)) {
      check(3, 'critical', 'DUPLICATE_SCHEMA_NAME', `database.schemaName "${schemaName}" is already in use`);
    }
    for (const panel of manifest.panels ?? []) {
      if (BUILTIN_PANEL_IDS.has(panel.id) || existingPanelIds.has(panel.id)) {
        check(3, 'critical', 'DUPLICATE_PANEL_ID', `Panel id "${panel.id}" conflicts with existing panel`);
      }
    }
    const allToolIds = (manifest.backend?.toolProviders ?? []).flatMap(tp => tp.toolIds);
    for (const toolId of allToolIds) {
      if (existingToolIds.has(toolId)) {
        check(3, 'critical', 'DUPLICATE_TOOL_ID', `Tool id "${toolId}" conflicts with existing tool`);
      }
    }

    // ── Check 4: Namespace and length compliance ──
    for (const toolId of allToolIds) {
      if (!toolId.startsWith(`${nsPrefix}_`)) {
        check(4, 'critical', 'TOOL_NS_VIOLATION', `Tool id "${toolId}" must start with nsPrefix "${nsPrefix}_"`);
      }
      if (toolId.length > 64) {
        check(4, 'critical', 'TOOL_NAME_TOO_LONG', `Tool id "${toolId}" exceeds 64 character limit`);
      }
    }
    for (const skill of manifest.skills ?? []) {
      if (skill.dir.length > 51) {
        check(4, 'critical', 'SKILL_NAME_TOO_LONG', `Skill dir "${skill.dir}" exceeds 51 character limit`);
      }
    }
    for (const perm of manifest.permissions ?? []) {
      if (!perm.id.startsWith(`${nsPrefix}:`)) {
        check(4, 'critical', 'PERM_NS_VIOLATION', `Permission id "${perm.id}" must start with nsPrefix "${nsPrefix}:"`);
      }
    }
    // Non-ASCII check on identifiers
    if (!/^[\x00-\x7F]*$/.test(appId + shortName + nsPrefix)) {
      check(4, 'critical', 'NON_ASCII_ID', 'appId/shortName/nsPrefix must use only ASCII characters');
    }

    // ── Check 5: Shared tables declaration compliance ──
    for (const table of manifest.database?.sharedTablesRead ?? []) {
      if (!SHARED_TABLE_WHITELIST.has(table)) {
        check(5, 'critical', 'UNDECLARED_SHARED_TABLE',
          `"${table}" is not in the platform shared tables whitelist. Available: ${[...SHARED_TABLE_WHITELIST].join(', ')}`);
      }
    }

    // ── Check 6: Forbidden module imports (WARNING) ──
    const scanDirs6 = [
      path.join(extractDir, 'dist'),
      path.join(extractDir, 'skills'),
    ].filter(d => fs.existsSync(d));

    for (const scanDir of scanDirs6) {
      const jsFiles = this.listAllFiles(scanDir).filter(f => f.endsWith('.js') || f.endsWith('.ts'));
      for (const file of jsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const mod of FORBIDDEN_MODULES) {
          if (content.includes(`require('${mod}')`) || content.includes(`require("${mod}")`)) {
            check(6, 'warning', 'FORBIDDEN_MODULE_IMPORT',
              `File ${path.relative(extractDir, file)} imports "${mod}". This module gives low-level system access.`,
              `require('${mod}')`);
          }
        }
        // fs write methods
        if (/fs\.(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rmdir|rmdirSync|rm\b)/g.test(content)) {
          check(6, 'warning', 'FS_WRITE_IMPORT',
            `File ${path.relative(extractDir, file)} uses fs write operations.`);
        }
      }
    }

    // ── Check 7: Dynamic execution (WARNING) ──
    const scanDirs7 = [
      path.join(extractDir, 'dist'),
      path.join(extractDir, 'skills'),
    ].filter(d => fs.existsSync(d));

    for (const scanDir of scanDirs7) {
      const jsFiles = this.listAllFiles(scanDir).filter(f => f.endsWith('.js') || f.endsWith('.ts'));
      for (const file of jsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (/\beval\s*\(/.test(content)) {
          check(7, 'warning', 'DYNAMIC_EVAL', `File ${path.relative(extractDir, file)} uses eval()`);
        }
        if (/new\s+Function\s*\(/.test(content)) {
          check(7, 'warning', 'DYNAMIC_NEW_FUNCTION', `File ${path.relative(extractDir, file)} uses new Function()`);
        }
      }
    }

    // ── Check 8: No platform internal path references ──
    const distPagesDir = path.join(extractDir, 'dist', 'pages');
    if (fs.existsSync(distPagesDir)) {
      const jsFiles = this.listAllFiles(distPagesDir).filter(f => f.endsWith('.js'));
      for (const file of jsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes('@/') || content.includes('../../main') || content.includes('../../web')) {
          check(8, 'critical', 'INTERNAL_PATH_REF',
            `Frontend file ${path.relative(extractDir, file)} references platform internal paths (@/, ../../main, ../../web)`);
        }
      }
    }

    const distBackendDir = path.join(extractDir, 'dist', 'backend');
    if (fs.existsSync(distBackendDir)) {
      const jsFiles = this.listAllFiles(distBackendDir).filter(f => f.endsWith('.js'));
      for (const file of jsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        if (content.includes('../../main') || content.includes('../../web')) {
          check(8, 'critical', 'INTERNAL_PATH_REF',
            `Backend file ${path.relative(extractDir, file)} references platform internal paths`);
        }
      }
    }

    // ── Check 9: No heterogeneous frameworks ──
    const allJsFiles = [
      ...this.listAllFiles(path.join(extractDir, 'dist')).filter(f => f.endsWith('.js')),
      ...((manifest.backend?.toolProviders ?? []).length > 0
        ? this.listAllFiles(path.join(extractDir, 'dist', 'backend')).filter(f => f.endsWith('.js'))
        : []),
    ].filter(f => fs.existsSync(f));

    const pkgJsonPath = path.join(extractDir, 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
        const allDeps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.devDependencies };
        for (const fw of HETERO_FRAMEWORKS) {
          if (fw in allDeps) {
            check(9, 'critical', 'HETERO_FRAMEWORK', `package.json declares "${fw}" — only React is allowed`);
          }
        }
      } catch {}
    }

    for (const file of allJsFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const fw of HETERO_FRAMEWORKS) {
        if (content.includes(fw)) {
          check(9, 'critical', 'HETERO_FRAMEWORK_BUNDLED',
            `File ${path.relative(extractDir, file)} appears to bundle "${fw}"`);
          break;
        }
      }
    }

    // ── Check 10: React must not be inlined ──
    if (fs.existsSync(distPagesDir)) {
      const jsFiles = this.listAllFiles(distPagesDir).filter(f => f.endsWith('.js'));
      for (const file of jsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const marker of REACT_INLINE_MARKERS) {
          if (content.includes(marker)) {
            check(10, 'critical', 'REACT_INLINED',
              `Frontend file ${path.relative(extractDir, file)} appears to bundle React (found "${marker}"). Use React as external.`);
            break;
          }
        }
      }
    }

    // ── Check 10.5: usesPlatformTools 白名单校验（分级白名单，见 PLATFORM_TOOL_WHITELIST）──
    for (const toolId of manifest.usesPlatformTools ?? []) {
      if (!PLATFORM_TOOL_WHITELIST.has(toolId)) {
        check(10, 'critical', 'PLATFORM_TOOL_NOT_ALLOWED',
          `usesPlatformTools declares "${toolId}" which is not in the platform tool whitelist ` +
          `(L1 数据生成 / L2 连接器只读 / L3 界面控制；shell/文件/凭据类永不放行)`);
      }
    }

    // ── Check 10.6: 首方能力门控（appstore:* / mcpExposed 仅首方 appId 可声明）──
    const isFirstParty = /^com\.(jianzhi|menhu)\./.test(manifest.appId);
    const devCaps = (manifest.platformCapabilities ?? []).filter(c => c.startsWith('appstore:'));
    if (devCaps.length > 0 && !isFirstParty) {
      check(10, 'critical', 'DEV_CAP_NOT_FIRST_PARTY',
        `platformCapabilities ${devCaps.join(', ')} requires a first-party appId (com.jianzhi.* / com.menhu.*), got "${manifest.appId}"`);
    }
    const mcpExposedProviders = (manifest.backend?.toolProviders ?? []).filter(tp => tp.mcpExposed);
    if (mcpExposedProviders.length > 0 && !isFirstParty) {
      check(10, 'critical', 'MCP_EXPOSE_NOT_FIRST_PARTY',
        `mcpExposed requires a first-party appId (com.jianzhi.* / com.menhu.*), got "${manifest.appId}"`);
    }

    // ── Check 11: Agent tool reference consistency ──
    const agentsDir = path.join(extractDir, 'agents');
    if (fs.existsSync(agentsDir)) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const yaml = require('js-yaml');
      const yamlFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
      for (const yf of yamlFiles) {
        try {
          const raw = yaml.load(fs.readFileSync(path.join(agentsDir, yf), 'utf-8')) as any;
          const agentDef = raw?.agent || raw;
          const tools: string[] = agentDef?.tools ?? [];
          for (const tool of tools) {
            if (tool.startsWith(`${nsPrefix}_`) && !allToolIds.includes(tool)) {
              check(11, 'critical', 'AGENT_TOOL_NOT_DECLARED',
                `Agent "${agentDef.id}" references tool "${tool}" which is not declared in manifest toolProviders`);
            }
          }
        } catch (err: any) {
          check(11, 'critical', 'AGENT_YAML_PARSE_ERROR',
            `Failed to parse agent YAML ${yf}: ${err.message}`);
        }
      }
    }

    // ── Check 12: Migration files parseable + no CONCURRENTLY ──
    const migrationsDir = path.join(extractDir, 'migrations');
    const migrationEntries = manifest.migrations ?? [];
    const expectedVersions = Array.from({ length: migrationEntries.length }, (_, i) => i + 1);
    const actualVersions = migrationEntries.map(m => m.version).sort((a, b) => a - b);
    if (JSON.stringify(expectedVersions) !== JSON.stringify(actualVersions)) {
      check(12, 'critical', 'MIGRATION_VERSION_GAP',
        `Migration versions must start at 1 and be consecutive. Found: ${actualVersions.join(', ')}`);
    }
    for (const entry of migrationEntries) {
      const filePath = path.join(extractDir, entry.file);
      if (!fs.existsSync(filePath)) {
        check(12, 'critical', 'MIGRATION_FILE_MISSING', `Migration file ${entry.file} not found`);
        continue;
      }
      const sql = fs.readFileSync(filePath, 'utf-8');
      if (/CREATE\s+INDEX\s+CONCURRENTLY/i.test(sql)) {
        check(12, 'critical', 'MIGRATION_CONCURRENTLY',
          `Migration ${entry.file} uses CREATE INDEX CONCURRENTLY, which cannot run inside a transaction. Use CREATE INDEX instead.`);
      }
      if (entry.down) {
        const downPath = path.join(extractDir, entry.down);
        if (!fs.existsSync(downPath)) {
          check(12, 'critical', 'MIGRATION_DOWN_MISSING',
            `Down migration ${entry.down} declared but file not found`);
        }
      }
    }

    // ── Check 13: Sensitive information (WARNING) ──
    const sensitiveFiles = [
      ...this.listAllFiles(path.join(extractDir, 'dist')).filter(f => f.endsWith('.js')),
      ...this.listAllFiles(migrationsDir).filter(f => f.endsWith('.sql')),
      ...this.listAllFiles(path.join(extractDir, 'skills')).filter(f => f.endsWith('.ts') || f.endsWith('.js')),
    ].filter(f => fs.existsSync(f));

    for (const file of sensitiveFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(content)) {
          check(13, 'warning', 'SENSITIVE_DATA_FOUND',
            `File ${path.relative(extractDir, file)} may contain hardcoded credentials. Use configSchema "secret" fields instead.`);
          break;
        }
      }
    }

    // ── Check 14: Documentation completeness (WARNING) ──
    const readmePath = path.join(extractDir, 'README.md');
    if (!fs.existsSync(readmePath) || fs.readFileSync(readmePath, 'utf-8').length < 200) {
      check(14, 'warning', 'MISSING_README', 'README.md is missing or too short (< 200 chars)');
    }
    for (const panel of manifest.panels ?? []) {
      if (!panel.icon) {
        check(14, 'warning', 'PANEL_MISSING_ICON', `Panel "${panel.id}" has no icon`);
      }
    }

    // ── Check 15: globalThis writes (WARNING) ──
    // 扩展包与平台同进程运行，写 globalThis 会造成跨包/跨平台污染。
    // 实例：pdfjs fake-worker 写 globalThis.pdfjsWorker，dimension-tuner 内嵌的
    // pdfjs-dist@4.x 曾因此污染平台 OcrService 的 pdfjs@5.x（worker 版本错配）。
    // `delete globalThis.X` 是清场操作，不在此列。
    const GLOBAL_WRITE_PATTERNS = [
      /\bglobalThis\s*\.\s*[A-Za-z_$][\w$]*\s*=(?![=])/g,
      /\bglobalThis\s*\[\s*['"][^'"]+['"]\s*\]\s*=(?![=])/g,
    ];
    const scanDirs15 = [
      path.join(extractDir, 'dist'),
      path.join(extractDir, 'skills'),
    ].filter(d => fs.existsSync(d));

    for (const scanDir of scanDirs15) {
      const jsFiles = this.listAllFiles(scanDir).filter(f => f.endsWith('.js') || f.endsWith('.ts'));
      for (const file of jsFiles) {
        const content = fs.readFileSync(file, 'utf-8');
        for (const pattern of GLOBAL_WRITE_PATTERNS) {
          pattern.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = pattern.exec(content)) !== null) {
            // 排除 delete 操作（允许防御性清场）
            const before = content.slice(Math.max(0, m.index - 12), m.index);
            if (/\bdelete\s*$/.test(before)) continue;
            check(15, 'warning', 'GLOBAL_THIS_WRITE',
              `File ${path.relative(extractDir, file)} writes to globalThis ("${m[0].trim()}"). `
              + `Packages share the process with the platform — global writes can poison other apps. `
              + `Clean up after use (delete globalThis.X) or avoid global state.`,
              m[0].trim());
          }
        }
      }
    }

    // 已知坏味道标记（含 node_modules 内嵌第三方库）：pdfjs fake-worker 全局污染。
    // 任何版本的 pdfjs-dist 被包内嵌时都会在加载 worker 后写 globalThis.pdfjsWorker，
    // 与平台或其他包的 pdfjs 版本冲突。披露为 warning，要求包在使用后清场。
    const nmDir = path.join(extractDir, 'node_modules');
    if (fs.existsSync(nmDir)) {
      const nmJsFiles = this.listAllFiles(nmDir).filter(f => f.endsWith('.js') || f.endsWith('.mjs'));
      for (const file of nmJsFiles) {
        try {
          const content = fs.readFileSync(file, 'utf-8');
          if (/\bglobalThis\s*\.\s*pdfjsWorker\s*=/.test(content)) {
            check(15, 'warning', 'GLOBAL_THIS_WRITE_KNOWN_BAD',
              `Bundled dependency writes globalThis.pdfjsWorker: ${path.relative(extractDir, file)}. `
              + `This is the pdfjs fake-worker mechanism — it WILL conflict with other pdfjs copies in the process. `
              + `Ensure package code deletes globalThis.pdfjsWorker after each getDocument() call.`,
              path.relative(extractDir, file));
            break; // 一次即可，不刷屏
          }
        } catch { /* skip unreadable */ }
      }
    }

    return this.buildReport(results, manifest.appId);
  }

  private buildReport(results: CheckResult[], appId?: string): ValidationReport {
    const criticals = results.filter(r => r.level === 'critical');
    const warnings = results.filter(r => r.level === 'warning');
    return {
      appId,
      passed: criticals.length === 0,
      criticals,
      warnings,
      all: results,
    };
  }

  private listAllFiles(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const results: string[] = [];
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else results.push(full);
      }
    };
    walk(dir);
    return results;
  }

  /** Compute sha256 hash of a file */
  hashFile(filePath: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }
}
