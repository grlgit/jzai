/**
 * Panel-Agent 通讯协议 Schema 定义（前端版本）
 *
 * 与后端共享的Schema定义，用于运行时验证
 */

// ============ 通用类型定义 ============

export interface PanelMessage {
  version: '1.0';
  type: 'panel_data' | 'panel_error' | 'panel_progress';
  source: string;          // 智能体ID
  target: string;          // 面板ID
  timestamp: number;
  payload: any;            // 面板特定数据
  metadata?: {
    replace?: boolean;     // 是否替换现有数据
    sequence?: number;     // 消息序号
  };
}

export interface PanelProgress {
  version: '1.0';
  type: 'panel_progress';
  source: string;
  target: string;
  timestamp: number;
  payload: {
    step: string;          // 当前步骤描述
    progress: number;      // 进度百分比 0-100
    total?: number;
    current?: number;
  };
}

export interface PanelError {
  version: '1.0';
  type: 'panel_error';
  source: string;
  target: string;
  timestamp: number;
  payload: {
    code: string;          // 错误码
    message: string;       // 错误信息
    details?: any;
  };
}

// ============ 类型守卫 ============

/**
 * 检查是否是PanelMessage
 */
export function isPanelMessage(data: any): data is PanelMessage {
  return (
    data &&
    data.version === '1.0' &&
    typeof data.source === 'string' &&
    typeof data.target === 'string' &&
    ['panel_data', 'panel_error', 'panel_progress'].includes(data.type)
  );
}

/**
 * 检查是否是面板数据消息
 */
export function isPanelDataMessage(data: any): data is PanelMessage {
  return isPanelMessage(data) && data.type === 'panel_data';
}

/**
 * 检查是否是面板进度消息
 */
export function isPanelProgressMessage(data: any): data is PanelProgress {
  return isPanelMessage(data) && data.type === 'panel_progress';
}

/**
 * 检查是否是面板错误消息
 */
export function isPanelErrorMessage(data: any): data is PanelError {
  return isPanelMessage(data) && data.type === 'panel_error';
}

// ============ 辅助函数 ============

/**
 * 从消息块中提取面板消息
 */
export function extractPanelMessage(result: any): PanelMessage | null {
  if (!result) return null;

  // 方法1：检查 _panel_output 字段（推荐）
  if (result._panel_output && isPanelMessage(result._panel_output)) {
    return result._panel_output;
  }

  // 方法1.5：检查 _panel_update 字段（调优工具使用）
  if (result._panel_update && isPanelMessage(result._panel_update)) {
    return result._panel_update;
  }

  // 方法2：检查嵌在data中的结构化消息（兼容）
  if (result.data?._panel_output && isPanelMessage(result.data._panel_output)) {
    return result.data._panel_output;
  }

  // 方法2.5：检查嵌在data中的 _panel_update
  if (result.data?._panel_update && isPanelMessage(result.data._panel_update)) {
    return result.data._panel_update;
  }

  // 方法3：处理skill工具返回的嵌套结构 { content: [...], details: { result: { _panel_output } } }
  if (result.details?.result?._panel_output && isPanelMessage(result.details.result._panel_output)) {
    return result.details.result._panel_output;
  }

  // 方法3.5：处理嵌套结构中的 _panel_update
  if (result.details?.result?._panel_update && isPanelMessage(result.details.result._panel_update)) {
    return result.details.result._panel_update;
  }

  return null;
}
