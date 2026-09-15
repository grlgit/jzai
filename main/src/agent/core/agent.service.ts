import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from '../../platform/analytics/analytics.service';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly analytics: AnalyticsService,
  ) {}

  async recordMessage(conversationId: string, contentLength: number, userId?: string) {
    await this.analytics.recordEvent({
      type: 'conversation_message',
      conversationId,
      contentLength,
      userId,
    });
  }

  async recordToolCall(conversationId: string, toolName: string, userId?: string) {
    await this.analytics.recordEvent({
      type: 'tool_call',
      conversationId,
      toolName,
      userId,
    });
  }

  async recordComplete(conversationId: string, durationMs: number, model: string, cost: number, tokens: { input: number; output: number; total: number }, userId?: string) {
    await this.analytics.recordEvent({
      type: 'conversation_complete',
      conversationId,
      durationMs,
      model,
      cost,
      tokensInput: tokens.input,
      tokensOutput: tokens.output,
      tokensTotal: tokens.total,
      routeType: model.startsWith('Local') || model.includes('qwen') ? 'local' : 'cloud',
      userId,
    });
  }
}
