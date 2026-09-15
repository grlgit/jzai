import { Injectable, Logger } from '@nestjs/common';
import { ModelRouterService } from '../../model-router/model-router.service';

/**
 * ContextCompactorService — L3 semantic compaction with Decision Pinning.
 *
 * Extracted from DynamicAgentService.compactAgentState + compressHistory.
 * Uses LLM to produce: PINNED STATE (decisions, progress) + SUMMARY (recent context).
 * Pinned state accumulates across multiple compactions.
 */
@Injectable()
export class ContextCompactorService {
  private readonly logger = new Logger(ContextCompactorService.name);

  constructor(private readonly modelRouter: ModelRouterService) {}

  /**
   * Semantic compaction: use LLM to summarize conversation, replacing old messages
   * with pinned state + summary + recent turns.
   */
  async compactAgentState(agent: any, targetChars: number): Promise<boolean> {
    const msgs = agent.state.messages || [];
    if (msgs.length < 4) return false;

    try {
      const transcript = msgs
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => {
          const role = m.role === 'user' ? '用户' : 'AI';
          const text = typeof m.content === 'string' ? m.content :
            (Array.isArray(m.content) ? m.content.map((c: any) => c.text || '').join(' ') : '');
          return `[${role}] ${text.slice(0, 600)}`;
        }).join('\n');

      if (transcript.length < 500) return false;

      const existingPinned = agent._pinnedState || '';

      const model = this.modelRouter.resolveModelForLevel('summary');
      const apiKey = this.modelRouter.getLlmAuthToken(model.provider) || '';
      const baseUrl = model.baseUrl || '';

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model.id,
          messages: [{
            role: 'user',
            content: `你是上下文压缩引擎。请将以下AI智能体的工作记录压缩为两部分：

## 第一部分：钉住状态（PINNED STATE）
提取并更新以下持久信息（如有）：
- 用户的核心目标和约束条件
- 已确认的决策和结论（不可遗忘）
- 关键数据点（文件名、ID、数值、配置值）
- 当前任务进度（已完成/进行中/待完成）
${existingPinned ? `\n之前的钉住状态（合并更新，不要重复）：\n${existingPinned}` : ''}

## 第二部分：对话摘要（SUMMARY）
- 最近的操作流程和结果
- 最后一个未完成任务的当前状态
- 丢弃工具原始输出、重复重试、错误信息
- 200字以内

严格按以下格式输出（不加其他内容）：
---PINNED---
（钉住状态内容，300字以内）
---SUMMARY---
（对话摘要内容，200字以内）

工作记录：
${transcript.slice(0, 8000)}`
          }],
          max_tokens: 1500,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) throw new Error(`LLM compaction returned ${resp.status}`);
      const data = await resp.json();
      const raw = data.choices?.[0]?.message?.content?.trim();
      if (!raw || raw.length < 50) throw new Error('LLM compaction returned empty result');

      // Parse structured output
      let pinned = '', summary = '';
      const pinnedMatch = raw.match(/---PINNED---\s*([\s\S]*?)(?:---SUMMARY---|$)/);
      const summaryMatch = raw.match(/---SUMMARY---\s*([\s\S]*?)$/);
      pinned = pinnedMatch?.[1]?.trim() || '';
      summary = summaryMatch?.[1]?.trim() || raw;

      agent._pinnedState = pinned;

      const turns = agent._contextConfig?.keepRecentTurns ?? 2;
      const recent = msgs.slice(-(turns * 2));
      agent.state.messages = [
        ...(pinned ? [{ role: 'user', content: `[钉住状态 — 关键决策和进度，不可遗忘]\n\n${pinned}` },
                       { role: 'assistant', content: '已记录，这些决策和数据我会持续遵守。' }] : []),
        { role: 'user', content: `[上下文压缩摘要]\n\n${summary}` },
        { role: 'assistant', content: '好的，我已了解之前的工作内容，继续。' },
        ...recent,
      ];

      const newCtx = agent.state.messages.reduce((s: number, m: any) =>
        s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
      this.logger.log(`Semantic compaction: ${msgs.length} msgs → ${agent.state.messages.length} msgs, ${Math.round(newCtx / 1000)}K chars (pinned ${pinned.length}ch, summary ${summary.length}ch)`);
      return true;
    } catch (err: any) {
      this.logger.warn(`Semantic compaction failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Compress session history for new agent sessions (continuation).
   */
  async compressHistory(history: any[]): Promise<string> {
    const transcript = history.map((m: any) => {
      const role = m.role === 'user' ? '用户' : 'AI';
      const text = (m.content || '').substring(0, 800);
      return `[${role}] ${text}`;
    }).join('\n');

    if (transcript.length < 1500) return transcript;

    try {
      const model = this.modelRouter.resolveModelForLevel('summary');
      const apiKey = this.modelRouter.getLlmAuthToken(model.provider) || '';
      const baseUrl = model.baseUrl || '';

      const resp = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: model.id,
          messages: [{
            role: 'user',
            content: `请将以下对话历史压缩为简洁的上下文摘要，供AI续接对话使用。

要求：
- 保留用户的核心需求和关键数据（订单号、金额、文件名等）
- 保留AI已完成的操作和结果
- 去掉重复的重试请求、错误信息、无效对话
- 保留最后一个未完成的任务状态
- 用第三人称描述，300字以内

对话历史：
${transcript.substring(0, 6000)}`
          }],
          max_tokens: 1024,
          temperature: 0.1,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!resp.ok) throw new Error(`LLM ${resp.status}`);
      const data = await resp.json();
      const summary = data.choices?.[0]?.message?.content?.trim();
      if (summary && summary.length > 50) return summary;
    } catch (err: any) {
      this.logger.warn(`History compression failed: ${err.message}, using truncated raw`);
    }

    // Fallback: take first and last few messages
    const first = history.slice(0, 2).map((m: any) => `[${m.role === 'user' ? '用户' : 'AI'}] ${(m.content || '').substring(0, 300)}`);
    const last = history.slice(-2).map((m: any) => `[${m.role === 'user' ? '用户' : 'AI'}] ${(m.content || '').substring(0, 300)}`);
    return [...first, '...（中间对话省略）...', ...last].join('\n');
  }
}
