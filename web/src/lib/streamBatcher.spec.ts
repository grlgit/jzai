import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createStreamBatcher } from './streamBatcher';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const makeSetMessages = () => {
  const calls: { id: string; content: string }[][] = [];
  const setMessages = (updater: (prev: { id: string; content: string }[]) => { id: string; content: string }[]) => {
    calls.push(updater([{ id: 'a', content: '' }]));
  };
  return { setMessages, calls };
};

describe('createStreamBatcher', () => {
  it('coalesces multiple deltas into a single setMessages call', async () => {
    const { setMessages, calls } = makeSetMessages();
    const batcher = createStreamBatcher(setMessages, { getAssistantId: () => 'a', intervalMs: 10 });

    batcher.onDelta('hello ');
    batcher.onDelta('world');
    batcher.onDelta('!');

    assert.strictEqual(calls.length, 0, 'should not flush synchronously');

    await sleep(25);
    assert.strictEqual(calls.length, 1, 'should flush exactly once after interval');
    assert.strictEqual(calls[0][0].content, 'hello world!');
  });

  it('flushes across intervals separately', async () => {
    const { setMessages, calls } = makeSetMessages();
    const batcher = createStreamBatcher(setMessages, { getAssistantId: () => 'a', intervalMs: 10 });

    batcher.onDelta('a');
    await sleep(15);
    batcher.onDelta('b');
    await sleep(15);

    assert.strictEqual(calls.length, 2);
    assert.strictEqual(calls[0][0].content, 'a');
    assert.strictEqual(calls[1][0].content, 'ab');
  });

  it('flush returns current text and applies immediately', () => {
    const { setMessages, calls } = makeSetMessages();
    const batcher = createStreamBatcher(setMessages, { getAssistantId: () => 'a', intervalMs: 50 });

    batcher.onDelta('now');
    assert.strictEqual(calls.length, 0);

    const text = batcher.flush();
    assert.strictEqual(text, 'now');
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0][0].content, 'now');
  });

  it('reset clears buffer without writing to UI', async () => {
    const { setMessages, calls } = makeSetMessages();
    const batcher = createStreamBatcher(setMessages, { getAssistantId: () => 'a', intervalMs: 10 });

    batcher.onDelta('lost');
    batcher.reset();
    await sleep(25);

    assert.strictEqual(calls.length, 0);
    assert.strictEqual(batcher.getBuffer(), '');
  });

  it('does nothing when assistant id is empty', async () => {
    const { setMessages, calls } = makeSetMessages();
    const batcher = createStreamBatcher(setMessages, { getAssistantId: () => '', intervalMs: 10 });

    batcher.onDelta('orphan');
    await sleep(25);

    assert.strictEqual(calls.length, 0);
  });
});
