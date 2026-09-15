import { enforceMaxMessages, sanitizeToolPairs, decideL3Action } from './dynamic-agent.service';

describe('enforceMaxMessages', () => {
  const sys = () => ({ role: 'system', content: 'sys' });
  const user = (i: number) => ({ role: 'user', content: `u${i}` });
  const asstTC = (i: number) => ({ role: 'assistant', content: '', tool_calls: [{ id: `c${i}`, function: { name: 'x' } }] });
  const tool = (i: number) => ({ role: 'tool', tool_call_id: `c${i}`, content: `r${i}` });

  it('不超限不动', () => {
    const m = [sys(), user(1)];
    expect(enforceMaxMessages(m, 100)).toBe(0);
  });
  it('超限折叠到 ≤max，保 system，摘要为 user', () => {
    const m: any[] = [sys()];
    for (let i = 0; i < 200; i++) { m.push(user(i)); m.push({ role: 'assistant', content: `a${i}` }); }
    const folded = enforceMaxMessages(m, 100);
    expect(folded).toBeGreaterThan(0);
    expect(m.length).toBeLessThanOrEqual(100);
    expect(m[0].role).toBe('system');
    expect(m[1].role).toBe('user');
  });
  it('折叠后保留区不出现孤儿 tool（切点在干净边界）', () => {
    const m: any[] = [sys()];
    for (let i = 0; i < 120; i++) { m.push(user(i)); m.push(asstTC(i)); m.push(tool(i)); }
    enforceMaxMessages(m, 100);
    for (let k = 0; k < m.length; k++) {
      if (m[k].role === 'tool') {
        const prev = m[k - 1];
        expect(prev && prev.role === 'assistant' && prev.tool_calls?.length > 0).toBe(true);
      }
    }
  });
});

describe('sanitizeToolPairs', () => {
  it('删除孤儿 tool 结果（前面 assistant 无匹配 tool_call）', () => {
    const m: any[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'hi' },           // 无 tool_calls
      { role: 'tool', tool_call_id: 'x', content: 'r' }, // 孤儿
    ];
    const n = sanitizeToolPairs(m);
    expect(n).toBe(1);
    expect(m.find(x => x.role === 'tool')).toBeUndefined();
  });
  it('去掉未应答的 assistant.tool_calls', () => {
    const m: any[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'f' } }] }, // 无对应 tool 结果
      { role: 'user', content: 'next' },
    ];
    const n = sanitizeToolPairs(m);
    expect(n).toBe(1);
    expect(m[0].tool_calls).toBeUndefined();
  });
  it('合法配对不改动', () => {
    const m: any[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'f' } }] },
      { role: 'tool', tool_call_id: 'a', content: 'r' },
    ];
    expect(sanitizeToolPairs(m)).toBe(0);
    expect(m.length).toBe(2);
  });
});

describe('decideL3Action', () => {
  const maxCtx = 100000;

  it('低使用率或消息少时不触发 L3', () => {
    expect(decideL3Action(maxCtx * 0.5, maxCtx, 10, 0, Date.now())).toBe('skip');
    expect(decideL3Action(maxCtx * 0.7, maxCtx, 6, 0, Date.now())).toBe('skip');
  });

  it('中度使用且消息多时使用软裁剪', () => {
    expect(decideL3Action(maxCtx * 0.65, maxCtx, 10, 0, Date.now())).toBe('soft-prune');
    expect(decideL3Action(maxCtx * 0.79, maxCtx, 10, 0, Date.now())).toBe('soft-prune');
  });

  it('高使用率时触发 LLM 压缩', () => {
    expect(decideL3Action(maxCtx * 0.85, maxCtx, 10, 0, Date.now())).toBe('compact');
  });

  it('压缩冷却期内跳过重复压缩', () => {
    const now = Date.now();
    expect(decideL3Action(maxCtx * 0.85, maxCtx, 10, now - 1000, now)).toBe('cooldown');
  });

  it('冷却期过后允许再次压缩', () => {
    const now = Date.now();
    expect(decideL3Action(maxCtx * 0.85, maxCtx, 10, now - 31 * 1000, now)).toBe('compact');
  });
});
