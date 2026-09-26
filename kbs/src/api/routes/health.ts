import { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  // 对齐 llm_wiki/api/routes/health.py：docker healthcheck 依赖此形状
  app.get('/health', async () => ({ status: 'ok' }));
}
