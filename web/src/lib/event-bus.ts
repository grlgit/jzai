/**
 * 事件总线系统
 *
 * 提供跨组件通信能力，支持图纸大师相关的各种事件
 */

type EventCallback = (data?: any) => void;

/**
 * 事件类型定义
 */
export const DRAWING_EVENTS = {
  // 参数变更事件
  PARAMETER_CHANGED: 'drawing:param-changed',

  // 尺寸确认事件
  DIMENSION_CONFIRMED: 'drawing:dimension-confirmed',

  // 尺寸排除事件
  DIMENSION_EXCLUDED: 'drawing:dimension-excluded',

  // 学习系统更新事件
  LEARNING_UPDATED: 'drawing:learning-updated',

  // 气泡位置调整事件
  Bubble_POSITION_CHANGED: 'drawing:bubble-position-changed',

  // 排序策略变更事件
  STRATEGY_CHANGED: 'drawing:strategy-changed',

  // PDF 文件加载事件
  PDF_LOADED: 'drawing:pdf-loaded',

  // 过滤结果更新事件
  FILTER_UPDATED: 'drawing:filter-updated',

  // 用户操作事件
  USER_ACTION: 'drawing:user-action',
} as const;

type DrawingEventType = typeof DRAWING_EVENTS[keyof typeof DRAWING_EVENTS];

/**
 * 事件监听器接口
 */
interface EventListener {
  event: string;
  callback: EventCallback;
  once: boolean;
}

/**
 * 事件总线类
 */
class EventBus {
  private listeners: EventListener[] = [];
  private eventLog: Array<{ event: string; data: any; timestamp: number }> = [];
  private maxLogSize = 100;

  /**
   * 注册事件监听器
   *
   * @param event 事件名称
   * @param callback 回调函数
   * @param once 是否只触发一次
   */
  on(event: string, callback: EventCallback, once = false): () => void {
    const listener: EventListener = { event, callback, once };
    this.listeners.push(listener);

    // 返回取消监听的函数
    return () => this.off(event, callback);
  }

  /**
   * 注册一次性事件监听器
   *
   * @param event 事件名称
   * @param callback 回调函数
   */
  once(event: string, callback: EventCallback): () => void {
    return this.on(event, callback, true);
  }

  /**
   * 移除事件监听器
   *
   * @param event 事件名称
   * @param callback 回调函数（可选，不提供则移除所有该事件的监听器）
   */
  off(event: string, callback?: EventCallback): void {
    if (callback) {
      this.listeners = this.listeners.filter(
        listener => !(listener.event === event && listener.callback === callback)
      );
    } else {
      this.listeners = this.listeners.filter(listener => listener.event !== event);
    }
  }

  /**
   * 触发事件
   *
   * @param event 事件名称
   * @param data 事件数据
   */
  emit(event: string, data?: any): void {
    // 记录事件日志
    this.logEvent(event, data);

    // 查找匹配的监听器
    const matchedListeners = this.listeners.filter(listener => listener.event === event);

    // 触发监听器
    matchedListeners.forEach(listener => {
      try {
        listener.callback(data);
      } catch (err) {
        console.error(`[EventBus] Error in event handler for ${event}:`, err);
      }
    });

    // 移除一次性监听器
    if (matchedListeners.length > 0) {
      this.listeners = this.listeners.filter(
        listener => !(listener.event === event && listener.once)
      );
    }
  }

  /**
   * 清除所有事件监听器
   */
  clear(): void {
    this.listeners = [];
  }

  /**
   * 获取事件监听器数量
   */
  listenerCount(event?: string): number {
    if (event) {
      return this.listeners.filter(listener => listener.event === event).length;
    }
    return this.listeners.length;
  }

  /**
   * 获取所有事件名称
   */
  getEvents(): string[] {
    return Array.from(new Set(this.listeners.map(listener => listener.event)));
  }

  /**
   * 记录事件日志
   */
  private logEvent(event: string, data: any): void {
    this.eventLog.push({
      event,
      data,
      timestamp: Date.now(),
    });

    // 限制日志大小
    if (this.eventLog.length > this.maxLogSize) {
      this.eventLog = this.eventLog.slice(-this.maxLogSize);
    }
  }

  /**
   * 获取事件日志
   */
  getEventLog(event?: string): Array<{ event: string; data: any; timestamp: number }> {
    if (event) {
      return this.eventLog.filter(log => log.event === event);
    }
    return [...this.eventLog];
  }

  /**
   * 清除事件日志
   */
  clearEventLog(): void {
    this.eventLog = [];
  }
}

// 创建全局事件总线实例
export const eventBus = new EventBus();

/**
 * 图纸大师特定事件发射器
 */
export const emitDrawingEvent = {
  /**
   * 发射参数变更事件
   */
  parameterChanged: (parameter: string, value: any) => {
    eventBus.emit(DRAWING_EVENTS.PARAMETER_CHANGED, { parameter, value });
  },

  /**
   * 发射尺寸确认事件
   */
  dimensionConfirmed: (dimensionId: string, dimension: any) => {
    eventBus.emit(DRAWING_EVENTS.DIMENSION_CONFIRMED, { dimensionId, dimension });
  },

  /**
   * 发射尺寸排除事件
   */
  dimensionExcluded: (dimensionId: string, dimension: any) => {
    eventBus.emit(DRAWING_EVENTS.DIMENSION_EXCLUDED, { dimensionId, dimension });
  },

  /**
   * 发射学习更新事件
   */
  learningUpdated: (profile: any) => {
    eventBus.emit(DRAWING_EVENTS.LEARNING_UPDATED, { profile });
  },

  /**
   * 发射气泡位置变更事件
   */
  bubblePositionChanged: (dimensionId: string, position: { x: number; y: number }) => {
    eventBus.emit(DRAWING_EVENTS.Bubble_POSITION_CHANGED, { dimensionId, position });
  },

  /**
   * 发射排序策略变更事件
   */
  strategyChanged: (strategy: string) => {
    eventBus.emit(DRAWING_EVENTS.STRATEGY_CHANGED, { strategy });
  },

  /**
   * 发射PDF加载事件
   */
  pdfLoaded: (fileName: string, dimensions: any[]) => {
    eventBus.emit(DRAWING_EVENTS.PDF_LOADED, { fileName, dimensions });
  },

  /**
   * 发射过滤更新事件
   */
  filterUpdated: (filterResult: any) => {
    eventBus.emit(DRAWING_EVENTS.FILTER_UPDATED, { filterResult });
  },

  /**
   * 发射用户操作事件
   */
  userAction: (action: string, data: any) => {
    eventBus.emit(DRAWING_EVENTS.USER_ACTION, { action, data });
  },
};

/**
 * 图纸大师特定事件监听器
 */
export const onDrawingEvent = {
  /**
   * 监听参数变更
   */
  onParameterChanged: (callback: (data: { parameter: string; value: any }) => void) => {
    return eventBus.on(DRAWING_EVENTS.PARAMETER_CHANGED, callback);
  },

  /**
   * 监听尺寸确认
   */
  onDimensionConfirmed: (callback: (data: { dimensionId: string; dimension: any }) => void) => {
    return eventBus.on(DRAWING_EVENTS.DIMENSION_CONFIRMED, callback);
  },

  /**
   * 监听尺寸排除
   */
  onDimensionExcluded: (callback: (data: { dimensionId: string; dimension: any }) => void) => {
    return eventBus.on(DRAWING_EVENTS.DIMENSION_EXCLUDED, callback);
  },

  /**
   * 监听学习更新
   */
  onLearningUpdated: (callback: (data: { profile: any }) => void) => {
    return eventBus.on(DRAWING_EVENTS.LEARNING_UPDATED, callback);
  },

  /**
   * 监听气泡位置变更
   */
  onBubblePositionChanged: (callback: (data: { dimensionId: string; position: { x: number; y: number } }) => void) => {
    return eventBus.on(DRAWING_EVENTS.Bubble_POSITION_CHANGED, callback);
  },

  /**
   * 监听排序策略变更
   */
  onStrategyChanged: (callback: (data: { strategy: string }) => void) => {
    return eventBus.on(DRAWING_EVENTS.STRATEGY_CHANGED, callback);
  },

  /**
   * 监听PDF加载
   */
  onPdfLoaded: (callback: (data: { fileName: string; dimensions: any[] }) => void) => {
    return eventBus.on(DRAWING_EVENTS.PDF_LOADED, callback);
  },

  /**
   * 监听过滤更新
   */
  onFilterUpdated: (callback: (data: { filterResult: any }) => void) => {
    return eventBus.on(DRAWING_EVENTS.FILTER_UPDATED, callback);
  },

  /**
   * 监听用户操作
   */
  onUserAction: (callback: (data: { action: string; data: any }) => void) => {
    return eventBus.on(DRAWING_EVENTS.USER_ACTION, callback);
  },
};
