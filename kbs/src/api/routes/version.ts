import { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

export async function versionRoutes(app: FastifyInstance) {
  // 对齐 llm_wiki/api/main.py 的 GET /version：读 version.json，否则兜底
  app.get('/version', async () => {
    for (const p of [
      path.join(__dirname, 'version.json'),
      path.join(process.cwd(), 'version.json'),
    ]) {
      try {
        if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch {
        /* fall through */
      }
    }
    return { version: 'unknown', component: 'kb' };
  });
}
