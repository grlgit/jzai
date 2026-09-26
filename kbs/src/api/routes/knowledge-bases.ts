/**
 * 对译 llm_wiki/api/routes/knowledge_bases.py（pg_local 静态单例 KB）。
 */
import { FastifyInstance } from 'fastify';
import { Db } from '../../shared/db';
import { resolveUserId } from '../../shared/scopes';

export function knowledgeBasesRoutes(db: Db) {
  return async function (app: FastifyInstance) {
    async function listKb(userId: string) {
      const src = await db.query(
        "SELECT count(*)::int AS c FROM jz_kb_documents WHERE source_kind != 'wiki' AND status != 'failed'",
      );
      const wiki = await db.query(
        "SELECT count(*)::int AS c FROM jz_kb_documents WHERE source_kind = 'wiki' AND status != 'failed'",
      );
      return [
        {
          id: 'default',
          user_id: userId,
          name: 'Enterprise Mind',
          slug: 'default',
          description: null,
          source_count: src.rows[0]?.c ?? 0,
          wiki_page_count: wiki.rows[0]?.c ?? 0,
          created_at: null,
          updated_at: null,
        },
      ];
    }

    app.get('/v1/knowledge-bases', async (req) => listKb(resolveUserId(req)));

    app.get('/v1/knowledge-bases/:kb_id', async (req, reply) => {
      const kbs = await listKb(resolveUserId(req));
      if (!kbs[0]) return reply.code(404).send({ detail: 'Knowledge base not found' });
      return kbs[0];
    });

    app.post('/v1/knowledge-bases', async (req, reply) => {
      const kbs = await listKb(resolveUserId(req));
      return reply.code(201).send(kbs[0]);
    });

    app.patch('/v1/knowledge-bases/:kb_id', async (req, reply) => {
      const body = (req.body || {}) as { name?: string; description?: string };
      if (!body.name && !body.description) {
        return reply.code(400).send({ detail: 'No fields to update' });
      }
      const kbs = await listKb(resolveUserId(req));
      return kbs[0];
    });

    app.delete('/v1/knowledge-bases/:kb_id', async (_req, reply) => {
      return reply.code(400).send({ detail: 'Cannot delete workspace in local mode' });
    });
  };
}
