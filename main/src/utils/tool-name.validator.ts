/**
 * 工具名称验证器
 * 确保生成的工具名称符合 LLM API 要求 ^[a-zA-Z0-9_-]+$
 */

/**
 * 验证名称是否符合工具命名规范
 * 规范：只包含字母、数字、下划线和连字符
 *
 * @param name 要验证的名称
 * @returns 是否符合规范
 */
export function isValidToolName(name: string): boolean {
  if (!name || name.length === 0) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * 验证并抛出错误（如果不符合规范）
 *
 * @param name 要验证的名称
 * @param fieldName 字段名（用于错误消息）
 * @throws Error 如果名称不符合规范
 */
export function validateToolName(name: string, fieldName: string = '名称'): void {
  if (!name || name.trim().length === 0) {
    throw new Error(`${fieldName}不能为空`);
  }

  if (!isValidToolName(name)) {
    throw new Error(
      `${fieldName}只能包含字母、数字、下划线和连字符，不能包含中文、空格或特殊字符。` +
      `当前值："${name}" 不符合要求。请使用英文名称，如 "prod_db" 或 "production-system"`
    );
  }
}

/**
 * 生成工具名称前缀（用于生成完整的工具名）
 * 例如：mcp_${connectionName}_tool
 *
 * @param prefix 前缀（如 'mcp_db-'）
 * @param name 原始名称
 * @returns 生成的工具名称
 */
export function generateToolName(prefix: string, name: string): string {
  return `${prefix}${name}`;
}

/**
 * 验证连接/技能名称是否会生成不符合规范的工具名
 *
 * @param name 连接/技能名称
 * @param prefix 工具前缀（如 'mcp_db-'）
 * @throws Error 如果生成的工具名不符合规范
 */
export function validateNameForTool(name: string, prefix: string = ''): void {
  validateToolName(name, '连接名称');

  // 验证带前缀的完整工具名
  const fullToolName = generateToolName(prefix, name);
  if (!isValidToolName(fullToolName)) {
    throw new Error(
      `生成的工具名称 "${fullToolName}" 不符合规范。` +
      `请使用只包含字母、数字、下划线和连字符的名称。`
    );
  }
}
