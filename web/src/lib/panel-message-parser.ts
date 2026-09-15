/**
 * Panel Message Parser
 *
 * 从智能体消息内容块中提取结构化的面板消息
 */

import {
  isPanelMessage,
  extractPanelMessage,
  type PanelMessage,
} from './panel-schemas';

/**
 * 消息块类型
 */
interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'image' | 'thinking' | 'error';
  [key: string]: any;
}

/**
 * 从消息内容块中提取所有面板消息
 */
export function extractPanelMessages(contentBlocks: ContentBlock[]): PanelMessage[] {
  const messages: PanelMessage[] = [];

  for (const block of contentBlocks) {
    // 只处理工具结果块
    if (block.type === 'tool_result' && block.result) {
      const msg = extractPanelMessage(block.result);
      if (msg) {
        messages.push(msg);
      }
    }
  }

  return messages;
}

/**
 * 根据目标面板过滤消息
 */
export function getMessagesForPanel(
  messages: PanelMessage[],
  panelId: string
): PanelMessage[] {
  return messages.filter(msg => msg.target === panelId);
}

/**
 * 获取最新的面板消息（按timestamp）
 */
export function getLatestMessage(
  messages: PanelMessage[]
): PanelMessage | null {
  if (messages.length === 0) return null;
  return messages.reduce((latest, current) =>
    current.timestamp > latest.timestamp ? current : latest
  );
}

/**
 * 按来源智能体过滤消息
 */
export function getMessagesFromAgent(
  messages: PanelMessage[],
  agentId: string
): PanelMessage[] {
  return messages.filter(msg => msg.source === agentId);
}

/**
 * 按消息类型过滤
 */
export function getMessagesByType(
  messages: PanelMessage[],
  type: 'panel_data' | 'panel_error' | 'panel_progress'
): PanelMessage[] {
  return messages.filter(msg => msg.type === type);
}

/**
 * 解析助手消息并提取面板消息
 */
export function parseAssistantMessage(
  message: any
): PanelMessage[] {
  if (!message || message.role !== 'assistant') return [];

  // 处理content字段
  const content = message.content;
  if (!content) return [];

  // 如果是字符串，转换为单个文本块
  const blocks: ContentBlock[] = typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content as ContentBlock[];

  return extractPanelMessages(blocks);
}

/**
 * 从消息列表中提取所有面板消息
 */
export function extractAllPanelMessages(
  messages: any[]
): PanelMessage[] {
  const allMessages: PanelMessage[] = [];

  for (const message of messages) {
    // 从content中提取
    const panelMsgs = parseAssistantMessage(message);
    allMessages.push(...panelMsgs);

    // 从toolCalls中提取（关键修复：工具结果存储在toolCalls.result中）
    if (message.toolCalls && Array.isArray(message.toolCalls)) {
      for (const toolCall of message.toolCalls) {
        if (toolCall.result) {
          const msg = extractPanelMessage(toolCall.result);
          if (msg) {
            allMessages.push(msg);
          }
        }
      }
    }
  }

  // 按时间戳排序，确保最新的消息在后面
  return allMessages.sort((a, b) => a.timestamp - b.timestamp);
}
