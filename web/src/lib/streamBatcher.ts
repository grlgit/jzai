/**
 * Coalesces high-frequency stream deltas into batched React state updates.
 *
 * Problem: calling setMessages() on every token forces a full re-render of the
 * chat list and ReactMarkdown re-parsing. Batching deltas by ~50ms keeps the UI
 * responsive while dramatically reducing render work.
 */
export interface StreamBatcher {
  /** Append a delta to the internal buffer and schedule a flush. */
  onDelta(delta: string): void;
  /** Seed the buffer with existing text (session re-attach recovery), so subsequent flushes build on it instead of overwriting. */
  seed(text: string): void;
  /** Immediately flush the buffer to the UI and return the current text. */
  flush(): string;
  /** Clear the internal buffer without writing to the UI. */
  reset(): void;
  /** Read the current buffered text (for tests / diagnostics). */
  getBuffer(): string;
}

export interface StreamBatcherOptions {
  /** Returns the id of the assistant message currently being streamed. */
  getAssistantId: () => string;
  /** Flush interval in milliseconds. */
  intervalMs?: number;
}

export function createStreamBatcher(
  setMessages: (updater: (prev: any[]) => any[]) => void,
  options: StreamBatcherOptions,
): StreamBatcher {
  const { getAssistantId, intervalMs = 50 } = options;
  let buffer = '';
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): string => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const currentText = buffer;
    const assistantId = getAssistantId();
    if (assistantId) {
      setMessages(prev => prev.map(m =>
        m.id === assistantId ? { ...m, content: currentText } : m,
      ));
    }
    return currentText;
  };

  const onDelta = (delta: string) => {
    buffer += delta;
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        flush();
      }, intervalMs);
    }
  };

  const reset = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    buffer = '';
  };

  const seed = (text: string) => {
    buffer = text;
  };

  const getBuffer = () => buffer;

  return { onDelta, flush, reset, seed, getBuffer };
}
