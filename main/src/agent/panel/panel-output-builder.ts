/**
 * Panel Output Builder
 *
 * 为智能体提供结构化面板输出的构建器
 */

import {
  createPanelDataMessage,
  createPanelProgressMessage,
  createPanelErrorMessage,
  type PanelMessage,
  type PanelProgress,
  type PanelError,
} from './panel-schemas';

/**
 * 面板输出构建器
 *
 * 使用方法：
 * ```typescript
 * const builder = new PanelOutputBuilder('dt_dimension_classifier');
 * return builder.toDimensionTuner(analyzeData);
 * ```
 */
export class PanelOutputBuilder {
  private source: string;

  constructor(agentId: string) {
    this.source = agentId;
  }

  /**
   * 构建通用面板数据消息
   */
  private toPanelData(
    target: string,
    payload: any,
    options: { replace?: boolean } = {}
  ): { _panel_output: PanelMessage } {
    const message = createPanelDataMessage(this.source, target, payload, options);
    return { _panel_output: message };
  }

  /**
   * 构建进度消息
   */
  toProgress(
    target: string,
    step: string,
    progress: number
  ): { _panel_output: PanelProgress } {
    const message = createPanelProgressMessage(this.source, target, step, progress);
    return { _panel_output: message };
  }

  /**
   * 构建错误消息
   */
  toError(
    target: string,
    code: string,
    message: string
  ): { _panel_output: PanelError } {
    const errorMsg = createPanelErrorMessage(this.source, target, code, message);
    return { _panel_output: errorMsg };
  }

  /**
   * 发送到图纸识别面板（dimensionTuner）
   */
  toDimensionTuner(data: any, options?: { replace?: boolean }) {
    return this.toPanelData('dimensionTuner', data, options);
  }

  /**
   * 发送到数据仪表面板（dataDashboard）
   */
  toDashboard(data: any, options?: { replace?: boolean }) {
    return this.toPanelData('dataDashboard', data, options);
  }

  /**
   * 发送到任意面板
   */
  toPanel(target: string, data: any, options?: { replace?: boolean }) {
    return this.toPanelData(target, data, options);
  }
}

/**
 * 快捷函数：创建面板输出构建器
 */
export function createPanelOutput(agentId: string): PanelOutputBuilder {
  return new PanelOutputBuilder(agentId);
}
