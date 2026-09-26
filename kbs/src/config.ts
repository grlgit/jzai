/**
 * kbs 运行配置 — 全部来自环境变量。
 *
 * 与 llm_wiki(Python) 对齐的关键项：
 *  - KB_DATABASE_URL   平台 PG 连接串（pg_local 模式，必填）
 *  - WORKSPACE_PATH    知识库工作区根目录（必填，含 raw/ wiki/ personal/ 等）
 *  - KB_INTERNAL_SECRET 与 main 共享的 HMAC 密钥；缺省时与 main 相同规则派生
 */
import * as crypto from 'crypto';

export interface KbsConfig {
  databaseUrl: string;
  workspacePath: string;
  /** 解析后的内部签名密钥（永远非空，见 resolveInternalSecret） */
  internalSecret: string;
  apiPort: number;
  apiHost: string;
  /** 对外暴露的 API 基址（生成 /v1/files 下载链接用），对齐 Python settings.API_URL */
  apiUrl: string;
  /** 深度链接基址（MCP 工具 view 链接），对齐 Python settings.APP_URL */
  appUrl: string;
  mcpPort: number;
  mcpHost: string;
  wikiLanguage: string;
  mistralApiKey: string;
  /** 'pdfjs'(默认) | 'mistral'（需 MISTRAL_API_KEY），对齐 Python settings.PDF_BACKEND */
  pdfBackend: string;
}

/**
 * 与 main/src/bridge/knowledge/kb-signature.service.ts 的 getSecret() 逐字对齐：
 * KB_INTERNAL_SECRET → HMAC('jz-kb-internal', JWT_SECRET) → 'jz-dev-kb-internal-secret'
 */
export function resolveInternalSecret(
  configured: string,
  jwtSecret: string,
  onWarn: (msg: string) => void,
): string {
  if (configured) return configured;
  if (jwtSecret) {
    onWarn(
      'KB_INTERNAL_SECRET not set; falling back to JWT_SECRET derived dev secret. Set KB_INTERNAL_SECRET in production.',
    );
    return crypto.createHmac('sha256', 'jz-kb-internal').update(jwtSecret).digest('hex');
  }
  onWarn(
    'KB_INTERNAL_SECRET and JWT_SECRET not set; using fixed dev secret. Set KB_INTERNAL_SECRET in production.',
  );
  return 'jz-dev-kb-internal-secret';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): KbsConfig {
  const databaseUrl = env.KB_DATABASE_URL || '';
  if (!databaseUrl) {
    throw new Error('KB_DATABASE_URL 未设置（kbs 仅支持 pg_local 模式，必须连接平台 PostgreSQL）');
  }
  const workspacePath = env.WORKSPACE_PATH || '';
  if (!workspacePath) {
    throw new Error('WORKSPACE_PATH 未设置（知识库工作区根目录）');
  }
  const internalSecret = resolveInternalSecret(
    env.KB_INTERNAL_SECRET || '',
    env.JWT_SECRET || '',
    (m) => console.warn(`[kbs] ${m}`),
  );
  return {
    databaseUrl,
    workspacePath,
    internalSecret,
    apiPort: parseInt(env.KB_API_PORT || '8000', 10),
    apiHost: env.KB_API_HOST || '0.0.0.0',
    apiUrl: env.API_URL || `http://localhost:${parseInt(env.KB_API_PORT || '8000', 10)}`,
    appUrl: env.APP_URL || 'http://localhost:3000',
    mcpPort: parseInt(env.KB_MCP_PORT || '3011', 10),
    mcpHost: env.KB_MCP_HOST || '0.0.0.0',
    wikiLanguage: env.WIKI_LANGUAGE || 'zh',
    mistralApiKey: env.MISTRAL_API_KEY || '',
    pdfBackend: env.PDF_BACKEND || 'pdfjs',
  };
}
