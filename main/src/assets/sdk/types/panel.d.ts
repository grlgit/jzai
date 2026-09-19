/**
 * 面板契约（与 web 端 DynamicPanelLoader 实际注入保持一致）。
 *
 * 平台加载流程：DynamicPanelLoader 先挂载 window.__JZ_SDK__ = { react }，
 * 再 import() 面板 ESM bundle，最后以 <Comp initialData onMessage sdk> 渲染。
 */

/** 面板 → Agent 结构化消息（PLAT-012）。context 可携带 scenarioId/revision 等业务引用。 */
export interface AgentMessage {
  text: string;
  context?: Record<string, unknown>;
}

/** 宿主注入的运行时。react 为共享实例（经 react-shim 使用，一般不直接访问）。 */
export interface HostSdk {
  react: any;
  /**
   * 向当前会话的智能体发送消息。宿主自动附加当前用户、APP、panel 与会话身份；
   * 仅能发给面板 manifest 绑定的 Agent，面板无法指定目标或伪造用户。
   */
  agent?: {
    send(msg: AgentMessage): Promise<void>;
  };
}

/** 面板 props。泛型 T 为 agent → 面板消息的数据形状（由你的 messageSchema 校验）。 */
export interface PanelProps<T = unknown> {
  /** agent 消息注入的数据（面板 ↔ agent 双向通道） */
  initialData?: T;
  /** 面板 → agent 发消息 */
  onMessage?: (msg: unknown) => void;
  /** 宿主 SDK（见 HostSdk；HTTP 调用请用 SDK 自带的 lib/panel-api.ts） */
  sdk?: HostSdk;
}

/** 面板元信息（可选导出，供宿主读取最小尺寸）。 */
export interface PanelMeta {
  id: string;
  minWidth?: number;
  minHeight?: number;
}
