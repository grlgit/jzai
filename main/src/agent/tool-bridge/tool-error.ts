/**
 * P0-5 结构化错误传播
 *
 * 统一工具/Skill 执行失败的错误表达，使 Agent 与前端能区分错误类型
 * （参数错 / 认证过期 / 系统宕机 / 超时 / 限流），从而：
 *  - Agent 不再盲目重试永久性错误
 *  - 前端可给用户可操作的引导（如"请更新凭证"）
 *  - 效能看板（P2-17）可按 errorCode 聚合统计
 *
 * 失败有两条路径，本模块同时服务：
 *  - 抛异常 → classifyError(err)（ToolBridge.wrapWithSafety 的 catch）
 *  - Skill 返回 { success:false }（不抛异常）→ structuredFromSkillResult()
 */

export enum ToolErrorCode {
  // 参数类错误（不应重试）
  PARAM_MISSING = 'PARAM_MISSING',
  PARAM_INVALID = 'PARAM_INVALID',
  TOOL_NOT_FOUND = 'TOOL_NOT_FOUND',

  // 认证类错误（需用户介入）
  AUTH_EXPIRED = 'AUTH_EXPIRED',
  AUTH_INVALID = 'AUTH_INVALID',
  AUTH_MISSING = 'AUTH_MISSING',
  PERMISSION_DENIED = 'PERMISSION_DENIED',

  // 目标系统错误（可能可重试）
  SYSTEM_UNAVAILABLE = 'SYSTEM_UNAVAILABLE',
  SYSTEM_TIMEOUT = 'SYSTEM_TIMEOUT',
  SYSTEM_RATE_LIMIT = 'SYSTEM_RATE_LIMIT',

  // 内部错误
  EXECUTION_ERROR = 'EXECUTION_ERROR',
  UNKNOWN = 'UNKNOWN',
}

export interface StructuredToolError {
  code: ToolErrorCode;
  message: string;             // 人类可读的中文说明
  retryable: boolean;          // 是否建议重试（临时错误）
  userActionRequired?: string; // 用户需要做什么
  raw?: string;                // 原始错误信息（调试用）
}

/** 临时性错误码 —— 唯一的可重试集合，retryable 字段由此派生 */
const RETRYABLE_CODES = new Set<ToolErrorCode>([
  ToolErrorCode.SYSTEM_UNAVAILABLE,
  ToolErrorCode.SYSTEM_TIMEOUT,
  ToolErrorCode.SYSTEM_RATE_LIMIT,
]);

export function isRetryable(code: ToolErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** 将异常分类为结构化错误。优先用 HTTP 状态码（可靠），正则仅作兜底。 */
export function classifyError(err: any, _toolName?: string): StructuredToolError {
  const msg = err?.message || String(err ?? '未知错误');
  const status = err?.response?.status || err?.status;

  // 认证 / 权限
  if (status === 401 || status === 403 || /unauthorized|forbidden|token.*expired|登录.*过期|未授权/i.test(msg)) {
    return {
      code: status === 403 ? ToolErrorCode.PERMISSION_DENIED : ToolErrorCode.AUTH_EXPIRED,
      message: status === 403 ? '权限不足，无法执行此操作' : '认证已过期，请重新配置凭证',
      retryable: false,
      userActionRequired: '请在"连接器"面板中更新相关系统的凭证',
      raw: msg,
    };
  }

  // 超时
  if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT|超时/i.test(msg)) {
    return { code: ToolErrorCode.SYSTEM_TIMEOUT, message: '目标系统响应超时', retryable: true, raw: msg };
  }

  // 限流
  if (status === 429 || /rate.?limit|too many requests|限流|请求过于频繁/i.test(msg)) {
    return { code: ToolErrorCode.SYSTEM_RATE_LIMIT, message: '请求过于频繁，已被限流', retryable: true, raw: msg };
  }

  // 系统不可达
  if ((typeof status === 'number' && status >= 500) || /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|503|502|504/i.test(msg)) {
    return { code: ToolErrorCode.SYSTEM_UNAVAILABLE, message: '目标系统暂时不可用', retryable: true, raw: msg };
  }

  // 参数错误
  if (status === 400 || /missing.*param|invalid.*param|参数.*错误|参数.*不合法|必填/i.test(msg)) {
    return { code: ToolErrorCode.PARAM_INVALID, message: `参数错误: ${msg.substring(0, 200)}`, retryable: false, raw: msg };
  }

  // 参数格式错误（日期/数字/JSON 解析失败等）——LLM 通常可自愈（修正格式后重试）
  if (/ParseException|Unparseable|invalid.*(date|number|format)|格式.*(错误|不正确|非法)/i.test(msg)) {
    return {
      code: ToolErrorCode.PARAM_INVALID,
      message: `参数格式错误: ${msg.substring(0, 200)}`,
      retryable: false,
      userActionRequired: '可修正参数格式后重试（如日期使用 YYYY-MM-DD、去除多余空格）',
      raw: msg,
    };
  }

  // 兜底
  return { code: ToolErrorCode.EXECUTION_ERROR, message: `执行失败: ${msg.substring(0, 200)}`, retryable: false, raw: msg };
}

/**
 * 由 Skill 的 { success:false } 结果构造结构化错误。
 * 若 Skill 作者显式给了 code，则直接采用；否则按 message 文本兜底分类。
 */
export function structuredFromSkillResult(
  result: { message?: string; code?: ToolErrorCode; userAction?: string },
  toolName?: string,
): StructuredToolError {
  if (result.code) {
    return {
      code: result.code,
      message: result.message || '执行失败',
      retryable: isRetryable(result.code),
      userActionRequired: result.userAction,
      raw: result.message,
    };
  }
  return classifyError(new Error(result.message || '执行失败'), toolName);
}

/** 统一的面向 LLM/用户的错误展示文案 */
export function formatToolError(s: StructuredToolError): string {
  return s.userActionRequired
    ? `[${s.code}] ${s.message}\n👉 ${s.userActionRequired}`
    : `[${s.code}] ${s.message}`;
}
