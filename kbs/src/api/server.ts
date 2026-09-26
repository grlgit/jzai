/**
 * Fastify API 服务装配：CORS、raw body 采集、X-JZ 验签、路由注册。
 */
import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { verifyInternalSignature } from '../shared/signature';
import { Db } from '../shared/db';
import { ProcessorOptions } from '../processor';
import { healthRoutes } from './routes/health';
import { versionRoutes } from './routes/version';
import { knowledgeBasesRoutes } from './routes/knowledge-bases';
import { documentsRoutes } from './routes/documents';
import { searchRoutes } from './routes/search';
import { filesRoutes } from './routes/files';
import { meRoutes } from './routes/me';
import { usageRoutes } from './routes/usage';
import { uploadRoutes } from './routes/upload';

declare module 'fastify' {
  interface FastifyRequest {
    /** 原始请求体（验签需要 sha256(raw bytes)，必须在解析前采集） */
    rawBody: Buffer;
    /** 验签通过后的内部身份（无 X-JZ 头时为 undefined → 本地固定身份） */
    internalUser?: string;
    internalScopes?: string[];
    internalAdminAll?: boolean;
  }
}

export interface ApiServerOptions {
  internalSecret: string;
  db: Db;
  workspacePath: string;
  apiUrl: string;
  processor: ProcessorOptions;
}

export async function buildApiServer(opts: ApiServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 500 * 1024 * 1024 } });

  // raw body 采集（tap，不消费流；防御 string chunk）
  app.addHook('preParsing', (req, _reply, payload, done) => {
    const chunks: Buffer[] = [];
    payload.on('data', (c: Buffer | string) =>
      chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf-8') : c),
    );
    payload.on('end', () => {
      req.rawBody = Buffer.concat(chunks);
    });
    done(null, payload);
  });

  // X-JZ-* 验签（对齐 Python 中间件：无头放行、头不全 401、验签失败 401）
  app.addHook('preValidation', (req, reply, done) => {
    const path = (req.raw.url || '').split('?')[0];
    const result = verifyInternalSignature({
      method: req.method,
      path,
      rawBody: req.rawBody || Buffer.alloc(0),
      headers: {
        user: req.headers['x-jz-user'] as string | undefined,
        scopes: req.headers['x-jz-scopes'] as string | undefined,
        signature: req.headers['x-jz-signature'] as string | undefined,
        timestamp: req.headers['x-jz-timestamp'] as string | undefined,
      },
      secret: opts.internalSecret,
    });
    if (result.kind === 'fail') {
      reply.code(401).send({ detail: result.detail });
      return done(new Error(result.detail));
    }
    if (result.kind === 'ok') {
      req.internalUser = result.user;
      req.internalScopes = result.scopes;
      req.internalAdminAll = result.adminAll;
    }
    done();
  });

  await app.register(healthRoutes);
  await app.register(versionRoutes);
  await app.register(knowledgeBasesRoutes(opts.db));
  await app.register(documentsRoutes(opts.db, opts.apiUrl, opts.workspacePath));
  await app.register(searchRoutes(opts.db));
  await app.register(filesRoutes(opts.workspacePath));
  await app.register(meRoutes);
  await app.register(usageRoutes(opts.db));
  await app.register(uploadRoutes(opts.db, opts.workspacePath, opts.processor));

  return app;
}
