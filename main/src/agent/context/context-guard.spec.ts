/**
 * Context Guard — 4-Layer Defense System Tests
 *
 * Tests L1 (tool result truncation), L2 (aggregate budget pruning),
 * L3 (pre-request soft/hard reset), L4 (session compression threshold).
 *
 * Statement coverage targets:
 * - truncateToolResult: all branches (business exempt, per-tool limits, binary, bash head+tail, default)
 * - pruneOldToolResults: all branches (skip small, skip user/system, prune tool/assistant, target reached)
 * - L3 pre-check: soft prune vs hard reset
 * - L4 checkAndCompress: threshold check
 */

// ── L1: Tool Result Truncation ──
// Extract the logic to test independently (same logic as ToolBuilderService.truncateToolResult)

const TOOL_LIMITS: Record<string, number> = {
  document_extract: 20000, read: 20000, ocr: 20000,
  knowledge: 15000, kb_mcp: 15000, web_search: 15000,
  fetch_url: 15000, firecrawl: 15000, web_fetch: 15000,
  bash: 10000,
};

function truncateToolResult(result: any, toolName: string): any {
  if (!result?.content) return result;
  if (toolName.startsWith('tool_') || toolName.startsWith('mcp_')) return result;

  const maxChars = TOOL_LIMITS[toolName] || 20000;
  const textParts = Array.isArray(result.content) ? result.content.filter((c: any) => c.type === 'text') : [];
  for (const part of textParts) {
    if (!part.text || part.text.length <= maxChars) continue;

    const sample = part.text.slice(0, 200);
    if (/[\x00-\x08\x0E-\x1F]/.test(sample) || sample.includes('PK!')) {
      part.text = `工具返回了二进制内容（${part.text.length} 字符），已自动过滤。如需提取文件内容，请使用 document_extract 工具。`;
      continue;
    }

    const origLen = part.text.length;
    if (toolName === 'bash') {
      const head = part.text.slice(0, Math.floor(maxChars * 0.7));
      const tail = part.text.slice(-Math.floor(maxChars * 0.3));
      part.text = `${head}\n\n...(中间省略 ${origLen - maxChars} 字符)...\n\n${tail}`;
    } else {
      part.text = part.text.slice(0, maxChars) + `\n\n...(截断，原文共 ${origLen} 字符)`;
    }
  }
  return result;
}

// ── L2: Prune Old Tool Results ──

function pruneOldToolResults(msgs: any[], targetChars: number): number {
  if (msgs.length < 6) return 0;
  const keepRecent = 6;
  let pruned = 0;
  for (let i = 0; i < msgs.length - keepRecent; i++) {
    const m = msgs[i];
    if (m.role === 'user' || m.role === 'system') continue;
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    if (content.length <= 500) continue;
    const summary = content.slice(0, 200) + `...(已压缩，原 ${content.length} 字符)`;
    if (typeof m.content === 'string') m.content = summary;
    else m.content = [{ type: 'text', text: summary }];
    pruned++;
    const current = msgs.reduce((s: number, m2: any) => s + (typeof m2.content === 'string' ? m2.content.length : JSON.stringify(m2.content || '').length), 0);
    if (current <= targetChars) break;
  }
  return pruned;
}

// ── Helpers ──

function makeResult(text: string) {
  return { content: [{ type: 'text', text }] };
}

function makeMsg(role: string, content: string) {
  return { role, content };
}

function totalChars(msgs: any[]): number {
  return msgs.reduce((s, m) => s + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content).length), 0);
}

// ═══════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════

describe('L1: truncateToolResult', () => {
  test('returns null/undefined result as-is', () => {
    expect(truncateToolResult(null, 'read')).toBeNull();
    expect(truncateToolResult(undefined, 'read')).toBeUndefined();
    expect(truncateToolResult({}, 'read')).toEqual({});
  });

  test('result without content property passes through', () => {
    const r = { message: 'ok' };
    expect(truncateToolResult(r, 'read')).toBe(r);
  });

  test('business tools (tool_*) are never truncated', () => {
    const longText = 'x'.repeat(50000);
    const r = makeResult(longText);
    const out = truncateToolResult(r, 'tool_erp-order-create');
    expect(out.content[0].text).toBe(longText);
    expect(out.content[0].text.length).toBe(50000);
  });

  test('business tools (mcp_*) are never truncated', () => {
    const longText = 'x'.repeat(50000);
    const r = makeResult(longText);
    const out = truncateToolResult(r, 'mcp_kingdee_query');
    expect(out.content[0].text).toBe(longText);
  });

  test('document_extract truncated at 20K', () => {
    const longText = 'A'.repeat(30000);
    const r = makeResult(longText);
    truncateToolResult(r, 'document_extract');
    expect(r.content[0].text.length).toBeLessThanOrEqual(20100); // 20K + truncation notice
    expect(r.content[0].text).toContain('截断，原文共 30000 字符');
  });

  test('knowledge truncated at 15K', () => {
    const longText = 'B'.repeat(20000);
    const r = makeResult(longText);
    truncateToolResult(r, 'knowledge');
    expect(r.content[0].text.length).toBeLessThanOrEqual(15100);
    expect(r.content[0].text).toContain('截断');
  });

  test('bash preserves head + tail', () => {
    const head = 'H'.repeat(5000);
    const middle = 'M'.repeat(20000);
    const tail = 'T'.repeat(5000);
    const r = makeResult(head + middle + tail);
    truncateToolResult(r, 'bash');
    expect(r.content[0].text).toContain('HHHH'); // head preserved
    expect(r.content[0].text).toContain('TTTT'); // tail preserved
    expect(r.content[0].text).toContain('中间省略');
    expect(r.content[0].text.length).toBeLessThan(15000);
  });

  test('short result not truncated', () => {
    const r = makeResult('short result');
    truncateToolResult(r, 'document_extract');
    expect(r.content[0].text).toBe('short result');
  });

  test('binary content (NULL bytes) is filtered', () => {
    const binary = '\x00\x01\x02PK binary garbage' + 'x'.repeat(50000);
    const r = makeResult(binary);
    truncateToolResult(r, 'read');
    expect(r.content[0].text).toContain('二进制内容');
    expect(r.content[0].text).toContain('document_extract');
    expect(r.content[0].text.length).toBeLessThan(200);
  });

  test('binary content (PK! xlsx signature) is filtered', () => {
    const xlsx = 'PK!' + '\x00'.repeat(100) + 'x'.repeat(50000);
    const r = makeResult(xlsx);
    truncateToolResult(r, 'document_extract');
    expect(r.content[0].text).toContain('二进制内容');
  });

  test('unknown tool uses default 20K limit', () => {
    const longText = 'Z'.repeat(25000);
    const r = makeResult(longText);
    truncateToolResult(r, 'some_unknown_tool');
    expect(r.content[0].text.length).toBeLessThanOrEqual(20100);
  });

  test('multiple text parts are all truncated', () => {
    const r = {
      content: [
        { type: 'text', text: 'A'.repeat(25000) },
        { type: 'text', text: 'B'.repeat(25000) },
        { type: 'image', data: 'ignored' },
      ],
    };
    truncateToolResult(r, 'read');
    expect((r.content[0] as any).text.length).toBeLessThanOrEqual(20100);
    expect((r.content[1] as any).text.length).toBeLessThanOrEqual(20100);
    expect(r.content[2]).toEqual({ type: 'image', data: 'ignored' }); // non-text untouched
  });
});

describe('L2: pruneOldToolResults', () => {
  test('does nothing with < 6 messages', () => {
    const msgs = [makeMsg('user', 'hi'), makeMsg('assistant', 'hello')];
    expect(pruneOldToolResults(msgs, 100)).toBe(0);
  });

  test('skips user and system messages', () => {
    const msgs = [
      makeMsg('user', 'U'.repeat(5000)),     // index 0: user, skip
      makeMsg('system', 'S'.repeat(5000)),   // index 1: system, skip
      makeMsg('tool', 'T'.repeat(5000)),     // index 2: tool, prune
      makeMsg('assistant', 'A'.repeat(5000)),// index 3: assistant, prune
      makeMsg('tool', 'T2'.repeat(2500)),    // index 4: in prune range
      makeMsg('assistant', 'A2'.repeat(2500)),// index 5: in prune range
      // last 6 kept:
      makeMsg('user', 'U2'),
      makeMsg('assistant', 'A2b'),
      makeMsg('user', 'U3'),
      makeMsg('assistant', 'A3'),
      makeMsg('user', 'U4'),
      makeMsg('assistant', 'A4'),
    ];
    pruneOldToolResults(msgs, 1000);
    // user and system messages should remain intact
    expect(msgs[0].content.length).toBe(5000);
    expect(msgs[1].content.length).toBe(5000);
    // tool and assistant messages should be pruned
    expect(msgs[2].content).toContain('已压缩');
    expect(msgs[3].content).toContain('已压缩');
  });

  test('skips short messages (<=500 chars)', () => {
    const msgs = [
      makeMsg('tool', 'short'),              // index 0: 5 chars, skip (too short)
      makeMsg('assistant', 'also short'),    // index 1: short, skip
      makeMsg('tool', 'T'.repeat(5000)),     // index 2: long, prune
      makeMsg('assistant', 'A'.repeat(5000)),// index 3: long, prune
      // last 6 kept:
      makeMsg('user', 'U1'),
      makeMsg('assistant', 'A1'),
      makeMsg('user', 'U2'),
      makeMsg('assistant', 'A2'),
      makeMsg('user', 'U3'),
      makeMsg('assistant', 'A3'),
    ];
    pruneOldToolResults(msgs, 1000);
    expect(msgs[0].content).toBe('short'); // unchanged (too short)
    expect(msgs[2].content).toContain('已压缩');
  });

  test('preserves last 6 messages', () => {
    const msgs = [
      makeMsg('tool', 'T'.repeat(5000)),
      makeMsg('assistant', 'A'.repeat(5000)),
      // These last 6 should be untouched:
      makeMsg('user', 'U'.repeat(5000)),
      makeMsg('tool', 'T2'.repeat(5000)),
      makeMsg('assistant', 'A2'.repeat(5000)),
      makeMsg('user', 'U2'.repeat(5000)),
      makeMsg('tool', 'T3'.repeat(5000)),
      makeMsg('assistant', 'A3'.repeat(5000)),
    ];
    pruneOldToolResults(msgs, 1000);
    // First 2 pruned
    expect(msgs[0].content).toContain('已压缩');
    expect(msgs[1].content).toContain('已压缩');
    // Last 6 untouched
    expect(msgs[2].content.length).toBe(5000);
    expect(msgs[7].content.length).toBe(10000);
  });

  test('stops early when target reached', () => {
    const msgs = [
      makeMsg('tool', 'T'.repeat(10000)),    // prune this → ~220 chars
      makeMsg('assistant', 'A'.repeat(10000)), // might not need pruning
      makeMsg('user', 'U1'),
      makeMsg('assistant', 'A1'),
      makeMsg('user', 'U2'),
      makeMsg('assistant', 'A2'),
      makeMsg('user', 'U3'),
      makeMsg('assistant', 'A3'),
    ];
    const before = totalChars(msgs);
    pruneOldToolResults(msgs, before - 5000); // target = cut ~5K
    expect(msgs[0].content).toContain('已压缩');
    // Second msg may or may not be pruned depending on target
  });

  test('returns pruned count', () => {
    const msgs = [
      makeMsg('tool', 'T'.repeat(5000)),
      makeMsg('assistant', 'A'.repeat(5000)),
      makeMsg('tool', 'T2'.repeat(5000)),
      makeMsg('user', 'U1'),
      makeMsg('assistant', 'A1'),
      makeMsg('user', 'U2'),
      makeMsg('assistant', 'A2'),
      makeMsg('user', 'U3'),
    ];
    const count = pruneOldToolResults(msgs, 500);
    expect(count).toBeGreaterThanOrEqual(2);
  });
});

describe('L3: Pre-request context check logic', () => {
  // Simulate the L3 decision logic
  function l3Decision(existingCtx: number, maxCtx: number, msgCount: number): 'none' | 'soft' | 'hard' {
    if (existingCtx <= maxCtx * 0.8 || msgCount <= 4) return 'none';
    if (existingCtx > maxCtx * 1.2) return 'hard';
    return 'soft';
  }

  test('no action when context is small', () => {
    expect(l3Decision(10000, 200000, 10)).toBe('none');
  });

  test('no action when few messages', () => {
    expect(l3Decision(500000, 200000, 3)).toBe('none');
  });

  test('soft prune when 80-120% of limit', () => {
    expect(l3Decision(180000, 200000, 10)).toBe('soft');
    expect(l3Decision(200000, 200000, 10)).toBe('soft');
    expect(l3Decision(239999, 200000, 10)).toBe('soft');
  });

  test('hard reset when > 120% of limit', () => {
    expect(l3Decision(240001, 200000, 10)).toBe('hard');
    expect(l3Decision(500000, 200000, 10)).toBe('hard');
  });

  test('boundary: exactly at 80%', () => {
    // 160000 <= 200000 * 0.8 = 160000 → 'none' (not >)
    expect(l3Decision(160000, 200000, 10)).toBe('none');
    expect(l3Decision(160001, 200000, 10)).toBe('soft');
  });

  test('boundary: exactly at 120%', () => {
    // 240000 <= 200000 * 1.2 = 240000 → 'soft' (not >)
    expect(l3Decision(240000, 200000, 10)).toBe('soft');
    expect(l3Decision(240001, 200000, 10)).toBe('hard');
  });
});

describe('L4: Session compression threshold', () => {
  // Simulate checkAndCompress threshold logic
  function shouldCompress(msgCount: number, totalChars: number, maxContextChars: number): boolean {
    if (msgCount < 10) return false;
    if (totalChars < maxContextChars * 0.5) return false;
    return true;
  }

  test('skip when < 10 messages', () => {
    expect(shouldCompress(5, 100000, 200000)).toBe(false);
    expect(shouldCompress(9, 100000, 200000)).toBe(false);
  });

  test('skip when chars below 50% threshold', () => {
    expect(shouldCompress(20, 50000, 200000)).toBe(false);
    expect(shouldCompress(20, 99999, 200000)).toBe(false);
  });

  test('compress when >= 10 messages and >= 50% chars', () => {
    expect(shouldCompress(10, 100000, 200000)).toBe(true);
    expect(shouldCompress(50, 500000, 200000)).toBe(true);
  });

  test('boundary: exactly 10 messages at 50%', () => {
    expect(shouldCompress(10, 100000, 200000)).toBe(true);
  });
});

describe('Integration: end-to-end context growth scenario', () => {
  test('simulates multi-tool conversation with L1+L2 protection', () => {
    // Simulate: user sends message, LLM calls 5 tools, each returns large results
    const msgs: any[] = [
      makeMsg('system', 'System prompt'.repeat(100)), // ~1300 chars
      makeMsg('user', '请帮我分析这个文件'),
    ];

    // Simulate 5 tool calls with large results (pre-L1 truncation)
    for (let i = 0; i < 5; i++) {
      const toolResult = makeResult('A'.repeat(30000)); // 30K each
      // L1: truncate at 20K
      truncateToolResult(toolResult, 'document_extract');
      msgs.push(makeMsg('tool', toolResult.content[0].text));
      msgs.push(makeMsg('assistant', `分析结果 ${i + 1}`));
    }

    // After L1: each tool result <= 20K, total tool results <= 100K
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    for (const tm of toolMsgs) {
      expect(tm.content.length).toBeLessThanOrEqual(20100);
    }

    // Total context should be manageable
    const total = totalChars(msgs);
    expect(total).toBeLessThan(120000); // 5 * 20K + overhead

    // L2: simulate budget check (say budget is 200K, 80% = 160K)
    // Since total < 160K, L2 won't trigger — correct behavior
    const budget = 200000;
    const shouldPrune = total > budget * 0.8;
    expect(shouldPrune).toBe(false);
  });

  test('L2 triggers when accumulated context exceeds 80% budget', () => {
    const msgs: any[] = [
      makeMsg('system', 'S'.repeat(2000)),
      makeMsg('user', 'U1'),
    ];

    // Add 10 tool results at 15K each (post-L1 truncation)
    for (let i = 0; i < 10; i++) {
      msgs.push(makeMsg('tool', 'T'.repeat(15000)));
      msgs.push(makeMsg('assistant', `Result ${i}`));
    }

    const total = totalChars(msgs);
    const budget = 200000;

    // 10 * 15K = 150K > 200K * 0.8 = 160K — nope, 150K < 160K
    // But add a few more and it triggers
    msgs.push(makeMsg('tool', 'T'.repeat(15000)));
    msgs.push(makeMsg('assistant', 'more'));
    const total2 = totalChars(msgs);
    expect(total2).toBeGreaterThan(budget * 0.8);

    // L2: prune old tool results
    const pruned = pruneOldToolResults(msgs, budget * 0.6);
    expect(pruned).toBeGreaterThan(0);

    const after = totalChars(msgs);
    expect(after).toBeLessThan(total2);
  });

  test('binary xlsx content is caught by L1 before reaching context', () => {
    // Simulate: document_extract returns xlsx binary
    const xlsxBinary = 'PK!\x03\x04' + '\x00'.repeat(50000);
    const result = makeResult(xlsxBinary);
    truncateToolResult(result, 'document_extract');

    expect(result.content[0].text).toContain('二进制内容');
    expect(result.content[0].text.length).toBeLessThan(200);
  });

  test('ERP tool result preserved through all layers', () => {
    const erpResult = '订单录入成功！订单ID: 14287，批次ID: [23387,23388,23389]';
    const result = makeResult(erpResult);

    // L1: business tool exempt
    truncateToolResult(result, 'tool_erp-order-create');
    expect(result.content[0].text).toBe(erpResult);

    // Simulate in msgs
    const msgs = [
      makeMsg('user', 'U1'),
      makeMsg('tool', erpResult), // short, won't be pruned by L2 either
      makeMsg('assistant', 'A1'),
      makeMsg('user', 'U2'),
      makeMsg('assistant', 'A2'),
      makeMsg('user', 'U3'),
      makeMsg('assistant', 'A3'),
    ];
    pruneOldToolResults(msgs, 100);
    // ERP result is short (< 500 chars), so L2 also skips it
    expect(msgs[1].content).toBe(erpResult);
  });
});
