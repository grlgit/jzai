import { Injectable, Logger } from '@nestjs/common';
import { SkillRegistryService, SkillDefinition } from './skill-registry.service';
import { CredentialService } from './credential.service';
import { ToolErrorCode } from '../../agent/tool-bridge/tool-error';
import type {
  InvocationPrincipal,
  InvocationPrincipalInput,
} from '../../platform/app-store/runtime/invocation-principal';
import { normalizeInvocationPrincipal } from '../../platform/app-store/runtime/invocation-principal';
import * as http from 'http';
import * as https from 'https';
import * as url from 'url';

export interface SkillContext {
  skill: SkillDefinition;
  params: Record<string, any>;
  credentials: Record<string, string>;
  http: HttpClient;
  callTool: (toolName: string, args: Record<string, any>) => Promise<any>;
  // P0-5: Skill 作者可 return { success:false, code: ctx.ErrorCode.AUTH_EXPIRED, userAction:'...' }
  ErrorCode: typeof ToolErrorCode;
}

export interface SkillResult {
  success: boolean;
  message: string;
  data?: any;
  // P0-5: 可选的结构化错误信息（向后兼容）
  code?: ToolErrorCode;
  userAction?: string;
  // Allow handler to pass through special fields like __abort, __abortMessage, etc.
  details?: any;
}

export type ToolCallerFn = (
  toolName: string,
  args: Record<string, any>,
  principal?: InvocationPrincipal,
) => Promise<any>;

/**
 * Simple HTTP client that preserves cookies across requests
 */
class HttpClient {
  private cookies: string[] = [];

  async request(method: string, reqUrl: string, body?: any, headers?: Record<string, string>): Promise<{
    status: number;
    headers: Record<string, string>;
    data: any;
  }> {
    return new Promise((resolve, reject) => {
      const parsed = new url.URL(reqUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };
      if (this.cookies.length > 0) {
        reqHeaders['Cookie'] = this.cookies.join('; ');
      }

      let bodyStr = '';
      if (body) {
        bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
        reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr).toString();
      }

      const req = lib.request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: method.toUpperCase(),
        headers: reqHeaders,
        timeout: 15000,
      }, (res) => {
        const setCookies = res.headers['set-cookie'];
        if (setCookies) {
          for (const c of setCookies) {
            const name = c.split('=')[0];
            this.cookies = this.cookies.filter(existing => !existing.startsWith(name + '='));
            this.cookies.push(c.split(';')[0]);
          }
        }

        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          let parsed: any;
          const trimmed = data.trim();
          try { parsed = JSON.parse(trimmed); } catch {
            try {
              const fixed = trimmed.replace(/'/g, '"').replace(/(\{|,)\s*(\w+)\s*:/g, '$1"$2":');
              parsed = JSON.parse(fixed);
            } catch { parsed = data; }
          }
          resolve({ status: res.statusCode || 0, headers: res.headers as Record<string, string>, data: parsed });
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('请求超时 (15s)')); });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async get(reqUrl: string, headers?: Record<string, string>) { return this.request('GET', reqUrl, undefined, headers); }
  async post(reqUrl: string, body?: any, headers?: Record<string, string>) { return this.request('POST', reqUrl, body, headers); }
  async put(reqUrl: string, body?: any, headers?: Record<string, string>) { return this.request('PUT', reqUrl, body, headers); }
  async delete(reqUrl: string, headers?: Record<string, string>) { return this.request('DELETE', reqUrl, undefined, headers); }
}

@Injectable()
export class SkillExecutorService {
  private readonly logger = new Logger(SkillExecutorService.name);
  private toolCaller: ToolCallerFn | null = null;

  constructor(
    private readonly registry: SkillRegistryService,
    private readonly credentialService: CredentialService,
  ) {}

  /** Set by ToolBuilderService after init to avoid circular dependency */
  setToolCaller(fn: ToolCallerFn) { this.toolCaller = fn; }

  async execute(
    skillName: string,
    params: Record<string, any>,
    principalInput?: InvocationPrincipalInput,
  ): Promise<SkillResult> {
    const skill = this.registry.get(skillName);
    if (!skill) return { success: false, message: `技能未找到: ${skillName}` };
    const principal = normalizeInvocationPrincipal(principalInput, `skill:${skillName}`);
    const userId = principal?.userId;

    // Resolve credentials: user → global → empty
    const credSystem = skill.metadata?.system || skill.name;
    let credentials: Record<string, string> = {};
    if (userId && credSystem) {
      const resolved = this.credentialService.resolveCredentials(userId, credSystem);
      if (resolved) credentials = resolved;
    }

    // Build callTool with allowed-tools enforcement
    const allowedTools = skill.allowedTools || [];
    const callTool = async (toolName: string, args: Record<string, any>): Promise<any> => {
      if (allowedTools.length > 0 && !allowedTools.includes(toolName)) {
        return { success: false, message: `工具 "${toolName}" 未在 allowed-tools 中声明。允许: ${allowedTools.join(', ')}` };
      }
      if (!this.toolCaller) {
        return { success: false, message: '工具调用能力未初始化' };
      }
      this.logger.debug(`Skill ${skillName} → callTool: ${toolName}`);
      return this.toolCaller(toolName, args, principal);
    };

    const httpClient = new HttpClient();
    const ctx: SkillContext = { skill, params, credentials, http: httpClient, callTool, ErrorCode: ToolErrorCode };

    this.logger.log(`Executing skill: ${skillName}`);

    try {
      const handlerCode = this.registry.getHandlerCode(skillName);
      if (handlerCode) {
        return await this.executeHandler(handlerCode, ctx);
      }
      // No handler — skill is instructions-only, return instructions for LLM to process
      return {
        success: true,
        message: skill.instructions || skill.description,
        data: { type: 'instructions-only', instructions: skill.instructions },
      };
    } catch (err: any) {
      this.logger.error(`Skill execution error: ${err.message}`);
      return { success: false, message: `执行失败: ${err.message}` };
    }
  }

  private async executeHandler(code: string, ctx: SkillContext): Promise<SkillResult> {
    let jsCode = code
      .replace(/import\s+.*?from\s+.*?;?\n?/g, '')
      .replace(/export\s+/g, '')
      .replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ')
      .replace(/as\s+\w+/g, '')
      .replace(/<\w+(\[\])?>/g, '');

    const fn = new Function('require', 'ctx', `
      return (async function() {
        const { http, params, credentials, callTool, ErrorCode } = ctx;
        ${jsCode}
        return execute(ctx);
      })();
    `);

    return fn(require, ctx);
  }

  async test(
    skillName: string,
    principalInput?: InvocationPrincipalInput,
  ): Promise<SkillResult> {
    const skill = this.registry.get(skillName);
    if (!skill) return { success: false, message: `技能未找到: ${skillName}` };
    return this.execute(skillName, { input: '测试调用' }, principalInput);
  }
}
