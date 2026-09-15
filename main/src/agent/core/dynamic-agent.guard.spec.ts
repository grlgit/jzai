import { evalToolRepeatGuard } from './dynamic-agent.service';

/**
 * 防循环守卫纯函数测试。
 * 核心回归：distill_expand_frontier 这类"相同参数反复调用、每批结果不同"的推进型工具
 * 不应被误判为死循环中止（曾因结果含"失败"二字 + 相同参数累计 3 次而误杀整个会话）。
 */
describe('evalToolRepeatGuard', () => {
  const run = (seq: Array<{ failed: boolean; sameResult: boolean; hasStructuredError?: boolean; retryable?: boolean }>) => {
    let count = 0;
    const aborts: boolean[] = [];
    for (const step of seq) {
      const g = evalToolRepeatGuard({
        failed: step.failed,
        sameResult: step.sameResult,
        prevCount: count,
        hasStructuredError: !!step.hasStructuredError,
        retryable: step.retryable,
      });
      count = g.nextCount;
      aborts.push(g.abort);
    }
    return { aborts, finalCount: count };
  };

  it('推进型工具：相同参数但结果每批不同 → 即使报告里含失败项，也永不中止', () => {
    // sameResult=false 模拟"每批结果都在变"（在推进）
    const { aborts, finalCount } = run(
      Array.from({ length: 10 }, () => ({ failed: true, sameResult: false })),
    );
    expect(aborts.every(a => a === false)).toBe(true);
    expect(finalCount).toBe(0);
  });

  it('真死循环：相同参数 + 相同结果 + 失败（legacy）→ 第 3 次中止', () => {
    const { aborts } = run([
      { failed: true, sameResult: true },
      { failed: true, sameResult: true },
      { failed: true, sameResult: true },
    ]);
    expect(aborts).toEqual([false, false, true]);
  });

  it('间歇失败但有进展（结果在变）→ 计数清零，不累加', () => {
    const { aborts, finalCount } = run([
      { failed: true, sameResult: true },   // count=1
      { failed: true, sameResult: false },  // 进展 → reset 0
      { failed: true, sameResult: true },   // count=1
      { failed: true, sameResult: false },  // 进展 → reset 0
      { failed: true, sameResult: true },   // count=1
    ]);
    expect(aborts.every(a => a === false)).toBe(true);
    expect(finalCount).toBe(1);
  });

  it('成功即清零', () => {
    const { finalCount } = run([
      { failed: true, sameResult: true },   // count=1
      { failed: false, sameResult: true },  // 成功 → reset 0
    ]);
    expect(finalCount).toBe(0);
  });

  it('结构化永久错误：相同参数+相同结果 → 第 2 次即中止', () => {
    const { aborts } = run([
      { failed: true, sameResult: true, hasStructuredError: true, retryable: false },
      { failed: true, sameResult: true, hasStructuredError: true, retryable: false },
    ]);
    expect(aborts).toEqual([false, true]);
  });

  it('结构化可重试错误：放宽到第 5 次才中止', () => {
    const seq = Array.from({ length: 5 }, () => ({ failed: true, sameResult: true, hasStructuredError: true, retryable: true }));
    const { aborts } = run(seq);
    expect(aborts).toEqual([false, false, false, false, true]);
  });
});
