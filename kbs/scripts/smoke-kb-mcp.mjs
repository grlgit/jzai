/**
 * kbs MCP 冒烟：initialize → tools/list → ping → guide → search。
 * 用法: node kbs/scripts/smoke-kb-mcp.mjs [endpoint]   默认 http://127.0.0.1:3111/mcp
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.argv[2] || 'http://127.0.0.1:3111/mcp';

const client = new Client({ name: 'kbs-smoke', version: '0.1.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint));

try {
  await client.connect(transport);
  console.log('✓ connected:', endpoint);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log('✓ tools:', names.join(', '));
  for (const expected of ['guide', 'search', 'read', 'write', 'delete', 'query', 'ping']) {
    if (!names.includes(expected)) throw new Error(`缺少工具: ${expected}`);
  }

  const ping = await client.callTool({ name: 'ping', arguments: {} });
  console.log('✓ ping →', ping.content[0].text);

  const guide = await client.callTool({ name: 'guide', arguments: {} });
  const guideText = guide.content[0].text;
  console.log('✓ guide →', guideText.split('\n')[0], `(len=${guideText.length})`);
  if (!guideText.includes('Available Knowledge Bases')) throw new Error('guide 缺少 KB 列表段');

  const search = await client.callTool({
    name: 'search',
    arguments: { knowledge_base: 'default', mode: 'list', path: '*' },
  });
  console.log('✓ search(list) →', search.content[0].text.split('\n')[0]);

  console.log('\n全部通过');
  process.exit(0);
} catch (err) {
  console.error('✗ 冒烟失败:', err.message);
  process.exit(1);
} finally {
  await client.close().catch(() => {});
}
