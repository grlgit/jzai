/**
 * Frontend panel message registry.
 *
 * Two kinds of handlers:
 * - static: builtin panels registered at startup via registerPanelHandler
 * - dynamic: extension panels — the manifest declares panels[].messageSchema
 *   (an ESM validator module shipped as an app asset); the sidebar API returns
 *   it, and we import() it on demand (cached), per framework Decision 9.
 *
 * Validator module contract: default export (payload) => normalized | null
 */
import { extractAllPanelMessages, getMessagesForPanel } from './panel-message-parser';

type PanelHandler = (payload: any) => any | null;

export interface PanelMessageSchemaRef {
  id: string;
  sourceAppId?: string | null;
  messageSchema?: string | null;
  appVersion?: string | null;
}

const handlers = new Map<string, PanelHandler>();
const dynamicCache = new Map<string, Promise<PanelHandler | null>>();

const MAIN_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

/** Register a static (builtin) panel message handler. */
export function registerPanelHandler(panelId: string, handler: PanelHandler): void {
  handlers.set(panelId, handler);
}

/** Get a statically registered handler, or undefined if not registered. */
export function getPanelHandler(panelId: string): PanelHandler | undefined {
  return handlers.get(panelId);
}

/** Dynamically import an app's message validator module (cached per URL). */
function loadDynamicHandler(panel: PanelMessageSchemaRef): Promise<PanelHandler | null> {
  const url = `${MAIN_URL}/api/app-store/apps/${panel.sourceAppId}/assets/${panel.messageSchema}?v=${panel.appVersion ?? '0'}`;
  let cached = dynamicCache.get(url);
  if (!cached) {
    cached = import(/* webpackIgnore: true */ url)
      .then((mod: any) => {
        if (typeof mod?.default !== 'function') {
          console.warn(`[panel-message-registry] ${url} 缺少默认导出函数`);
          return null;
        }
        return mod.default as PanelHandler;
      })
      .catch((err: any) => {
        console.warn(`[panel-message-registry] 动态加载面板校验器失败: ${url}`, err?.message ?? err);
        return null;
      });
    dynamicCache.set(url, cached);
  }
  return cached;
}

/**
 * Process all panel messages in the message list and return a patch
 * for agentPanelData. Returns null if nothing changed.
 */
export async function processPanelMessages(
  messages: any[],
  panels: PanelMessageSchemaRef[] = [],
): Promise<Record<string, any> | null> {
  if (messages.length === 0) return null;

  const panelMessages = extractAllPanelMessages(messages);
  if (panelMessages.length === 0) return null;

  const targets = Array.from(new Set(panelMessages.map(m => m.target)));
  const patch: Record<string, any> = {};

  for (const panelId of targets) {
    let handler = handlers.get(panelId);

    if (!handler) {
      const panel = panels.find(p => p.id === panelId);
      if (panel?.sourceAppId && panel?.messageSchema) {
        handler = (await loadDynamicHandler(panel)) ?? undefined;
      }
    }
    if (!handler) continue;

    const panelMsgs = getMessagesForPanel(panelMessages, panelId);
    if (panelMsgs.length === 0) continue;

    const latest = panelMsgs[panelMsgs.length - 1];
    const result = handler(latest.payload);
    if (result !== null && result !== undefined) {
      patch[panelId] = result;
    }
  }

  return Object.keys(patch).length > 0 ? patch : null;
}
