/**
 * Panel-Agent 通讯协议 Schema 定义
 *
 * 定义智能体与面板之间通讯的结构化数据契约
 * 使用 Zod 进行运行时验证
 */

import { z } from 'zod';

// ============ 通用消息结构 ============

/**
 * 基础面板消息结构
 */
export const PanelMessageSchema = z.object({
  version: z.literal('1.0'),
  type: z.enum(['panel_data', 'panel_error', 'panel_progress']),
  source: z.string(),          // 智能体ID
  target: z.string(),          // 面板ID
  timestamp: z.number(),
  payload: z.any(),            // 面板特定数据
  metadata: z.object({
    replace: z.boolean().optional(),  // 是否替换现有数据
    sequence: z.number().optional(),  // 消息序号
  }).optional(),
});

export type PanelMessage = z.infer<typeof PanelMessageSchema>;

/**
 * 面板进度消息
 */
export const PanelProgressSchema = z.object({
  version: z.literal('1.0'),
  type: z.literal('panel_progress'),
  source: z.string(),
  target: z.string(),
  timestamp: z.number(),
  payload: z.object({
    step: z.string(),          // 当前步骤描述
    progress: z.number(),      // 进度百分比 0-100
    total: z.number().optional(),
    current: z.number().optional(),
  }),
});

export type PanelProgress = z.infer<typeof PanelProgressSchema>;

/**
 * 面板错误消息
 */
export const PanelErrorSchema = z.object({
  version: z.literal('1.0'),
  type: z.literal('panel_error'),
  source: z.string(),
  target: z.string(),
  timestamp: z.number(),
  payload: z.object({
    code: z.string(),          // 错误码
    message: z.string(),       // 错误信息
    details: z.any().optional(),
  }),
});

export type PanelError = z.infer<typeof PanelErrorSchema>;

// ============ 图纸识别专用Schema ============

/**
 * 尺寸位置信息
 */
const DimensionPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  angle: z.number().optional(),
});

/**
 * 气泡位置信息
 */
const BubblePositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

/**
 * 公差信息
 */
const ToleranceSchema = z.object({
  upper: z.number(),
  lower: z.number(),
});

/**
 * 图形上下文分析结果
 */
const GraphicContextSchema = z.object({
  confidence: z.number().optional(),
  nearbyLines: z.number().optional(),
  nearbyThinLines: z.number().optional(),
  nearbyEndpoints: z.number().optional(),
  hasDimensionPattern: z.boolean().optional(),
  analysis: z.string().optional(),
  arrows: z.object({
    hasArrows: z.boolean().optional(),
    count: z.number().optional(),
    types: z.array(z.string()).optional(),
    positions: z.array(z.string()).optional(),
    confidence: z.number().optional(),
  }).optional(),
  dimensionLines: z.object({
    hasDimensionLines: z.boolean().optional(),
    horizontalLines: z.number().optional(),
    verticalLines: z.number().optional(),
    textPosition: z.string().optional(),
    textToLineDistance: z.number().optional(),
    confidence: z.number().optional(),
  }).optional(),
});

/**
 * 尺寸项
 */
const DimensionSchema = z.object({
  id: z.string(),
  text: z.string().optional(),
  value: z.number(),
  type: z.string(),
  tolerance: ToleranceSchema.optional(),
  position: DimensionPositionSchema,
  bubbleNumber: z.number().optional(),
  bubblePosition: BubblePositionSchema.optional(),
  confidence: z.number().optional(),
  isCritical: z.boolean().optional(),
  inspectionTool: z.string().optional(),
  reasoning: z.any().optional(),    // LLM判断理由
  graphicContext: GraphicContextSchema.optional(),
  filtered: z.boolean().optional(),
  filterReason: z.string().optional().nullable(),
  userAction: z.enum(['confirm', 'exclude']).optional(),
});

/**
 * Excel报告信息
 */
const ExcelReportSchema = z.object({
  fileId: z.string(),
  filename: z.string(),
  downloadUrl: z.string(),
});

/**
 * 图纸分析结果（完整Schema）
 */
export const DrawingAnalysisSchema = z.object({
  mode: z.enum(['parse', 'analyze', 'generate']),

  // parse模式输出
  parse: z.object({
    filePath: z.string(),
    totalDimensions: z.number(),
    dimensions: z.array(DimensionSchema),
    message: z.string(),
  }).optional(),

  // analyze模式输出
  analyze: z.object({
    filePath: z.string(),
    totalDimensions: z.number(),
    filteredCount: z.number(),
    dimensions: z.array(DimensionSchema),
    message: z.string(),
  }).optional(),

  // generate模式输出
  generate: z.object({
    dimensionCount: z.number(),
    criticalCount: z.number(),
    annotatedDrawing: z.string(),
    excelReport: ExcelReportSchema.optional(),
    message: z.string(),
  }).optional(),
});

export type Dimension = z.infer<typeof DimensionSchema>;
export type DrawingAnalysis = z.infer<typeof DrawingAnalysisSchema>;
export type ExcelReport = z.infer<typeof ExcelReportSchema>;

// ============ 辅助函数 ============

/**
 * 创建面板数据消息
 */
export function createPanelDataMessage(
  source: string,
  target: string,
  payload: any,
  options: { replace?: boolean } = {}
): PanelMessage {
  return {
    version: '1.0',
    type: 'panel_data',
    source,
    target,
    timestamp: Date.now(),
    payload,
    metadata: {
      replace: options.replace !== false,
    },
  };
}

/**
 * 创建面板进度消息
 */
export function createPanelProgressMessage(
  source: string,
  target: string,
  step: string,
  progress: number
): PanelProgress {
  return {
    version: '1.0',
    type: 'panel_progress',
    source,
    target,
    timestamp: Date.now(),
    payload: { step, progress },
  };
}

/**
 * 创建面板错误消息
 */
export function createPanelErrorMessage(
  source: string,
  target: string,
  code: string,
  message: string
): PanelError {
  return {
    version: '1.0',
    type: 'panel_error',
    source,
    target,
    timestamp: Date.now(),
    payload: { code, message },
  };
}

/**
 * 验证面板消息
 */
export function validatePanelMessage(data: unknown): PanelMessage | null {
  try {
    return PanelMessageSchema.parse(data);
  } catch (e) {
    console.error('[PanelSchema] Validation failed:', e);
    return null;
  }
}
