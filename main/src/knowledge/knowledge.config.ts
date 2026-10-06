/**
 * 知识库运行配置（移植自 kbs/src/config.ts，改为主台内嵌）：
 * 工作区根由 WorkspaceService 提供；其余项来自 config/system.json 的 knowledgeBase 段 + env。
 */
import * as fs from 'fs';
import * as path from 'path';

export interface KnowledgeConfig {
  /** 知识库工作区根（{workspaceRoot}/knowledge_base） */
  workspacePath: string;
  /** 深度链接基址（工具 view 链接），对齐 kbs APP_URL */
  appUrl: string;
  wikiLanguage: string;
  mistralApiKey: string;
  /** 'pdfjs'(默认) | 'mistral' */
  pdfBackend: string;
}

export function loadKnowledgeConfig(workspacePath: string): KnowledgeConfig {
  let cfg: any = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'system.json'), 'utf-8'));
  } catch { /* 使用默认值 */ }
  const kb = cfg.knowledgeBase || {};
  return {
    workspacePath,
    appUrl: process.env.APP_URL || kb.appUrl || 'http://localhost:3000',
    wikiLanguage: process.env.WIKI_LANGUAGE || kb.wikiLanguage || 'zh',
    mistralApiKey: process.env.MISTRAL_API_KEY || kb.mistralApiKey || '',
    pdfBackend: process.env.PDF_BACKEND || kb.pdfBackend || 'pdfjs',
  };
}
