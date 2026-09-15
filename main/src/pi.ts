/**
 * Centralized pi-ai loader.
 * Uses dynamic import() to handle ESM-only packages in NestJS (CJS).
 *
 * Usage:
 *   const pi = await loadPiAi();
 *   const agent = await loadPiAgent();
 */

let _piAi: typeof import('@mariozechner/pi-ai') | null = null;
let _piAgent: typeof import('@mariozechner/pi-agent-core') | null = null;

export async function loadPiAi() {
  if (!_piAi) {
    _piAi = await import('@mariozechner/pi-ai');
  }
  return _piAi;
}

export async function loadPiAgent() {
  if (!_piAgent) {
    _piAgent = await import('@mariozechner/pi-agent-core');
  }
  return _piAgent;
}

// Re-export types (types are erased at runtime, safe for CJS)
export type {
  Model,
  Context,
  Message,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Tool,
  ToolResultMessage,
  TextContent,
  ImageContent,
  SimpleStreamOptions,
  Api,
  Usage,
} from '@mariozechner/pi-ai';

export type {
  AgentOptions,
  AgentState,
  AgentEvent,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  AgentContext,
  StreamFn,
  BeforeToolCallContext,
  BeforeToolCallResult,
  AfterToolCallContext,
  AfterToolCallResult,
  AgentLoopConfig,
  ToolExecutionMode,
} from '@mariozechner/pi-agent-core';
