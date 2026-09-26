/**
 * MCP 工具契约测试（对译 tests/integration/mcp/test_tool_handlers.py 核心场景）。
 * 需要可用 PG：设置 KBS_TEST_DATABASE_URL 或 KB_DATABASE_URL，否则跳过。
 * 测试在独立 workspace 临时目录中进行，结束后清理测试文档。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../../src/shared/db';
import { buildMcpServer } from '../../src/mcp/server';
import { initTaxonomy } from '../../src/mcp/tools/taxonomy';

const DB_URL = process.env.KBS_TEST_DATABASE_URL || process.env.KB_DATABASE_URL || '';
const RUN = DB_URL ? describe : describe.skip;

let db: Db;
let server: Awaited<ReturnType<typeof buildMcpServer>>;
let client: Client;
let workspace: string;
const createdDocIds: string[] = [];

async function callTool(name: string, args: Record<string, any>): Promise<string> {
  const r = await client.callTool({ name, arguments: args });
  const b = (r.content as any[])[0];
  return b?.type === 'text' ? b.text : JSON.stringify(b);
}

async function trackDocs() {
  const { rows } = await db.query(
    "SELECT id FROM jz_kb_documents WHERE filename LIKE 'vitest-%'",
  );
  createdDocIds.push(...rows.map((r: any) => r.id));
}

RUN('MCP 工具契约', () => {
  beforeAll(async () => {
    db = new Db(DB_URL);
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kbs-vitest-'));
    initTaxonomy(db);
    server = await buildMcpServer({ db, workspace, appUrl: 'http://test', wikiLanguage: 'zh' });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    client = new Client({ name: 'vitest', version: '0.1.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  }, 30000);

  afterAll(async () => {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
    if (createdDocIds.length > 0) {
      await db.query('DELETE FROM jz_kb_documents WHERE id = ANY($1)', [createdDocIds]).catch(() => {});
    }
    await db.close().catch(() => {});
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('ping → pong', async () => {
    expect(await callTool('ping', {})).toBe('pong');
  });

  it('guide 返回 KB 配置与语言指令', async () => {
    const text = await callTool('guide', {});
    expect(text).toContain('# KB Workspace Configuration');
    expect(text).toContain('Available Knowledge Bases');
    expect(text).toContain('slug: `default`');
  });

  it('write create → 建档 + 落盘；重复创建被拒', async () => {
    const created = await callTool('write', {
      knowledge_base: 'default',
      command: 'create',
      path: '/',
      title: 'vitest-note.md',
      content:
        '# 契约测试\n\n' +
        '契约测试内容，长度需要超过三十二个 token 的分块阈值，确保能被搜索索引到。'.repeat(6),
      tags: ['test'],
    });
    expect(created).toContain('Created');
    expect(fs.existsSync(path.join(workspace, 'vitest-note.md'))).toBe(true);

    const dup = await callTool('write', {
      knowledge_base: 'default',
      command: 'create',
      path: '/',
      title: 'vitest-note.md',
      content: 'different',
      tags: ['test'],
    });
    expect(dup).toContain('already exists');
    await trackDocs();
  });

  it('write 缺 title/tags → 校验错误', async () => {
    expect(await callTool('write', { knowledge_base: 'default', command: 'create', path: '/', title: '', tags: ['t'] })).toContain('title is required');
    expect(await callTool('write', { knowledge_base: 'default', command: 'create', path: '/', title: 'x.md', tags: [] })).toContain('at least one tag');
  });

  it('search 命中 chunks；read 读回内容', async () => {
    // chunks 仅由 REST 建档/文档管线产生（MCP 写不建 chunks，与 Python 一致）
    // 直接落库一条带 chunk 的文档模拟管线产出
    const { randomUUID } = await import('crypto');
    const docId = randomUUID();
    createdDocIds.push(docId);
    await db.query(
      "INSERT INTO jz_kb_documents (id, filename, title, path, relative_path, source_kind, file_type, status, content) VALUES ($1, 'vitest-chunked.md', '带块文档', '/', 'vitest-chunked.md', 'source', 'md', 'ready', '麒麟芯片契约检索关键词')",
      [docId],
    );
    await db.query(
      'INSERT INTO jz_kb_document_chunks (id, document_id, chunk_index, content, token_count) VALUES ($1, $2, 0, $3, 20)',
      [randomUUID(), docId, '麒麟芯片契约检索关键词'],
    );

    const s = await callTool('search', { knowledge_base: 'default', mode: 'search', query: '契约检索关键词', limit: 5 });
    expect(s).toContain('result(s)');
    expect(s).toContain('vitest-chunked.md');

    const r = await callTool('read', { knowledge_base: 'default', path: '/vitest-note.md' });
    expect(r).toContain('契约测试');
    expect(r).toContain('Type: md');
  });

  it('str_replace 精确替换；多次匹配报错', async () => {
    const ok = await callTool('write', {
      knowledge_base: 'default', command: 'str_replace',
      path: '/vitest-note.md', old_text: '# 契约测试', new_text: '# 契约测试改',
    });
    expect(ok).toContain('Edited');
    expect(ok).toContain('Replaced 1 occurrence');

    const miss = await callTool('write', {
      knowledge_base: 'default', command: 'str_replace',
      path: '/vitest-note.md', old_text: '不存在文本', new_text: 'x',
    });
    expect(miss).toContain('no match found');

    const multi = await callTool('write', {
      knowledge_base: 'default', command: 'str_replace',
      path: '/vitest-note.md', old_text: '契约测试内容', new_text: 'x',
    });
    expect(multi).toContain('matches for old_text');
  });

  it('append 追加内容', async () => {
    const r = await callTool('write', {
      knowledge_base: 'default', command: 'append',
      path: '/vitest-note.md', content: '追加段落。',
    });
    expect(r).toContain('Appended');
    const content = await callTool('read', { knowledge_base: 'default', path: '/vitest-note.md' });
    expect(content).toContain('追加段落。');
  });

  it('wiki 页脚注引用 → references 边 + uncited 排除', async () => {
    // 注意：被引文件名须不含连字符 —— Python 原版脚注解析正则会在首个 "-" 处截断
    // （上游已存在行为，TS 版保持忠实移植）
    await callTool('write', {
      knowledge_base: 'default', command: 'create', path: '/',
      title: 'vitestsrc.md',
      content: '# 源\n\n被引用的源文档内容。',
      tags: ['test'],
    });
    await callTool('write', {
      knowledge_base: 'default', command: 'create', path: '/wiki/',
      title: 'vitest-wikipage',
      content: '# wiki 页\n\n引用源文档。[^1]: vitestsrc.md, p.1',
      tags: ['test'],
    });
    await trackDocs();
    const refs = await callTool('search', {
      knowledge_base: 'default', mode: 'references', path: '/wiki/vitest-wikipage.md',
    });
    expect(refs).toContain('Cites (1 sources)');
    expect(refs).toContain('/vitestsrc.md, p.1');

    const uncited = await callTool('search', {
      knowledge_base: 'default', mode: 'references', query: 'uncited',
    });
    expect(uncited).not.toContain('/vitestsrc.md');
  });

  it('query 返回完整内容', async () => {
    const q = await callTool('query', { knowledge_base: 'default', query: '契约测试改', scope: 'all', limit: 3 });
    expect(q).toContain('result(s)');
    expect(q).toContain('vitest-note.md');
  });

  it('delete 单篇 + overview.md 保护', async () => {
    await callTool('write', {
      knowledge_base: 'default', command: 'create', path: '/wiki/',
      title: 'overview', content: '# 概览\n\n受保护页面。', tags: ['test'], overwrite: true,
    });
    await trackDocs();
    const prot = await callTool('delete', { knowledge_base: 'default', path: '/wiki/overview.md' });
    expect(prot).toContain('Cannot delete');

    const del = await callTool('delete', { knowledge_base: 'default', path: '/vitest-note.md' });
    expect(del).toContain('Deleted 1 document(s)');
    expect(fs.existsSync(path.join(workspace, 'vitest-note.md'))).toBe(false);
  });

  it('delete 通配拒绝 *', async () => {
    expect(await callTool('delete', { knowledge_base: 'default', path: '*' })).toContain('refusing');
  });
});
