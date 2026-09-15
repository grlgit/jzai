import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../../model-router/model-router.service';
import { DbService } from '../../db/db.service';
import * as express from 'express';

/**
 * LLM proxy service for CoWorker instances.
 * Exposes OpenAI-compatible /chat/completions endpoint.
 * Routes requests through the platform's ModelRouter.
 */
@Injectable()
export class CoWorkerProxyService {
  private readonly logger = new Logger(CoWorkerProxyService.name);

  constructor(
    private readonly modelRouter: ModelRouterService,
    private readonly db: DbService,
  ) {}

  /**
   * Proxy an OpenAI-compatible chat/completions request to the configured LLM.
   * Supports both streaming and non-streaming modes.
   */
  async chatCompletions(
    body: any,
    assignmentId: string,
    res: express.Response,
  ): Promise<void> {
    const model = this.modelRouter.resolveModel();
    const apiKey = this.modelRouter.getLlmAuthToken(model.provider);
    const isStream = body.stream === true;

    // Debug: log the request to check for system prompt
    console.log(`[LLMProxy] Request: assignmentId=${assignmentId?.slice(0,8)}, messages count=${body.messages?.length}`);
    if (body.messages && body.messages.length > 0) {
      const firstMessage = body.messages[0];
      console.log(`[LLMProxy] First message: role=${firstMessage.role}, content length=${firstMessage.content?.length || 0}, preview=${firstMessage.content?.slice(0,100) || ''}...`);
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    // Replace model id with actual resolved model
    const proxyBody = { ...body, model: model.id };

    try {
      const resp = await fetch(`${model.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(proxyBody),
        signal: AbortSignal.timeout(120000),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        this.logger.error(`LLM proxy error: ${resp.status} ${errorText.slice(0, 200)}`);
        res.status(resp.status).json({ error: { message: 'LLM 请求失败', detail: errorText.slice(0, 500) } });
        return;
      }

      if (isStream) {
        // Stream SSE response
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const reader = resp.body?.getReader();
        if (!reader) {
          res.status(502).json({ error: { message: 'No response body' } });
          return;
        }

        const decoder = new TextDecoder();
        let totalTokens = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            if (!res.writableEnded) res.write(chunk);
            totalTokens += Math.ceil(chunk.length / 4);
          }
        } finally {
          reader.releaseLock();
          if (!res.writableEnded) res.end();
        }

        // Record cost
        this.recordUsage(assignmentId, totalTokens);
      } else {
        // Non-streaming response
        const data = await resp.json();
        res.json(data);

        // Record cost
        const usage = (data as any)?.usage;
        if (usage) {
          this.recordUsage(assignmentId, (usage.prompt_tokens || 0) + (usage.completion_tokens || 0));
        }
      }
    } catch (err: any) {
      this.logger.error(`LLM proxy exception: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'LLM 服务不可用', detail: err.message } });
      }
    }
  }

  /**
   * Proxy embeddings request.
   */
  async embeddings(body: any, res: express.Response): Promise<void> {
    const model = this.modelRouter.resolveModel();
    const apiKey = this.modelRouter.getLlmAuthToken(model.provider);

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    try {
      const resp = await fetch(`${model.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        res.status(resp.status).json({ error: { message: 'Embeddings 请求失败', detail: errorText.slice(0, 500) } });
        return;
      }

      const data = await resp.json();
      res.json(data);
    } catch (err: any) {
      this.logger.error(`Embeddings proxy exception: ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: '嵌入服务不可用', detail: err.message } });
      }
    }
  }

  private recordUsage(assignmentId: string, tokens: number): void {
    // Estimate cost and record
    const model = this.modelRouter.resolveModel();
    const costPerToken = model.cost?.output || 0.002;
    const cost = (tokens / 1000) * costPerToken;
    this.modelRouter.recordCost(cost);

    // Record event for analytics
    this.db.query(
      `INSERT INTO jz_coworker_events (id, assignment_id, event_type, payload)
       VALUES ($1, $2, 'llm_usage', $3)`,
      [
        require('crypto').randomUUID(),
        assignmentId,
        JSON.stringify({ tokens, cost, model: model.id }),
      ],
    ).catch(err => this.logger.debug(`Usage recording failed: ${err.message}`));
  }
}
