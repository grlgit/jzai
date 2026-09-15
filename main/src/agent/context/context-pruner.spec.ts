import { ContextPrunerService } from './context-pruner.service';

const pruner = new ContextPrunerService();

function createAgent(messages: any[], contextConfig: any = {}, pinnedState?: string) {
  const agent: any = { state: { messages }, _contextConfig: contextConfig };
  if (pinnedState) agent._pinnedState = pinnedState;
  return agent;
}

function toolMsg(size: number) { return { role: 'tool', content: 'x'.repeat(size) }; }
function assistantMsg(size: number) { return { role: 'assistant', content: 'y'.repeat(size) }; }
function userMsg(text = 'user message') { return { role: 'user', content: text }; }

describe('ContextPrunerService.pruneOldToolResults', () => {

  test('should not prune when messages < 6', () => {
    const agent = createAgent([userMsg(), assistantMsg(100), toolMsg(5000), assistantMsg(200)]);
    const before = pruner.calcContextChars(agent.state.messages);
    pruner.pruneOldToolResults(agent, 1000);
    expect(pruner.calcContextChars(agent.state.messages)).toBe(before);
  });

  test('should clear old tool results but preserve recent turns', () => {
    const agent = createAgent([
      userMsg(), assistantMsg(100), toolMsg(10000), assistantMsg(100), toolMsg(10000), assistantMsg(100),
      toolMsg(10000), assistantMsg(100), userMsg(), assistantMsg(100),
    ]);
    pruner.pruneOldToolResults(agent, 5000);
    expect(agent.state.messages[2].content).toContain('[已清理]');
    expect(agent.state.messages[4].content).toContain('[已清理]');
    expect(agent.state.messages[6].content.length).toBe(10000); // recent, preserved
  });

  test('should trim long assistant messages to 500 chars', () => {
    const agent = createAgent([
      userMsg(), assistantMsg(3000), toolMsg(500), assistantMsg(100),
      userMsg(), assistantMsg(100), toolMsg(100), assistantMsg(100),
    ]);
    pruner.pruneOldToolResults(agent, 1000);
    expect(agent.state.messages[1].content.length).toBeLessThan(600);
    expect(agent.state.messages[1].content).toContain('已压缩');
  });

  test('should never prune user or system messages', () => {
    const agent = createAgent([
      { role: 'system', content: 'x'.repeat(5000) }, userMsg('a'.repeat(5000)),
      assistantMsg(100), toolMsg(10000), userMsg(), assistantMsg(100), toolMsg(100), assistantMsg(100),
    ]);
    pruner.pruneOldToolResults(agent, 1000);
    expect(agent.state.messages[0].content.length).toBe(5000);
    expect(agent.state.messages[1].content.length).toBe(5000);
  });

  test('should respect per-agent keepRecentTurns config', () => {
    const agent = createAgent([
      userMsg(), assistantMsg(100), toolMsg(10000), assistantMsg(100),
      toolMsg(10000), assistantMsg(100), userMsg(), assistantMsg(100), toolMsg(500), assistantMsg(100),
    ], { keepRecentTurns: 3 });
    pruner.pruneOldToolResults(agent, 5000);
    expect(agent.state.messages[2].content).toContain('[已清理]');
    expect(agent.state.messages[4].content.length).toBe(10000); // in recent 6
  });

  test('should return pruned count', () => {
    const agent = createAgent([
      userMsg(), assistantMsg(100), toolMsg(10000), assistantMsg(100),
      toolMsg(10000), assistantMsg(100), userMsg(), assistantMsg(100),
    ]);
    const count = pruner.pruneOldToolResults(agent, 5000);
    expect(count).toBeGreaterThan(0);
  });
});

describe('ContextPrunerService.reinjectPinnedState', () => {

  test('should inject pinned state at beginning', () => {
    const agent = createAgent([userMsg(), assistantMsg(100)], {}, '用户需要工单甘特图');
    pruner.reinjectPinnedState(agent);
    expect(agent.state.messages[0].content).toContain('[钉住状态');
    expect(agent.state.messages[0].content).toContain('用户需要工单甘特图');
    expect(agent.state.messages.length).toBe(4);
  });

  test('should not inject if no pinned state', () => {
    const agent = createAgent([userMsg(), assistantMsg(100)]);
    pruner.reinjectPinnedState(agent);
    expect(agent.state.messages.length).toBe(2);
  });

  test('should not duplicate if already injected', () => {
    const agent = createAgent([
      { role: 'user', content: '[钉住状态 — 关键决策和进度，不可遗忘]\n\n已有的' },
      { role: 'assistant', content: '已记录。' },
      userMsg(), assistantMsg(100),
    ], {}, '新 pinned');
    pruner.reinjectPinnedState(agent);
    expect(agent.state.messages.length).toBe(4); // no duplication
  });
});

describe('ContextPrunerService.calcContextChars', () => {

  test('should calculate string content correctly', () => {
    expect(pruner.calcContextChars([{ content: 'hello' }, { content: 'world' }])).toBe(10);
  });

  test('should handle array content', () => {
    const msgs = [{ content: [{ type: 'text', text: 'hello' }] }];
    expect(pruner.calcContextChars(msgs)).toBeGreaterThan(0);
  });
});
