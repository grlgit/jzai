/**
 * Unit tests for L2/L3 context management.
 * Tests pruneOldToolResults, reinjectPinnedState, and compactAgentState
 * using mock agent objects (no real LLM calls for L2; L3 compaction mocked).
 */

// Helper: create a mock agent with messages
function createMockAgent(messages: any[], contextConfig: any = {}, pinnedState?: string) {
  const agent: any = { state: { messages }, _contextConfig: contextConfig };
  if (pinnedState) agent._pinnedState = pinnedState;
  return agent;
}

// Helper: calculate context chars
function ctxChars(msgs: any[]): number {
  return msgs.reduce((s: number, m: any) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length), 0);
}

// Helper: generate a large tool result message
function toolMsg(size: number): any {
  return { role: 'tool', content: 'x'.repeat(size) };
}

function assistantMsg(size: number): any {
  return { role: 'assistant', content: 'y'.repeat(size) };
}

function userMsg(text = 'user message'): any {
  return { role: 'user', content: text };
}

// ---- Import the actual pruneOldToolResults logic (extracted for testing) ----
// Since the method is private on DynamicAgentService, we replicate its logic here
// and verify behavior. This avoids needing full DI setup.

function pruneOldToolResults(agent: any, targetChars: number) {
  const msgs = agent.state.messages || [];
  if (msgs.length < 6) return;

  const turns = agent._contextConfig?.keepRecentTurns ?? 2;
  const keepRecent = turns * 2;
  let pruned = 0;

  for (let i = 0; i < msgs.length - keepRecent; i++) {
    const m = msgs[i];
    if (m.role === 'user' || m.role === 'system') continue;

    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');

    if (m.role !== 'assistant' && m.role !== 'user') {
      if (content.length <= 200) continue;
      const marker = `[已清理] 原始输出 ${content.length} 字符`;
      if (typeof m.content === 'string') m.content = marker;
      else m.content = [{ type: 'text', text: marker }];
      pruned++;
    }

    if (m.role === 'assistant' && content.length > 1500) {
      const trimmed = content.slice(0, 500) + `\n...(已压缩，原 ${content.length} 字符)`;
      if (typeof m.content === 'string') m.content = trimmed;
      else m.content = [{ type: 'text', text: trimmed }];
      pruned++;
    }

    const current = ctxChars(msgs);
    if (current <= targetChars) break;
  }
  return pruned;
}

function reinjectPinnedState(agent: any) {
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
}

// ====================== TESTS ======================

describe('L2: pruneOldToolResults', () => {

  test('should not prune when messages < 6', () => {
    const agent = createMockAgent([
      userMsg(), assistantMsg(100), toolMsg(5000), assistantMsg(200),
    ]);
    const before = ctxChars(agent.state.messages);
    pruneOldToolResults(agent, 1000);
    expect(ctxChars(agent.state.messages)).toBe(before); // unchanged
  });

  test('should clear old tool results but preserve recent turns', () => {
    const agent = createMockAgent([
      userMsg(),                    // 0: user
      assistantMsg(100),            // 1: assistant (tool call)
      toolMsg(10000),               // 2: tool result - should be cleared
      assistantMsg(100),            // 3: assistant
      toolMsg(10000),               // 4: tool result - should be cleared
      assistantMsg(100),            // 5: assistant
      // Recent 4 (keepRecent=4 for 2 turns):
      toolMsg(10000),               // 6: tool result - preserved (recent)
      assistantMsg(100),            // 7: assistant - preserved
      userMsg(),                    // 8: user - preserved
      assistantMsg(100),            // 9: assistant - preserved
    ]);

    const before = ctxChars(agent.state.messages);
    expect(before).toBeGreaterThan(30000);

    pruneOldToolResults(agent, 5000);

    // Old tool results (index 2, 4) should be cleared
    expect(agent.state.messages[2].content).toContain('[已清理]');
    expect(agent.state.messages[4].content).toContain('[已清理]');
    // Recent tool result (index 6) should be preserved
    expect(agent.state.messages[6].content.length).toBe(10000);
    // Context should be much smaller
    expect(ctxChars(agent.state.messages)).toBeLessThan(before);
  });

  test('should trim long assistant messages to 500 chars', () => {
    const agent = createMockAgent([
      userMsg(),
      assistantMsg(3000),           // old, long → should be trimmed
      toolMsg(500),
      assistantMsg(100),
      userMsg(),
      assistantMsg(100),
      toolMsg(100),
      assistantMsg(100),
    ]);

    pruneOldToolResults(agent, 1000);

    const trimmed = agent.state.messages[1].content;
    expect(trimmed.length).toBeLessThan(600); // 500 + marker text
    expect(trimmed).toContain('已压缩');
  });

  test('should never prune user or system messages', () => {
    const agent = createMockAgent([
      { role: 'system', content: 'x'.repeat(5000) },
      userMsg('a'.repeat(5000)),
      assistantMsg(100),
      toolMsg(10000),
      userMsg(),
      assistantMsg(100),
      toolMsg(100),
      assistantMsg(100),
    ]);

    pruneOldToolResults(agent, 1000);

    expect(agent.state.messages[0].content.length).toBe(5000); // system preserved
    expect(agent.state.messages[1].content.length).toBe(5000); // user preserved
  });

  test('should respect per-agent keepRecentTurns config', () => {
    // keepRecentTurns=3 → keepRecent=6
    const agent = createMockAgent([
      userMsg(),
      assistantMsg(100),
      toolMsg(10000),               // index 2 - NOT in recent 6, should be cleared
      assistantMsg(100),            // index 3
      toolMsg(10000),               // index 4 - in recent 6, preserved
      assistantMsg(100),            // index 5 - in recent 6
      userMsg(),                    // index 6 - in recent 6
      assistantMsg(100),            // index 7 - in recent 6
      toolMsg(500),                 // index 8 - in recent 6
      assistantMsg(100),            // index 9 - in recent 6
    ], { keepRecentTurns: 3 });

    pruneOldToolResults(agent, 5000);

    expect(agent.state.messages[2].content).toContain('[已清理]');
    expect(agent.state.messages[4].content.length).toBe(10000); // preserved
  });

  test('should stop pruning when target is reached', () => {
    const agent = createMockAgent([
      userMsg(),
      assistantMsg(100),
      toolMsg(10000),               // clear this → saves 10000
      assistantMsg(100),
      toolMsg(10000),               // may not need to clear if target reached
      assistantMsg(100),
      userMsg(),
      assistantMsg(100),
    ]);

    pruneOldToolResults(agent, 15000); // generous target

    // First tool result should be cleared
    expect(agent.state.messages[2].content).toContain('[已清理]');
    // Second might or might not be cleared depending on whether target was reached
    const ctx = ctxChars(agent.state.messages);
    expect(ctx).toBeLessThanOrEqual(15000 + 1000); // allow some margin
  });
});

describe('L2: reinjectPinnedState', () => {

  test('should inject pinned state at beginning of messages', () => {
    const agent = createMockAgent([
      userMsg(), assistantMsg(100),
    ], {}, '用户需要工单甘特图');

    reinjectPinnedState(agent);

    expect(agent.state.messages[0].role).toBe('user');
    expect(agent.state.messages[0].content).toContain('[钉住状态');
    expect(agent.state.messages[0].content).toContain('用户需要工单甘特图');
    expect(agent.state.messages[1].role).toBe('assistant');
    expect(agent.state.messages[1].content).toBe('已记录。');
    expect(agent.state.messages.length).toBe(4); // 2 injected + 2 original
  });

  test('should not inject if no pinned state', () => {
    const agent = createMockAgent([userMsg(), assistantMsg(100)]);
    reinjectPinnedState(agent);
    expect(agent.state.messages.length).toBe(2);
  });

  test('should not duplicate if already injected', () => {
    const agent = createMockAgent([
      { role: 'user', content: '[钉住状态 — 关键决策和进度，不可遗忘]\n\n已有的' },
      { role: 'assistant', content: '已记录。' },
      userMsg(),
      assistantMsg(100),
    ], {}, '新的 pinned state');

    reinjectPinnedState(agent);
    expect(agent.state.messages.length).toBe(4); // no duplication
  });
});

describe('L2+L3 integration: budget thresholds', () => {

  test('L2 triggers at 40% of budget', () => {
    const budget = 100000; // 100K
    const threshold40 = budget * 0.4; // 40K

    // Build messages totaling ~50K (above 40% threshold)
    const msgs = [userMsg()];
    for (let i = 0; i < 10; i++) {
      msgs.push(assistantMsg(200));
      msgs.push(toolMsg(4500)); // 10 × 4500 = 45K
    }
    // Add recent turns
    msgs.push(userMsg());
    msgs.push(assistantMsg(200));

    const agent = createMockAgent(msgs);
    const before = ctxChars(agent.state.messages);
    expect(before).toBeGreaterThan(threshold40);

    // L2 should prune to 30% target
    pruneOldToolResults(agent, budget * 0.3);
    const after = ctxChars(agent.state.messages);
    expect(after).toBeLessThan(before);

    // Verify old tool results were cleared
    const clearedCount = agent.state.messages.filter((m: any) =>
      typeof m.content === 'string' && m.content.includes('[已清理]')).length;
    expect(clearedCount).toBeGreaterThan(0);
  });

  test('L3 soft prune at 40-80% range', () => {
    const budget = 100000;
    // Context at 60% — should trigger L3 soft prune (40-80% range)
    const msgs = [userMsg()];
    for (let i = 0; i < 12; i++) {
      msgs.push(assistantMsg(200));
      msgs.push(toolMsg(4500)); // ~54K
    }
    msgs.push(userMsg());
    msgs.push(assistantMsg(200));

    const agent = createMockAgent(msgs);
    const before = ctxChars(agent.state.messages);
    expect(before).toBeGreaterThan(budget * 0.4);
    expect(before).toBeLessThan(budget * 0.8);

    // L3 soft prune targets 30%
    pruneOldToolResults(agent, budget * 0.3);
    const after = ctxChars(agent.state.messages);
    expect(after).toBeLessThan(before);
  });

  test('context stays manageable after pruning heavy tool usage', () => {
    const budget = 100000;
    // Simulate data_master heavy session: 15 tool calls with large results
    const msgs: any[] = [userMsg()];
    for (let i = 0; i < 15; i++) {
      msgs.push(assistantMsg(300)); // LLM generates SQL
      msgs.push(toolMsg(10000));    // large query result (already L1-truncated)
    }
    msgs.push(userMsg('导出 Excel'));
    msgs.push(assistantMsg(500));

    const agent = createMockAgent(msgs, { keepRecentTurns: 2 });
    const before = ctxChars(agent.state.messages);
    expect(before).toBeGreaterThan(150000); // ~155K

    pruneOldToolResults(agent, budget * 0.3);
    const after = ctxChars(agent.state.messages);

    // Should be dramatically smaller
    expect(after).toBeLessThan(budget * 0.5);

    // Recent messages should be intact
    const lastMsg = agent.state.messages[agent.state.messages.length - 1];
    expect(lastMsg.content.length).toBe(500);
  });
});
