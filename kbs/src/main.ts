/**
 * kbs 入口：config → PG 连接 → schema 校验 → 启动 API 服务（MCP 服务于 P3 接入）。
 */
import { loadConfig } from './config';
import { Db } from './shared/db';
import { buildApiServer } from './api/server';
import { buildMcpServer } from './mcp/server';
import { initTaxonomy } from './mcp/tools/taxonomy';
import { terminateOcrWorker } from './processor/ocr';

/** 启动前置校验：jz_kb_* 表（main migration 013 创建）+ pg_trgm 扩展 */
const REQUIRED_TABLES = [
  'jz_kb_documents',
  'jz_kb_document_chunks',
  'jz_kb_document_pages',
  'jz_kb_document_references',
  'jz_kb_categories',
  'jz_kb_category_access',
];

async function assertSchemaReady(db: Db): Promise<void> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT t.name FROM (
       VALUES ${REQUIRED_TABLES.map((_, i) => `($${i + 1})`).join(', ')}
     ) AS t(name)
     WHERE NOT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t.name
     )`,
    REQUIRED_TABLES,
  );
  const missingTables = rows.map((r) => r.name);
  const ext = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM pg_extension WHERE extname = 'pg_trgm'`,
  );
  const missing: string[] = [...missingTables];
  if (ext.rows[0]?.count === '0') missing.push('extension:pg_trgm');
  if (missing.length > 0) {
    throw new Error(
      `平台 PG 缺少 kbs 所需对象: ${missing.join(', ')}。` +
        `jz_kb_* 表由 main 的 migration 013 创建 — 请先启动 main 完成数据库迁移。`,
    );
  }
}

async function main() {
  const config = loadConfig();
  const db = new Db(config.databaseUrl);

  await db.query('SELECT 1');
  await assertSchemaReady(db);
  console.log('[kbs] PG 连接就绪，schema 校验通过');

  const app = await buildApiServer({
    internalSecret: config.internalSecret,
    db,
    workspacePath: config.workspacePath,
    apiUrl: config.apiUrl,
    processor: {
      workspace: config.workspacePath,
      pdfBackend: config.pdfBackend,
      mistralApiKey: config.mistralApiKey,
    },
  });
  await app.listen({ port: config.apiPort, host: config.apiHost });
  console.log(`[kbs] API  listening on http://${config.apiHost}:${config.apiPort}`);

  initTaxonomy(db);
  const mcpApp = await buildMcpServer({
    db,
    workspace: config.workspacePath,
    appUrl: config.appUrl,
    wikiLanguage: config.wikiLanguage,
  });
  await mcpApp.listen({ port: config.mcpPort, host: config.mcpHost });
  console.log(`[kbs] MCP  listening on http://${config.mcpHost}:${config.mcpPort}/mcp`);

  const shutdown = async (signal: string) => {
    console.log(`[kbs] ${signal} received, shutting down`);
    await app.close().catch(() => {});
    await mcpApp.close().catch(() => {});
    await terminateOcrWorker().catch(() => {});
    await db.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[kbs] 启动失败: ${err.message}`);
  process.exit(1);
});
