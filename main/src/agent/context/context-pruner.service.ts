import { Injectable, Logger } from '@nestjs/common';

/**
 * ContextPrunerService — L2 context management using Tool Result Clearing strategy.
 *
 * Extracted from DynamicAgentService.pruneOldToolResults + reinjectPinnedState.
 * Per Anthropic's context engineering guide: old tool results are fully cleared,
 * agents rarely need raw results from earlier turns.
 */
@Injectable()
export class ContextPrunerService {
  private readonly logger = new Logger(ContextPrunerService.name);

  /**
   * Prune old tool results and trim verbose assistant messages.
   * Preserves user/system messages and recent turns.
   */
  pruneOldToolResults(agent: any, targetChars: number): number {
    const msgs = agent.state.messages || [];
    if (msgs.length < 6) return 0;

    const turns = agent._contextConfig?.keepRecentTurns ?? 2;
    const keepRecent = turns * 2;
    let pruned = 0;

    // P2-3: prune by token weight — clear the largest prunable messages first.
    // A 50K-char query result and a 200-char reply should not be treated equally;
    // freeing the biggest ones first releases space with fewer deletions and keeps
    // more small, meaningful messages intact.
    const cutoff = Math.max(0, msgs.length - keepRecent);
    const candidates = msgs
      .slice(0, cutoff)
      .filter((m: any) => m.role !== 'user' && m.role !== 'system')
      .map((m: any) => ({ m, size: typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length }))
      .sort((a: { size: number }, b: { size: number }) => b.size - a.size);

    for (const { m } of candidates) {
      if (this.calcContextChars(msgs) <= targetChars) break;

      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');

      if (m.role !== 'assistant') {
        // Tool result messages: clear body but keep first line (often contains IDs, status)
        if (content.length <= 50) continue;
        const rawText = typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.filter((c: any) => c.type === 'text').map((c: any) => c.text || '').join('') : '');
        const firstLine = rawText.split('\n')[0]?.substring(0, 120) || '';
        const marker = `${firstLine}\n[已清理] 原始输出 ${content.length} 字符`;
        if (typeof m.content === 'string') m.content = marker;
        else m.content = [{ type: 'text', text: marker }];
        pruned++;
      } else if (content.length > 1500) {
        // Assistant messages: preserve decision summary, trim verbose reasoning
        const trimmed = content.slice(0, 500) + `\n...(已压缩，原 ${content.length} 字符)`;
        if (typeof m.content === 'string') m.content = trimmed;
        else m.content = [{ type: 'text', text: trimmed }];
        pruned++;
      }
    }

    if (pruned > 0) {
      this.logger.log(`Context pruned (by size): cleared ${pruned} messages (target ${Math.round(targetChars / 1000)}K chars)`);
    }
    return pruned;
  }

  /**
   * Re-inject pinned decision state after pruning.
   * Pinned state contains critical decisions and progress that must survive context clearing.
   */
  reinjectPinnedState(agent: any): void {
    const pinned = agent._pinnedState;
    if (!pinned) return;

    const msgs = agent.state.messages || [];
    const hasPinned = msgs.some((m: any) =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('[钉住状态'));
    if (hasPinned) return;

    msgs.unshift(
      { role: 'user', content: `[钉住状态 — 关键决策和进度，不可遗忘]\n\n${pinned}` },
      { role: 'assistant', content: '已记录。' },
    );
    this.logger.debug(`Re-injected pinned state (${pinned.length}ch) after pruning`);
  }

  /** Calculate total context chars in agent messages */
  calcContextChars(msgs: any[]): number {
    return msgs.reduce((s: number, m: any) =>
      s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
  }
}
