/**
 * app:updated socket 事件（面板热重载，design-app-dev-mcp D6/P3.1）。
 *
 * 安装/升级成功后向所有在线主台广播，前端 useSidebar 收到后重新拉取
 * sidebar——sidebar 返回的 appVersion 变化使 DynamicPanelLoader 的
 * assets URL（?v=<version>）变化，面板 ESM 自动重 import。
 *
 * 经 global.nestApp + lazy require 解析 ChatGateway，避免模块循环
 * （AgentModule → AppStoreModule），发送失败只记调试日志（best effort）。
 */
export function emitAppUpdated(appId: string, version: string): void {
  try {
    const app = (global as any).nestApp;
    if (!app) return;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ChatGateway } = require('../../../agent/core/agent.gateway');
    const gateway = app.get(ChatGateway, { strict: false });
    gateway?.server?.emit('app:updated', { appId, version });
  } catch {
    // 推送失败不影响安装/升级主流程（前端下次刷新仍会拿到新版本）
  }
}
