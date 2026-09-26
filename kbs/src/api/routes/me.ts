/**
 * 对译 llm_wiki/api/routes/me.py（pg_local 固定本地用户）。
 */
import { FastifyInstance } from 'fastify';
import { resolveUserId } from '../../shared/scopes';

export async function meRoutes(app: FastifyInstance) {
  app.get('/v1/me', async (req) => ({
    id: resolveUserId(req),
    email: 'local@localhost',
    display_name: 'Local User',
    onboarded: true,
  }));

  app.post('/v1/onboarding/complete', async (_req, reply) => reply.code(204).send());
}
