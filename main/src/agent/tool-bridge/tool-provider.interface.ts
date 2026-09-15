/**
 * ToolProvider interface — implemented by each domain's *.tools.ts.
 * ToolBridgeService collects all providers and builds tool sets for agents.
 */
export interface ToolProvider {
  /** Tool IDs this provider handles (e.g. ['kb_mcp', 'knowledge']) */
  readonly toolIds: string[];

  /** Optional per-tool output character limits. Providers declare their own truncation budget. */
  readonly tokenLimits?: Record<string, number>;

  /** Catalog entries for settings UI */
  getCatalog(): ToolCatalogEntry[];

  /** Create tool instances for pi-agent */
  createTools(ctx: ToolContext): Promise<ToolInstance[]>;
}

export interface ToolCatalogEntry {
  id: string;
  label: string;
  group: string;
}

export interface ToolContext {
  userId?: string;
  agentKey?: string;
  userEmail?: string;
  piAi?: any;
}

export interface ToolInstance {
  name: string;
  label?: string;
  description: string;
  parameters: any;
  execute: (...args: any[]) => Promise<any>;
}

/** DI injection token for multi-provider collection */
export const TOOL_PROVIDERS = 'TOOL_PROVIDERS';
