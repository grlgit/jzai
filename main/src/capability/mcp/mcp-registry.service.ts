import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { WorkspaceService } from '../../workspace/workspace.service';
import { ConnectorPermissions, ConnectorStatus } from '../tool/tool-registry.service';
import { McpHttpClient } from './mcp-http-client';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: any;
  outputSchema?: any;
}

export interface AuthFieldDef {
  key: string;
  label: string;
  type?: string;       // 'password' | 'text' (default 'text')
  required?: boolean;
}

export interface McpServerDef {
  name: string;
  system: string;
  description: string;
  tools: McpToolDef[];
  llmHint?: string;
  handlerCode?: string;
  authSystem?: string;        // auth.system from manifest — maps to CredentialService system name
  authScope?: 'global' | 'user'; // auth.scope from manifest — credential resolution scope
  authFields?: AuthFieldDef[]; // auth.fields from manifest — credential form schema
  dirName: string;
  enabled: boolean;
  permissions: ConnectorPermissions;
  status: ConnectorStatus;
}

@Injectable()
export class McpRegistryService {
  private readonly logger = new Logger(McpRegistryService.name);
  private readonly mcpDir: string;
  private servers = new Map<string, McpServerDef>();
  private readonly changeListeners = new Set<(name?: string) => void>();

  constructor(private readonly workspace: WorkspaceService) {
    this.mcpDir = path.join(this.workspace.getConfigDir(), 'mcp');
    this.loadAll();
  }

  loadAll() {
    McpHttpClient.clearAllSessions();
    this.servers.clear();
    if (!fs.existsSync(this.mcpDir)) {
      fs.mkdirSync(this.mcpDir, { recursive: true });
      this.emitChange();
      return;
    }

    const dirs = fs.readdirSync(this.mcpDir, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.'));
    for (const dir of dirs) {
      const manifestPath = path.join(this.mcpDir, dir.name, 'manifest.yaml');
      if (!fs.existsSync(manifestPath)) continue;
      try {
        const raw = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as any;
        const m = raw.mcp || raw;
        let handlerPath = path.join(this.mcpDir, dir.name, 'handler.ts');
        if (!fs.existsSync(handlerPath)) handlerPath = path.join(this.mcpDir, dir.name, 'mcp-server.ts');
        const auth = m.auth || {};
        const authFields: AuthFieldDef[] | undefined = Array.isArray(auth.fields)
          ? auth.fields.map((f: any) => ({ key: f.key, label: f.label || f.key, type: f.type, required: f.required }))
          : undefined;
        const def: McpServerDef = {
          name: m.name || dir.name,
          system: m.system || '',
          description: m.description || '',
          tools: (m.tools || []).map((t: any) => ({
            name: t.name,
            description: t.description || '',
            inputSchema: t.inputSchema || t.parameters || {},
            outputSchema: t.outputSchema,
          })),
          llmHint: m.llm_hint || m.llmHint || undefined,
          handlerCode: fs.existsSync(handlerPath) ? fs.readFileSync(handlerPath, 'utf-8') : undefined,
          authSystem: auth.system || undefined,
          authScope: auth.scope === 'global' ? 'global' : undefined,
          authFields,
          dirName: dir.name,
          enabled: m.enabled !== false,
          permissions: m.permissions || {},
          status: {
            loaded: true,
            phase: ((m.tools || []).length > 0 && fs.existsSync(handlerPath)) ? 'available' : 'building',
          },
        };
        this.servers.set(def.name, def);
        this.logger.log(`Loaded MCP server: ${def.name} (${def.tools.length} tools, enabled=${def.enabled})`);
      } catch (err: any) {
        this.logger.error(`Failed to load MCP ${dir.name}: ${err.message}`);
        // Move broken MCP to .broken/ to prevent repeated load errors
        const brokenDir = path.join(this.mcpDir, '.broken');
        if (!fs.existsSync(brokenDir)) fs.mkdirSync(brokenDir, { recursive: true });
        const srcDir = path.join(this.mcpDir, dir.name);
        const destDir = path.join(brokenDir, `${dir.name}_${Date.now()}`);
        try { fs.renameSync(srcDir, destDir); this.logger.warn(`Moved broken MCP to ${destDir}`); } catch {}
      }
    }
    this.logger.log(`Total: ${this.servers.size} MCP servers loaded`);
    this.emitChange();
  }

  getBaseDir(): string { return this.mcpDir; }
  getAll(): McpServerDef[] { return Array.from(this.servers.values()); }
  getEnabled(): McpServerDef[] { return this.getAll().filter(m => m.enabled); }
  get(name: string): McpServerDef | undefined { return this.servers.get(name); }

  onChange(listener: (name?: string) => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  private emitChange(name?: string): void {
    for (const listener of this.changeListeners) listener(name);
  }

  enable(name: string): boolean { return this.setEnabled(name, true); }
  disable(name: string): boolean { return this.setEnabled(name, false); }

  private setEnabled(name: string, enabled: boolean): boolean {
    const server = this.servers.get(name);
    if (!server) return false;
    server.enabled = enabled;
    this.saveYaml(server);
    McpHttpClient.clearConnectionSessions(name);
    this.emitChange(name);
    return true;
  }

  setLlmHint(name: string, hint: string): boolean {
    const server = this.servers.get(name);
    if (!server) return false;
    server.llmHint = hint || undefined;
    const manifestPath = path.join(this.mcpDir, server.dirName, 'manifest.yaml');
    if (fs.existsSync(manifestPath)) {
      try {
        const raw = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as any;
        const m = raw.mcp || raw;
        m.llm_hint = hint || undefined;
        fs.writeFileSync(manifestPath, yaml.dump(raw.mcp ? raw : { mcp: m }, { lineWidth: 120 }), 'utf-8');
      } catch { /* ignore */ }
    }
    this.emitChange(name);
    return true;
  }

  setPermissions(name: string, perms: ConnectorPermissions): boolean {
    const server = this.servers.get(name);
    if (!server) return false;
    server.permissions = perms;
    this.saveYaml(server);
    McpHttpClient.clearConnectionSessions(name);
    this.emitChange(name);
    return true;
  }

  markUsed(name: string) {
    const server = this.servers.get(name);
    if (server) server.status.lastUsed = new Date().toISOString();
  }

  isAllowedForUser(
    name: string,
    userId?: string,
    roleIds: string | readonly string[] = [],
  ): boolean {
    const server = this.servers.get(name);
    if (!server || !server.enabled) return false;
    const p = server.permissions;
    if (!p.allowedRoles?.length && !p.allowedUsers?.length) return true;
    if (userId && p.allowedUsers?.includes(userId)) return true;
    const roles = typeof roleIds === 'string' ? [roleIds] : roleIds;
    return roles.some(roleId => p.allowedRoles?.includes(roleId));
  }

  /** Delete an MCP server: move files to .deleted/ and remove from memory */
  delete(name: string): { success: boolean } {
    const server = this.servers.get(name);
    if (!server) return { success: false };

    // Move directory to .deleted/{name}_{timestamp} instead of hard delete
    const srcDir = path.join(this.mcpDir, server.dirName);
    const deletedDir = path.join(this.mcpDir, '.deleted');
    if (!fs.existsSync(deletedDir)) fs.mkdirSync(deletedDir, { recursive: true });
    const destDir = path.join(deletedDir, `${server.dirName}_${Date.now()}`);

    if (fs.existsSync(srcDir)) {
      fs.renameSync(srcDir, destDir);
      this.logger.log(`MCP files moved: ${srcDir} → ${destDir}`);
    }

    // Remove from memory
    this.servers.delete(name);
    McpHttpClient.clearConnectionSessions(name);
    this.emitChange(name);
    this.logger.log(`MCP deleted: ${name}`);

    return { success: true };
  }

  /** List deleted MCP servers from .deleted/ directory */
  listDeleted(): { dirName: string; originalName: string; deletedAt: string; manifest?: any }[] {
    const deletedDir = path.join(this.mcpDir, '.deleted');
    if (!fs.existsSync(deletedDir)) return [];

    const results: { dirName: string; originalName: string; deletedAt: string; manifest?: any }[] = [];
    const dirs = fs.readdirSync(deletedDir, { withFileTypes: true }).filter(d => d.isDirectory());

    for (const dir of dirs) {
      // Parse dirName format: {originalName}_{timestamp}
      const match = dir.name.match(/^(.+)_(\d+)$/);
      if (!match) continue;

      const originalName = match[1];
      const deletedAt = new Date(parseInt(match[2])).toISOString();

      // Try to read manifest for display info
      let manifest: any = undefined;
      const manifestPath = path.join(deletedDir, dir.name, 'manifest.yaml');
      if (fs.existsSync(manifestPath)) {
        try {
          const raw = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as any;
          const m = raw.mcp || raw;
          manifest = { name: m.name, system: m.system, description: m.description, toolCount: (m.tools || []).length };
        } catch { /* ignore parse errors */ }
      }

      results.push({ dirName: dir.name, originalName, deletedAt, manifest });
    }

    return results.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  /** Restore a deleted MCP server from .deleted/ back to active */
  restore(dirName: string): { success: boolean; name?: string; error?: string } {
    const deletedDir = path.join(this.mcpDir, '.deleted');
    const srcDir = path.join(deletedDir, dirName);

    if (!fs.existsSync(srcDir)) return { success: false, error: '未找到该已删除项' };

    // Parse original name from dirName format: {originalName}_{timestamp}
    const match = dirName.match(/^(.+)_(\d+)$/);
    if (!match) return { success: false, error: '目录名格式异常' };
    const originalName = match[1];

    // Check if same name already exists (active)
    const destDir = path.join(this.mcpDir, originalName);
    if (fs.existsSync(destDir)) {
      return { success: false, error: `同名 MCP "${originalName}" 已存在，请先删除或重命名现有的` };
    }

    // Move back
    fs.renameSync(srcDir, destDir);
    this.logger.log(`MCP restored: ${srcDir} → ${destDir}`);

    // Reload to pick up restored server
    this.loadAll();

    return { success: true, name: originalName };
  }

  /** Permanently remove a deleted MCP (empty from recycle bin) */
  purge(dirName: string): { success: boolean } {
    const deletedDir = path.join(this.mcpDir, '.deleted');
    const targetDir = path.join(deletedDir, dirName);
    if (!fs.existsSync(targetDir)) return { success: false };

    fs.rmSync(targetDir, { recursive: true });
    this.logger.log(`MCP purged permanently: ${dirName}`);
    return { success: true };
  }

  getManifestYaml(name: string): string | null {
    const server = this.servers.get(name);
    if (!server) return null;
    const manifestPath = path.join(this.mcpDir, server.dirName, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) return null;
    return fs.readFileSync(manifestPath, 'utf-8');
  }

  getHandler(name: string): string | null {
    const server = this.servers.get(name);
    if (!server) return null;
    let p = path.join(this.mcpDir, server.dirName, 'handler.ts');
    if (!fs.existsSync(p)) p = path.join(this.mcpDir, server.dirName, 'mcp-server.ts');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
  }

  saveHandler(name: string, code: string): boolean {
    const server = this.servers.get(name);
    if (!server) return false;
    let p = path.join(this.mcpDir, server.dirName, 'handler.ts');
    if (!fs.existsSync(p)) p = path.join(this.mcpDir, server.dirName, 'mcp-server.ts');
    fs.writeFileSync(p, code, 'utf-8');
    server.handlerCode = code;
    McpHttpClient.clearConnectionSessions(name);
    this.emitChange(name);
    return true;
  }

  register(content: string): { success: boolean; name?: string; names?: string[]; error?: string } {
    try {
      const parsed = this.parseContent(content);
      if (!parsed) return { success: false, error: '无法解析内容，请提供 YAML manifest 或 JSON mcpServers 配置' };

      // If it's a mcpServers JSON config (Claude Desktop format), register each server
      if (parsed.type === 'mcpServers') {
        const names: string[] = [];
        for (const [name, cfg] of Object.entries(parsed.servers as Record<string, any>)) {
          const manifest = this.mcpServerToManifest(name, cfg);
          this.writeAndLoad(name, yaml.dump({ mcp: manifest }));
          names.push(name);
        }
        this.loadAll();
        this.logger.log(`Registered ${names.length} MCP servers from mcpServers config: ${names.join(', ')}`);
        return { success: true, names, name: names[0] };
      }

      // Standard YAML manifest
      const m = parsed.manifest;
      const name = m.name;
      if (!name) return { success: false, error: 'manifest 缺少 name 字段' };

      this.writeAndLoad(name, content);
      this.loadAll();
      this.logger.log(`Registered MCP: ${name}`);
      return { success: true, name };
    } catch (err: any) {
      return { success: false, error: `解析失败: ${err.message}` };
    }
  }

  /** Parse input content: detect YAML manifest vs JSON mcpServers config */
  private parseContent(content: string): { type: 'manifest'; manifest: any } | { type: 'mcpServers'; servers: any } | null {
    const trimmed = content.trim();

    // Try JSON first (mcpServers format)
    if (trimmed.startsWith('{')) {
      try {
        const json = JSON.parse(trimmed);
        if (json.mcpServers && typeof json.mcpServers === 'object') {
          return { type: 'mcpServers', servers: json.mcpServers };
        }
        // Maybe it's a single server config without wrapper
        if (json.command || json.url) {
          return null; // needs a name, can't register standalone
        }
      } catch { /* not valid JSON, try YAML */ }
    }

    // Try YAML manifest
    try {
      const raw = yaml.load(trimmed) as any;
      if (!raw || typeof raw !== 'object') return null;
      const m = raw.mcp || raw;
      if (m.name) return { type: 'manifest', manifest: m };
      // Maybe it's mcpServers in YAML
      if (m.mcpServers) return { type: 'mcpServers', servers: m.mcpServers };
    } catch { /* not valid YAML */ }

    return null;
  }

  /** Convert a Claude Desktop style mcpServer entry to our manifest format */
  private mcpServerToManifest(name: string, cfg: any): any {
    return {
      name,
      system: name,
      description: `MCP Server: ${name} (${cfg.command || cfg.url || 'unknown'})`,
      transport: cfg.url ? { type: 'sse', url: cfg.url } : {
        type: 'stdio',
        command: cfg.command,
        args: cfg.args || [],
        env: cfg.env || {},
      },
      tools: [],
      enabled: true,
    };
  }

  private writeAndLoad(name: string, yamlContent: string) {
    const dirPath = path.join(this.mcpDir, name);
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'manifest.yaml'), yamlContent, 'utf-8');
  }

  /** Get schema cache status for a DB MCP */
  getSchemaStatus(name: string): { cached: boolean; total?: number; updated?: string } | null {
    const server = this.servers.get(name);
    if (!server) return null;
    const indexPath = path.join(this.mcpDir, server.dirName, 'schema', '_index.json');
    if (!fs.existsSync(indexPath)) return { cached: false };
    try {
      const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      return { cached: true, total: idx.total, updated: idx.updated };
    } catch { return { cached: false }; }
  }

  /** Generate / refresh schema cache for a DB MCP. Caller provides credentials. */
  async refreshSchema(name: string, creds: Record<string, string>): Promise<{ success: boolean; total?: number; error?: string }> {
    const server = this.servers.get(name);
    if (!server) return { success: false, error: `MCP "${name}" 不存在` };

    const dbType = creds.db_type || 'postgresql';
    const port = parseInt(creds.port) || (dbType === 'mysql' ? 3306 : dbType === 'mssql' ? 1433 : 5432);
    const schemaDir = path.join(this.mcpDir, server.dirName, 'schema');

    // Clear old cache
    if (fs.existsSync(schemaDir)) fs.rmSync(schemaDir, { recursive: true });
    fs.mkdirSync(schemaDir, { recursive: true });

    try {
      // Bulk fetch all metadata (3 queries instead of N*2)
      let allTables: { name: string; comment: string; columns: any[]; foreignKeys: any[] }[] = [];

      if (dbType === 'postgresql') {
        const { Pool } = require('pg');
        const pool = new Pool({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 15000, statement_timeout: 60000 });
        try {
          const schemaName = creds.schema_name || 'public';
          const tabRes = await pool.query(`SELECT t.table_name, obj_description(c.oid) AS comment FROM information_schema.tables t LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' ORDER BY t.table_name`, [schemaName]);
          const colRes = await pool.query(`SELECT c.table_name, c.column_name, c.data_type, c.character_maximum_length AS max_length, c.is_nullable, c.column_default, col_description((SELECT oid FROM pg_class WHERE relname = c.table_name AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)), c.ordinal_position) AS comment FROM information_schema.columns c WHERE c.table_schema = $1 ORDER BY c.table_name, c.ordinal_position`, [schemaName]);
          const fkRes = await pool.query(`SELECT tc.table_name, kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`, [schemaName]);
          allTables = this.groupSchemaData(tabRes.rows, colRes.rows, fkRes.rows);
        } finally { await pool.end(); }
      } else if (dbType === 'mysql') {
        const mysql = require('mysql2/promise');
        const conn = await mysql.createConnection({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : undefined, connectTimeout: 15000 });
        try {
          const dbName = creds.schema_name || creds.database;
          const [tabRows] = await conn.query(`SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [dbName]);
          const [colRows] = await conn.query(`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, DATA_TYPE AS data_type, CHARACTER_MAXIMUM_LENGTH AS max_length, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, COLUMN_COMMENT AS comment, COLUMN_KEY AS column_key FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, [dbName]);
          const [fkRows] = await conn.query(`SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`, [dbName]);
          allTables = this.groupSchemaData(tabRows as any[], colRows as any[], fkRows as any[]);
        } finally { await conn.end(); }
      } else if (dbType === 'mssql') {
        const sql = require('mssql');
        const pool = await sql.connect({ server: creds.host, port, database: creds.database, user: creds.username, password: creds.password, options: { encrypt: creds.ssl === 'true', trustServerCertificate: true }, connectionTimeout: 15000, requestTimeout: 60000 });
        try {
          const tabRes = await pool.request().query(`SELECT t.name AS table_name, ep.value AS comment FROM sys.tables t LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' ORDER BY t.name`);
          const colRes = await pool.request().query(`SELECT OBJECT_NAME(c.object_id) AS table_name, c.name AS column_name, TYPE_NAME(c.user_type_id) AS data_type, c.max_length, CASE c.is_nullable WHEN 1 THEN 'YES' ELSE 'NO' END AS is_nullable, dc.definition AS column_default, ep.value AS comment, CASE WHEN pk.column_id IS NOT NULL THEN 'PRI' ELSE '' END AS column_key FROM sys.columns c JOIN sys.tables t ON t.object_id = c.object_id LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id WHERE i.is_primary_key = 1) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id ORDER BY t.name, c.column_id`);
          const fkRes = await pool.request().query(`SELECT OBJECT_NAME(fkc.parent_object_id) AS table_name, COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name, OBJECT_NAME(fkc.referenced_object_id) AS ref_table, COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column FROM sys.foreign_key_columns fkc`);
          allTables = this.groupSchemaData(tabRes.recordset, colRes.recordset, fkRes.recordset);
        } finally { await pool.close(); }
      }

      // Write per-table MD files + index
      const now = new Date().toISOString();
      for (const table of allTables) {
        const keywords = [
          ...table.columns.map((c: any) => c.column_name),
          ...table.columns.map((c: any) => c.comment).filter(Boolean),
          table.comment,
        ].filter(Boolean).join(',');

        const frontmatter = [
          '---',
          `table: ${table.name}`,
          `comment: "${(table.comment || '').replace(/"/g, '\\"')}"`,
          `columns: ${table.columns.length}`,
          `updated: "${now}"`,
          `keywords: "${keywords.replace(/"/g, '\\"')}"`,
          '---',
        ].join('\n');

        const header = `## ${table.name}${table.comment ? ' (' + table.comment + ')' : ''}`;
        const colHeader = '| 字段 | 类型 | 可空 | 键 | 说明 |\n|------|------|------|-----|------|';
        const colRows = table.columns.map((c: any) =>
          `| ${c.column_name} | ${c.data_type}${c.max_length ? '(' + c.max_length + ')' : ''} | ${c.is_nullable} | ${c.column_key || ''} | ${c.comment || ''} |`
        ).join('\n');
        const fkSection = table.foreignKeys.length > 0
          ? '\n\n### 外键\n' + table.foreignKeys.map((fk: any) => `- ${fk.column_name} → ${fk.ref_table}.${fk.ref_column}`).join('\n')
          : '';

        const md = `${frontmatter}\n${header}\n\n${colHeader}\n${colRows}${fkSection}\n`;
        // Sanitize filename (replace special chars)
        const safeName = table.name.replace(/[\/\\:*?"<>|]/g, '_');
        fs.writeFileSync(path.join(schemaDir, `${safeName}.md`), md, 'utf-8');
      }

      // Write index
      const index = {
        total: allTables.length,
        updated: now,
        db_type: dbType,
        database: creds.database,
        tables: allTables.map(t => ({ name: t.name, comment: t.comment || '', columns: t.columns.length })),
      };
      fs.writeFileSync(path.join(schemaDir, '_index.json'), JSON.stringify(index, null, 2), 'utf-8');

      // Update llm_hint
      this.setLlmHint(name,
        `工作流：先调用 search_db_schema 搜索本地缓存（按关键词），找到表后用 execute_query 执行SQL。\n若缓存不存在，提示用户到连接面板刷新结构。\n仅支持 SELECT 查询，结果限 1000 行。\n缓存含 ${allTables.length} 张表，更新于 ${now}。`
      );

      this.logger.log(`Schema cache generated for ${name}: ${allTables.length} tables`);
      return { success: true, total: allTables.length };
    } catch (err: any) {
      // Clean up partial cache
      if (fs.existsSync(schemaDir)) fs.rmSync(schemaDir, { recursive: true });
      this.logger.error(`Schema cache failed for ${name}: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /** Group bulk query results into per-table structures */
  private groupSchemaData(
    tables: { table_name: string; comment?: string }[],
    columns: { table_name: string; [k: string]: any }[],
    foreignKeys: { table_name: string; column_name: string; ref_table: string; ref_column: string }[],
  ) {
    const colMap = new Map<string, any[]>();
    for (const c of columns) {
      if (!colMap.has(c.table_name)) colMap.set(c.table_name, []);
      colMap.get(c.table_name)!.push(c);
    }
    const fkMap = new Map<string, any[]>();
    for (const fk of foreignKeys) {
      if (!fkMap.has(fk.table_name)) fkMap.set(fk.table_name, []);
      fkMap.get(fk.table_name)!.push(fk);
    }
    return tables.map(t => ({
      name: t.table_name,
      comment: t.comment || '',
      columns: colMap.get(t.table_name) || [],
      foreignKeys: fkMap.get(t.table_name) || [],
    }));
  }

  private saveYaml(server: McpServerDef) {
    const manifestPath = path.join(this.mcpDir, server.dirName, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) return;
    try {
      const raw = yaml.load(fs.readFileSync(manifestPath, 'utf-8')) as any;
      const m = raw.mcp || raw;
      m.enabled = server.enabled;
      m.permissions = Object.keys(server.permissions).length > 0 ? server.permissions : undefined;
      fs.writeFileSync(manifestPath, yaml.dump(raw.mcp ? raw : { mcp: m }), 'utf-8');
    } catch { /* ignore save errors */ }
  }
}
