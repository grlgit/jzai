import { Injectable, Logger } from '@nestjs/common';
import { ToolProvider, ToolContext, ToolInstance, ToolCatalogEntry } from '../../agent/tool-bridge/tool-provider.interface';
import { McpRegistryService } from '../../capability/mcp/mcp-registry.service';
import { CredentialService } from '../../capability/skill/credential.service';
import { ConfirmationBridgeService } from '../../agent/support/confirmation-bridge.service';
import { validateNameForTool } from '../../utils/tool-name.validator';

@Injectable()
export class DatabaseToolProvider implements ToolProvider {
  private readonly logger = new Logger(DatabaseToolProvider.name);

  readonly toolIds = ['save_db_connection', 'test_db_connection', 'discover_db_schema', 'search_db_schema'];

  constructor(
    private readonly mcpRegistry: McpRegistryService,
    private readonly credentialService: CredentialService,
    private readonly confirmBridge: ConfirmationBridgeService,
  ) {}

  getCatalog(): ToolCatalogEntry[] {
    return [
      { id: 'save_db_connection', label: '保存数据库连接', group: '数据库' },
      { id: 'test_db_connection', label: '测试数据库连接', group: '数据库' },
      { id: 'discover_db_schema', label: '发现数据库结构', group: '数据库' },
      { id: 'search_db_schema', label: '搜索数据库结构', group: '数据库' },
    ];
  }

  async createTools(ctx: ToolContext): Promise<ToolInstance[]> {
    const Type = ctx.piAi?.Type;
    if (!Type) return [];

    return [
      this.buildSaveDbConnection(Type),
      this.buildTestDbConnection(Type),
      this.buildDiscoverDbSchema(Type),
      this.buildSearchDbSchema(Type),
    ];
  }

  // ===== save_db_connection =====
  private buildSaveDbConnection(Type: any): ToolInstance {
    return {
      name: 'save_db_connection',
      label: '保存数据库连接',
      description: '保存数据库连接信息。调用时弹出确认表单供用户核对。请将已知的连接信息传入参数，缺失的留空由用户在表单中补充。',
      parameters: Type.Object({
        connection_name: Type.Optional(Type.String({ description: '连接名称' })),
        description: Type.Optional(Type.String({ description: '数据库用途说明（如"MOM生产管理系统"）' })),
        db_type: Type.Optional(Type.String({ description: '数据库类型: postgresql / mysql / mssql' })),
        host: Type.Optional(Type.String({ description: '数据库地址' })),
        port: Type.Optional(Type.String({ description: '端口号' })),
        database: Type.Optional(Type.String({ description: '数据库名' })),
        username: Type.Optional(Type.String({ description: '用户名' })),
        password: Type.Optional(Type.String({ description: '密码' })),
      }),
      execute: async (_id: string, args: any) => {
        // Confirm gate: show form for user to fill/verify DB connection details
        try {
          const editedArgs = await this.confirmBridge.requestConfirmation({
            confirmId: `save_db_connection_${Date.now()}`,
            toolName: 'save_db_connection',
            args,
            parameters: [
              { name: 'connection_name', type: 'string', required: true, description: '连接名称' },
              { name: 'description', type: 'string', required: false, description: '数据库用途说明' },
              { name: 'db_type', type: 'string', required: true, description: '数据库类型' },
              { name: 'host', type: 'string', required: true, description: '地址' },
              { name: 'port', type: 'string', required: true, description: '端口' },
              { name: 'database', type: 'string', required: true, description: '数据库名' },
              { name: 'username', type: 'string', required: true, description: '账号' },
              { name: 'password', type: 'string', required: true, description: '密码' },
            ],
            confirmForm: [
              { key: 'connection_name', label: '连接名称', type: 'string', required: true },
              { key: 'description', label: '用途说明（如"MOM生产管理系统"）', type: 'string', required: false },
              { key: 'db_type', label: '数据库类型 (postgresql/mysql/mssql)', type: 'string', required: true, default: 'postgresql' },
              { key: 'host', label: '数据库地址', type: 'string', required: true },
              { key: 'port', label: '端口', type: 'string', required: true },
              { key: 'database', label: '数据库名', type: 'string', required: true },
              { key: 'username', label: '账号', type: 'string', required: true },
              { key: 'password', label: '密码', type: 'password', required: true },
            ],
            description: '请填写数据库连接信息',
          });
          args = editedArgs;
        } catch (err: any) {
          const cancelled = err.message === 'user_cancelled';
          return { content: [{ type: 'text' as const, text: cancelled ? '已取消数据库连接配置。' : '配置超时，操作已取消。' }], details: null };
        }
        try {
          args.display_name = args.display_name || args.connection_name;
          // 验证连接名称是否符合工具命名规范
          try {
            validateNameForTool(args.connection_name, 'mcp_db-');
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `❌ ${err.message}` }], details: null };
          }
          const systemName = `db-${args.connection_name}`;
          // Duplicate name check: refuse if same-named MCP already exists
          const existing = this.mcpRegistry.get(systemName);
          if (existing) {
            return { content: [{ type: 'text' as const, text: `❌ 同名连接 "${systemName}" 已存在。请先在"连接"面板中删除旧连接，或使用其他名称。` }], details: null };
          }
          this.credentialService.saveGlobalCredentials(systemName, {
            db_type: args.db_type, host: args.host, port: args.port,
            database: args.database, username: args.username, password: args.password,
            ssl: args.ssl || 'false', display_name: args.display_name,
          });
          // Use McpRegistryService's base path (aligned with WORKSPACE_ROOT)
          const fs = require('fs');
          const path = require('path');
          const yaml = require('js-yaml');
          const mcpBaseDir = this.mcpRegistry.getBaseDir();
          const mcpDir = path.join(mcpBaseDir, systemName);
          if (fs.existsSync(mcpDir)) fs.rmSync(mcpDir, { recursive: true });
          fs.mkdirSync(mcpDir, { recursive: true });
          // Auto-generate manifest template with correct auth section
          const dbDescription = args.description || `${args.display_name} 数据库查询工具 (${args.db_type})`;
          const manifestTemplate = {
            mcp: {
              name: systemName,
              system: `${args.display_name} 数据库`,
              description: dbDescription,
              llm_hint: `工作流：先调用 search_db_schema 搜索本地缓存（按关键词），找到表后用 execute_query 执行SQL。\n若缓存不存在，提示用户到连接面板刷新结构。\n仅支持 SELECT 查询，结果限 1000 行。`,
              auth: {
                system: systemName,
                scope: 'global',
                fields: [
                  { key: 'host', label: '数据库地址', required: true },
                  { key: 'port', label: '端口', required: true },
                  { key: 'database', label: '数据库名', required: true },
                  { key: 'username', label: '用户名', required: true },
                  { key: 'password', label: '密码', type: 'password', required: true },
                ],
              },
              tools: [
                { name: 'list_tables', description: '列出数据库中的所有表及其描述', inputSchema: { type: 'object', properties: { schema_name: { type: 'string', description: 'Schema名称' } }, required: [] } },
                { name: 'describe_table', description: '获取指定表的字段结构、类型和关系', inputSchema: { type: 'object', properties: { table_names: { type: 'string', description: '表名，多个用逗号分隔' } }, required: ['table_names'] } },
                { name: 'execute_query', description: '执行只读SQL查询（仅SELECT）', inputSchema: { type: 'object', properties: { sql: { type: 'string', description: 'SQL查询语句' }, params: { type: 'string', description: '参数化查询参数，JSON数组' } }, required: ['sql'] } },
              ],
            },
          };
          const manifestPath = path.join(mcpDir, 'manifest.yaml');
          fs.writeFileSync(manifestPath, yaml.dump(manifestTemplate, { lineWidth: 120 }), 'utf-8');

          // Auto-generate handler.ts based on db_type
          const dbDriverMap: Record<string, { require: string; connect: string; query: string; close: string; listTables: string; describeTable: string }> = {
            postgresql: {
              require: `var { Pool } = require('pg');`,
              connect: `var pool = new Pool({ host: creds.host, port: parseInt(creds.port) || 5432, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000 });`,
              query: `var result = await pool.query(sql, queryParams); return { columns: result.rows.length > 0 ? Object.keys(result.rows[0]) : [], rows: result.rows, rowCount: result.rows.length };`,
              close: `await pool.end();`,
              listTables: `var r = await pool.query("SELECT t.table_name, obj_description(c.oid) AS table_comment FROM information_schema.tables t LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' ORDER BY t.table_name", [schemaName]); tables = r.rows;`,
              describeTable: `var r = await pool.query("SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, col_description((SELECT oid FROM pg_class WHERE relname = $1), c.ordinal_position) AS column_comment FROM information_schema.columns c WHERE c.table_name = $1 ORDER BY c.ordinal_position", [tbl]); columns = r.rows; var fk = await pool.query("SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1", [tbl]); foreignKeys = fk.rows;`,
            },
            mysql: {
              require: `var mysql = require('mysql2/promise');`,
              connect: `var pool = await mysql.createConnection({ host: creds.host, port: parseInt(creds.port) || 3306, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : undefined, connectTimeout: 10000 });`,
              query: `var [rows] = await pool.query(sql, queryParams); return { columns: rows.length > 0 ? Object.keys(rows[0]) : [], rows: rows, rowCount: rows.length };`,
              close: `await pool.end();`,
              listTables: `var [rows] = await pool.query("SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS table_comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME", [creds.database]); tables = rows;`,
              describeTable: `var [rows] = await pool.query("SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, CHARACTER_MAXIMUM_LENGTH AS max_length, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, COLUMN_COMMENT AS column_comment, COLUMN_KEY AS column_key FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION", [creds.database, tbl]); columns = rows; var [fkRows] = await pool.query("SELECT COLUMN_NAME AS column_name, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL", [creds.database, tbl]); foreignKeys = fkRows;`,
            },
            mssql: {
              require: `var sql = require('mssql');`,
              connect: `var pool = await sql.connect({ server: creds.host, port: parseInt(creds.port) || 1433, database: creds.database, user: creds.username, password: creds.password, options: { encrypt: creds.ssl === 'true', trustServerCertificate: true }, connectionTimeout: 10000, requestTimeout: 30000 });`,
              query: `var result = await pool.request().query(sqlStr); return { columns: result.recordset.length > 0 ? Object.keys(result.recordset[0]) : [], rows: result.recordset, rowCount: result.recordset.length };`,
              close: `await pool.close();`,
              listTables: `var r = await pool.request().query("SELECT t.name AS table_name, ep.value AS table_comment FROM sys.tables t LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' ORDER BY t.name"); tables = r.recordset;`,
              describeTable: `var r = await pool.request().input('tbl', tbl).query("SELECT c.name AS column_name, TYPE_NAME(c.user_type_id) AS data_type, c.max_length, CASE c.is_nullable WHEN 1 THEN 'YES' ELSE 'NO' END AS is_nullable, dc.definition AS column_default, ep.value AS column_comment, CASE WHEN pk.column_id IS NOT NULL THEN 'PRI' ELSE '' END AS column_key FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' LEFT JOIN (SELECT ic.object_id, ic.column_id FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id WHERE i.is_primary_key = 1) pk ON pk.object_id = c.object_id AND pk.column_id = c.column_id WHERE c.object_id = OBJECT_ID(@tbl) ORDER BY c.column_id"); columns = r.recordset; var fkR = await pool.request().input('tbl', tbl).query("SELECT COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name, OBJECT_NAME(fkc.referenced_object_id) AS ref_table, COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column FROM sys.foreign_key_columns fkc WHERE fkc.parent_object_id = OBJECT_ID(@tbl)"); foreignKeys = fkR.recordset;`,
            },
          };
          const drv = dbDriverMap[args.db_type] || dbDriverMap.mysql;
          const handlerCode = `// DB MCP Handler — auto-generated for ${args.db_type}
${drv.require}

async function execute(ctx) {
  var toolName = ctx.tool || ctx.toolName;
  var creds = ctx.credentials;
  var params = ctx.params;

  if (!creds || !creds.host || !creds.database || !creds.username) {
    return { success: false, message: '请先配置数据库凭证（凭证系统名: ${systemName}）' };
  }

  ${drv.connect}
  try {
    if (toolName === 'list_tables') {
      var schemaName = params.schema_name || 'public';
      var tables;
      ${drv.listTables}
      return { success: true, message: '共 ' + tables.length + ' 张表', data: { tables: tables } };
    }

    if (toolName === 'describe_table') {
      var tableNames = (params.table_names || '').split(',').map(function(n) { return n.trim(); }).filter(Boolean);
      if (tableNames.length === 0) return { success: false, message: '请提供 table_names 参数' };
      var result = [];
      for (var i = 0; i < tableNames.length; i++) {
        var tbl = tableNames[i];
        var columns, foreignKeys;
        ${drv.describeTable}
        result.push({ name: tbl, columns: columns, foreign_keys: foreignKeys });
      }
      return { success: true, message: '查询完成', data: { tables: result } };
    }

    if (toolName === 'execute_query') {
      var sqlStr = (params.sql || '').trim();
      if (!sqlStr) return { success: false, message: 'SQL 不能为空' };
      var upper = sqlStr.toUpperCase();
      if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
        return { success: false, message: '仅允许 SELECT 查询' };
      }
      var forbidden = ['INSERT','UPDATE','DELETE','DROP','ALTER','TRUNCATE','CREATE','GRANT','REVOKE'];
      for (var f = 0; f < forbidden.length; f++) {
        if (new RegExp('\\\\b' + forbidden[f] + '\\\\b', 'i').test(sqlStr)) {
          return { success: false, message: '不允许使用 ' + forbidden[f] };
        }
      }
      var queryParams = [];
      if (params.params) { try { queryParams = JSON.parse(params.params); } catch(e) {} }
      var sql = sqlStr.indexOf('LIMIT') === -1 && sqlStr.indexOf('limit') === -1 ? sqlStr + ' LIMIT 1000' : sqlStr;
      ${drv.query}
    }

    return { success: false, message: '未知工具: ' + toolName };
  } catch(err) {
    return { success: false, message: '数据库查询失败: ' + err.message };
  } finally {
    try { ${drv.close} } catch(e) {}
  }
}
`;
          const handlerPath = path.join(mcpDir, 'handler.ts');
          fs.writeFileSync(handlerPath, handlerCode, 'utf-8');

          // Auto-reload so MCP is immediately available (no need for separate reload_connectors)
          this.mcpRegistry.loadAll();

          // Fire-and-forget: generate schema cache in background
          this.mcpRegistry.refreshSchema(systemName, {
            db_type: args.db_type, host: args.host, port: args.port,
            database: args.database, username: args.username, password: args.password,
            ssl: args.ssl || 'false',
          }).then(r => {
            if (r.success) this.logger.log(`Schema cache auto-generated for ${systemName}: ${r.total} tables`);
            else this.logger.warn(`Schema cache failed for ${systemName}: ${r.error}`);
          }).catch(() => {});

          return { content: [{ type: 'text' as const, text: `数据库连接已保存并注册完成。\n\n- 连接名: **${systemName}**\n- 数据库类型: ${args.db_type}\n- 工具: list_tables / describe_table / execute_query\n- 结构缓存正在后台生成...\n\n**下一步**：直接 test_connector 验证即可。` }], details: null };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `保存失败: ${err.message}` }], details: null };
        }
      },
    };
  }

  // ===== test_db_connection =====
  private buildTestDbConnection(Type: any): ToolInstance {
    return {
      name: 'test_db_connection',
      label: '测试数据库连接',
      description: '测试已保存的数据库连接是否可用。',
      parameters: Type.Object({
        connection_name: Type.String({ description: '连接名称' }),
      }),
      execute: async (_id: string, args: any) => {
        const systemName = `db-${args.connection_name}`;
        const creds = this.credentialService.getGlobalCredentials(systemName);
        if (!creds) return { content: [{ type: 'text' as const, text: `未找到连接 "${systemName}" 的凭证，请先使用 save_db_connection 保存。` }], details: null };

        const dbType = creds.db_type || 'postgresql';
        const port = parseInt(creds.port) || (dbType === 'mysql' ? 3306 : dbType === 'mssql' ? 1433 : 5432);

        try {
          if (dbType === 'postgresql') {
            const { Pool } = require('pg');
            const pool = new Pool({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 10000 });
            try { const r = await pool.query('SELECT version()'); return { content: [{ type: 'text' as const, text: `✓ PostgreSQL 连接成功\n${r.rows[0].version}` }], details: null }; }
            finally { await pool.end(); }
          } else if (dbType === 'mysql') {
            const mysql = require('mysql2/promise');
            const conn = await mysql.createConnection({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : undefined, connectTimeout: 10000 });
            try { const [rows] = await conn.query('SELECT version() AS ver'); return { content: [{ type: 'text' as const, text: `✓ MySQL 连接成功\nMySQL ${(rows as any)[0].ver}` }], details: null }; }
            finally { await conn.end(); }
          } else if (dbType === 'mssql') {
            const sql = require('mssql');
            const pool = await sql.connect({ server: creds.host, port, database: creds.database, user: creds.username, password: creds.password, options: { encrypt: creds.ssl === 'true', trustServerCertificate: true }, connectionTimeout: 10000, requestTimeout: 10000 });
            try { const r = await pool.query`SELECT @@VERSION AS ver`; return { content: [{ type: 'text' as const, text: `✓ SQL Server 连接成功\n${r.recordset[0].ver.split('\n')[0]}` }], details: null }; }
            finally { await pool.close(); }
          } else {
            return { content: [{ type: 'text' as const, text: `不支持的数据库类型: ${dbType}` }], details: null };
          }
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `✗ 连接失败: ${err.message}` }], details: null };
        }
      },
    };
  }

  // ===== discover_db_schema =====
  private buildDiscoverDbSchema(Type: any): ToolInstance {
    return {
      name: 'discover_db_schema',
      label: '发现数据库结构',
      description: '从数据库元数据中提取表结构。两种模式：\n- mode=overview（默认）：返回表总数 + 抽样50个表名及注释，用于向用户说明数据库概况\n- mode=full：获取完整表结构并保存到文件，需指定 table_filter 或 offset/limit 控制范围',
      parameters: Type.Object({
        connection_name: Type.String({ description: '连接名称' }),
        mode: Type.Optional(Type.String({ description: 'overview（默认，返回总数+抽样表名）或 full（获取详细结构并保存文件）' })),
        schema_name: Type.Optional(Type.String({ description: 'Schema 名称' })),
        table_filter: Type.Optional(Type.String({ description: '表名过滤正则（full 模式用）' })),
        offset: Type.Optional(Type.String({ description: '分页偏移（full 模式用）' })),
        limit: Type.Optional(Type.String({ description: '每页表数量，默认 50' })),
      }),
      execute: async (_id: string, args: any) => {
        const systemName = `db-${args.connection_name}`;
        const creds = this.credentialService.getGlobalCredentials(systemName);
        if (!creds) return { content: [{ type: 'text' as const, text: `未找到连接 "${systemName}" 的凭证` }], details: null };

        const dbType = creds.db_type || 'postgresql';
        const port = parseInt(creds.port) || (dbType === 'mysql' ? 3306 : dbType === 'mssql' ? 1433 : 5432);
        const mode = args.mode || 'overview';
        const offset = parseInt(args.offset) || 0;
        const limit = parseInt(args.limit) || 50;

        // === Cache mode: generate local schema cache ===
        if (mode === 'cache') {
          const result = await this.mcpRegistry.refreshSchema(systemName, creds);
          if (!result.success) return { content: [{ type: 'text' as const, text: `缓存生成失败: ${result.error}` }], details: null };
          return { content: [{ type: 'text' as const, text: `结构缓存已生成：共 ${result.total} 张表。\n可使用 search_db_schema 搜索表结构。` }], details: null };
        }

        // === Overview mode: count + sample table names ===
        if (mode === 'overview') {
          try {
            let totalCount = 0;
            let sampleTables: { name: string; comment: string }[] = [];

            if (dbType === 'postgresql') {
              const { Pool } = require('pg');
              const pool = new Pool({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
              try {
                const schemaName = args.schema_name || 'public';
                const countRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM information_schema.tables WHERE table_schema = $1 AND table_type = 'BASE TABLE'`, [schemaName]);
                totalCount = countRes.rows[0].cnt;
                const sampleRes = await pool.query(`SELECT t.table_name, obj_description(c.oid) AS comment FROM information_schema.tables t LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' ORDER BY t.table_name LIMIT 50`, [schemaName]);
                sampleTables = sampleRes.rows.map((r: any) => ({ name: r.table_name, comment: r.comment || '' }));
              } finally { await pool.end(); }
            } else if (dbType === 'mysql') {
              const mysql = require('mysql2/promise');
              const conn = await mysql.createConnection({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : undefined, connectTimeout: 10000 });
              try {
                const dbName = args.schema_name || creds.database;
                const [countRows] = await conn.query(`SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'`, [dbName]);
                totalCount = (countRows as any)[0].cnt;
                const [sampleRows] = await conn.query(`SELECT TABLE_NAME AS name, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT 50`, [dbName]);
                sampleTables = (sampleRows as any[]).map(r => ({ name: r.name, comment: r.comment || '' }));
              } finally { await conn.end(); }
            } else if (dbType === 'mssql') {
              const sql = require('mssql');
              const pool = await sql.connect({ server: creds.host, port, database: creds.database, user: creds.username, password: creds.password, options: { encrypt: creds.ssl === 'true', trustServerCertificate: true }, connectionTimeout: 10000, requestTimeout: 30000 });
              try {
                const schemaName = args.schema_name || 'dbo';
                const countRes = await pool.request().input('schema', schemaName).query(`SELECT COUNT(*) AS cnt FROM sys.tables WHERE SCHEMA_NAME(schema_id) = @schema`);
                totalCount = countRes.recordset[0].cnt;
                const sampleRes = await pool.request().input('schema', schemaName).query(`SELECT TOP 50 t.name, ep.value AS comment FROM sys.tables t LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' WHERE SCHEMA_NAME(t.schema_id) = @schema ORDER BY t.name`);
                sampleTables = sampleRes.recordset.map((r: any) => ({ name: r.name, comment: r.comment || '' }));
              } finally { await pool.close(); }
            }

            const tableList = sampleTables.map(t => t.name + (t.comment ? `(${t.comment})` : '')).join(', ');
            const moreHint = totalCount > 50 ? `\n（以上为前 50 个表名，共 ${totalCount} 张表）` : '';
            return { content: [{ type: 'text' as const, text: `数据库共 **${totalCount}** 张表。\n\n表名：${tableList}${moreHint}\n\n请向用户说明表数量，询问用户是全部生成还是选择部分表。确认后用 mode=full 获取详细结构。` }], details: null };
          } catch (err: any) {
            return { content: [{ type: 'text' as const, text: `概览获取失败: ${err.message}` }], details: null };
          }
        }

        // === Full mode: get detailed schema and save to file ===
        try {
          let tables: { name: string; comment: string; columns: any[]; foreignKeys: any[] }[] = [];

          if (dbType === 'postgresql') {
            const { Pool } = require('pg');
            const pool = new Pool({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : false, max: 1, connectionTimeoutMillis: 10000, statement_timeout: 30000 });
            try {
              const schemaName = args.schema_name || 'public';
              const tablesRes = await pool.query(
                `SELECT t.table_name, obj_description(c.oid) AS comment FROM information_schema.tables t LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1) WHERE t.table_schema = $1 AND t.table_type = 'BASE TABLE' ORDER BY t.table_name OFFSET $2 LIMIT $3`,
                [schemaName, offset, limit]);
              for (const t of tablesRes.rows) {
                if (args.table_filter && !new RegExp(args.table_filter, 'i').test(t.table_name)) continue;
                const colsRes = await pool.query(
                  `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, col_description((SELECT oid FROM pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $2)), c.ordinal_position) AS comment FROM information_schema.columns c WHERE c.table_schema = $2 AND c.table_name = $1 ORDER BY c.ordinal_position`,
                  [t.table_name, schemaName]);
                const fksRes = await pool.query(
                  `SELECT kcu.column_name, ccu.table_name AS ref_table, ccu.column_name AS ref_column FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1 AND tc.table_schema = $2`,
                  [t.table_name, schemaName]);
                tables.push({ name: t.table_name, comment: t.comment || '', columns: colsRes.rows, foreignKeys: fksRes.rows });
              }
            } finally { await pool.end(); }
          } else if (dbType === 'mysql') {
            const mysql = require('mysql2/promise');
            const conn = await mysql.createConnection({ host: creds.host, port, database: creds.database, user: creds.username, password: creds.password, ssl: creds.ssl === 'true' ? { rejectUnauthorized: false } : undefined, connectTimeout: 10000 });
            try {
              const dbName = args.schema_name || creds.database;
              const [tabRows] = await conn.query(
                `SELECT TABLE_NAME AS table_name, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME LIMIT ? OFFSET ?`,
                [dbName, limit, offset]);
              for (const t of tabRows as any[]) {
                if (args.table_filter && !new RegExp(args.table_filter, 'i').test(t.table_name)) continue;
                const [cols] = await conn.query(
                  `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable, COLUMN_DEFAULT AS column_default, COLUMN_COMMENT AS comment FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
                  [dbName, t.table_name]);
                const [fks] = await conn.query(
                  `SELECT COLUMN_NAME AS column_name, REFERENCED_TABLE_NAME AS ref_table, REFERENCED_COLUMN_NAME AS ref_column FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
                  [dbName, t.table_name]);
                tables.push({ name: t.table_name, comment: t.comment || '', columns: cols as any[], foreignKeys: fks as any[] });
              }
            } finally { await conn.end(); }
          } else if (dbType === 'mssql') {
            const sql = require('mssql');
            const pool = await sql.connect({ server: creds.host, port, database: creds.database, user: creds.username, password: creds.password, options: { encrypt: creds.ssl === 'true', trustServerCertificate: true }, connectionTimeout: 10000, requestTimeout: 30000 });
            try {
              const schemaName = args.schema_name || 'dbo';
              const tabRes = await pool.request().input('schema', schemaName).input('offset', offset).input('limit', limit)
                .query(`SELECT t.name AS table_name, ep.value AS comment FROM sys.tables t LEFT JOIN sys.extended_properties ep ON ep.major_id = t.object_id AND ep.minor_id = 0 AND ep.name = 'MS_Description' WHERE SCHEMA_NAME(t.schema_id) = @schema ORDER BY t.name OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`);
              for (const t of tabRes.recordset) {
                if (args.table_filter && !new RegExp(args.table_filter, 'i').test(t.table_name)) continue;
                const colRes = await pool.request().input('schema', schemaName).input('table', t.table_name)
                  .query(`SELECT c.name AS column_name, TYPE_NAME(c.user_type_id) AS data_type, CASE c.is_nullable WHEN 1 THEN 'YES' ELSE 'NO' END AS is_nullable, dc.definition AS column_default, ep.value AS comment FROM sys.columns c LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' WHERE c.object_id = OBJECT_ID(@schema + '.' + @table) ORDER BY c.column_id`);
                const fkRes = await pool.request().input('table', t.table_name)
                  .query(`SELECT COL_NAME(fkc.parent_object_id, fkc.parent_column_id) AS column_name, OBJECT_NAME(fkc.referenced_object_id) AS ref_table, COL_NAME(fkc.referenced_object_id, fkc.referenced_column_id) AS ref_column FROM sys.foreign_key_columns fkc WHERE fkc.parent_object_id = OBJECT_ID(@table)`);
                tables.push({ name: t.table_name, comment: t.comment || '', columns: colRes.recordset, foreignKeys: fkRes.recordset });
              }
            } finally { await pool.close(); }
          }

          // Save full schema to file — do NOT return to LLM
          const fs = require('fs');
          const path = require('path');
          const schemaDir = path.join(this.mcpRegistry.getBaseDir(), `db-${args.connection_name}`);
          if (!fs.existsSync(schemaDir)) fs.mkdirSync(schemaDir, { recursive: true });
          const schemaFile = path.join(schemaDir, `schema_${offset}.json`);
          fs.writeFileSync(schemaFile, JSON.stringify(tables, null, 2), 'utf-8');

          // Return only summary to LLM
          const tableNames = tables.map(t => t.name + (t.comment ? `(${t.comment})` : '')).join(', ');
          const summary = `已发现 ${tables.length} 张表（offset=${offset}, limit=${limit}），结构已保存到 ${schemaFile}\n\n表名：${tableNames}\n\n如需查看某张表的字段详情，请用 read 工具读取保存的文件。`;
          return { content: [{ type: 'text' as const, text: summary }], details: null };
        } catch (err: any) {
          return { content: [{ type: 'text' as const, text: `结构发现失败: ${err.message}` }], details: null };
        }
      },
    };
  }

  // ===== search_db_schema =====
  private buildSearchDbSchema(Type: any): ToolInstance {
    return {
      name: 'search_db_schema',
      label: '搜索数据库结构',
      description: '在本地缓存中搜索数据库表结构。支持按表名、注释、字段名模糊搜索，返回匹配表的完整字段结构，不访问数据库。\n- connection_name 可选：不填则自动搜索所有数据库连接，结果标注来源库\n- 填写则只搜索指定连接',
      parameters: Type.Object({
        connection_name: Type.Optional(Type.String({ description: '连接名称（不含 db- 前缀）。不填则跨所有数据库搜索' })),
        query: Type.String({ description: '搜索关键词（表名、中文注释、字段名均可，多个用空格分隔）' }),
        max_results: Type.Optional(Type.String({ description: '最大返回表数，默认 5' })),
      }),
      execute: async (_id: string, args: any) => {
        const fs = require('fs');
        const path = require('path');
        const baseDir = this.mcpRegistry.getBaseDir();
        const queryTerms = (args.query || '').toLowerCase().split(/[\s,，]+/).filter(Boolean);
        const maxResults = parseInt(args.max_results) || 5;

        if (queryTerms.length === 0) {
          return { content: [{ type: 'text' as const, text: '请提供搜索关键词。' }], details: null };
        }

        // Determine which DB connections to search
        type DbIndex = { mcpName: string; description: string; total: number; updated: string; tables: { name: string; comment: string; columns: number }[] };
        const dbIndexes: DbIndex[] = [];

        if (args.connection_name) {
          // Single DB
          const systemName = `db-${args.connection_name}`;
          const indexPath = path.join(baseDir, systemName, 'schema', '_index.json');
          if (!fs.existsSync(indexPath)) {
            return { content: [{ type: 'text' as const, text: `"${args.connection_name}" 的本地结构缓存不存在。请到连接面板点击「刷新结构」按钮生成。` }], details: null };
          }
          const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
          const mcp = this.mcpRegistry.get(systemName);
          dbIndexes.push({ mcpName: systemName, description: mcp?.description || systemName, total: idx.total, updated: idx.updated, tables: idx.tables });
        } else {
          // Cross-DB: scan all db-* directories with schema/_index.json
          if (fs.existsSync(baseDir)) {
            for (const dir of fs.readdirSync(baseDir, { withFileTypes: true })) {
              if (!dir.isDirectory() || !dir.name.startsWith('db-')) continue;
              const indexPath = path.join(baseDir, dir.name, 'schema', '_index.json');
              if (!fs.existsSync(indexPath)) continue;
              try {
                const idx = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
                const mcp = this.mcpRegistry.get(dir.name);
                dbIndexes.push({ mcpName: dir.name, description: mcp?.description || dir.name, total: idx.total, updated: idx.updated, tables: idx.tables });
              } catch {}
            }
          }
          if (dbIndexes.length === 0) {
            return { content: [{ type: 'text' as const, text: '没有任何数据库连接的结构缓存。请先在连接面板为数据库连接点击「刷新结构」。' }], details: null };
          }
        }

        // Score tables across all DBs
        type ScoredTable = { name: string; comment: string; columns: number; score: number; mcpName: string; description: string };
        const allScored: ScoredTable[] = [];

        for (const db of dbIndexes) {
          const schemaDir = path.join(baseDir, db.mcpName, 'schema');
          for (const t of db.tables) {
            let score = 0;
            const nameLower = t.name.toLowerCase();
            const commentLower = (t.comment || '').toLowerCase();

            for (const term of queryTerms) {
              if (nameLower === term) score += 100;
              else if (nameLower.includes(term)) score += 50;
              if (commentLower.includes(term)) score += 30;
            }

            // Check keywords in MD frontmatter if name/comment didn't match
            if (score === 0) {
              const safeName = t.name.replace(/[\/\\:*?"<>|]/g, '_');
              const mdPath = path.join(schemaDir, `${safeName}.md`);
              if (fs.existsSync(mdPath)) {
                const head = fs.readFileSync(mdPath, 'utf-8').substring(0, 2000);
                const kwMatch = head.match(/^keywords:\s*"(.+)"/m);
                if (kwMatch) {
                  const kw = kwMatch[1].toLowerCase();
                  for (const term of queryTerms) {
                    if (kw.includes(term)) score += 10;
                  }
                }
              }
            }

            if (score > 0) allScored.push({ ...t, score, mcpName: db.mcpName, description: db.description });
          }
        }

        allScored.sort((a, b) => b.score - a.score);
        const matches = allScored.slice(0, maxResults);

        if (matches.length === 0) {
          const dbList = dbIndexes.map(d => `${d.mcpName}（${d.description}，${d.total}表）`).join('、');
          return { content: [{ type: 'text' as const, text: `未找到匹配"${args.query}"的表。\n已搜索: ${dbList}\n建议：尝试其他关键词。` }], details: null };
        }

        // Group results by DB for display
        const grouped = new Map<string, { description: string; tables: typeof matches }>();
        for (const m of matches) {
          if (!grouped.has(m.mcpName)) grouped.set(m.mcpName, { description: m.description, tables: [] });
          grouped.get(m.mcpName)!.tables.push(m);
        }

        // Build output with DB headers
        const sections: string[] = [];
        const multiDb = grouped.size > 1 || !args.connection_name;

        for (const [mcpName, group] of grouped) {
          const schemaDir = path.join(baseDir, mcpName, 'schema');
          if (multiDb) sections.push(`\n📦 **${mcpName}**（${group.description}）\n使用 \`mcp_${mcpName}_execute_query\` 查询此库\n`);

          for (const t of group.tables) {
            const safeName = t.name.replace(/[\/\\:*?"<>|]/g, '_');
            const mdPath = path.join(schemaDir, `${safeName}.md`);
            if (fs.existsSync(mdPath)) {
              const content = fs.readFileSync(mdPath, 'utf-8');
              const body = content.replace(/^---[\s\S]*?---\n/, ''); // Strip frontmatter
              // Progressive disclosure: truncate large schemas to header + key columns
              if (body.length > 1500) {
                const lines = body.split('\n');
                const kept: string[] = [];
                let charCount = 0;
                for (const line of lines) {
                  kept.push(line);
                  charCount += line.length;
                  if (charCount > 1200) { kept.push(`\n...(共 ${lines.length} 行，已省略 ${lines.length - kept.length} 行。需完整结构请用 read 工具查看 ${safeName}.md)`); break; }
                }
                sections.push(kept.join('\n'));
              } else {
                sections.push(body);
              }
            } else {
              sections.push(`## ${t.name} (${t.comment})\n[缓存文件缺失]`);
            }
          }
        }

        const dbCount = grouped.size;
        const totalTables = dbIndexes.reduce((s, d) => s + d.total, 0);
        const header = dbCount > 1
          ? `找到 ${matches.length} 个匹配表（跨 ${dbCount} 个数据库，共 ${totalTables} 张表）：\n`
          : `找到 ${matches.length} 个匹配表（共 ${dbIndexes[0]?.total || 0} 张表，缓存时间: ${dbIndexes[0]?.updated || ''}）：\n`;

        return { content: [{ type: 'text' as const, text: header + sections.join('\n\n---\n\n') }], details: null };
      },
    };
  }
}
