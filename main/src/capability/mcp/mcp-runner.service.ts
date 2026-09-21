import { Injectable, Logger } from '@nestjs/common';
import { McpRegistryService, McpServerDef } from './mcp-registry.service';
import { CredentialService } from '../skill/credential.service';
import { McpHttpClient } from './mcp-http-client';

export interface McpRunOptions {
  tool: string;
  params: Record<string, any>;
  userId?: string;
  principal?: any;
}

/**
 * McpRunnerService — 统一执行 MCP 连接 handler 的运行器。
 *
 * 此前 handler 的编译/沙箱执行在 McpAdapterService（agent 工具链）与
 * DashboardService（仪表盘数据源）各重复一份，且凭据解析行为不一致
 * （dashboard 硬编码 userId=''、无 db- 前缀回退）。本服务收敛为唯一实现：
 * 凭据按真实 userId 解析（global/user scope），并带 db- 前缀回退
 * （save_db_connection 以 db-{name} 存储凭据）。
 */
@Injectable()
export class McpRunnerService {
  private readonly logger = new Logger(McpRunnerService.name);

  constructor(
    private readonly mcpRegistry: McpRegistryService,
    private readonly credentialService: CredentialService,
  ) {}

  /** 按 authSystem 解析凭据；非 db- 前缀时回退尝试 db-{authSystem}（数据库连接产物） */
  resolveMcpCredentials(m: McpServerDef, userId?: string): Record<string, any> {
    const authSystem = m.authSystem || m.system || m.name;
    let creds = this.credentialService.resolveCredentials(userId || '', authSystem, m.authScope);
    if ((!creds || Object.keys(creds).length === 0) && !authSystem.startsWith('db-')) {
      creds = this.credentialService.resolveCredentials(userId || '', `db-${authSystem}`, m.authScope);
    }
    return creds || {};
  }

  /** 连接是否声明了凭据要求（authFields 非空） */
  needsAuth(m: McpServerDef): boolean {
    return !!(m.authFields && m.authFields.length > 0);
  }

  /**
   * 执行 MCP 连接的指定工具。
   * 抛出带 code 的 Error：MCP_NOT_FOUND / MCP_NO_HANDLER / MCP_CREDENTIALS_MISSING / MCP_EXECUTION_ERROR
   */
  async run(mcpName: string, opts: McpRunOptions): Promise<any> {
    const m = this.mcpRegistry.get(mcpName);
    if (!m) throw this.err('MCP_NOT_FOUND', `MCP "${mcpName}" 不存在`);
    if (!m.handlerCode) throw this.err('MCP_NO_HANDLER', `MCP "${mcpName}" 无 handler`);

    const credentials = this.resolveMcpCredentials(m, opts.userId);
    if (this.needsAuth(m) && Object.keys(credentials).length === 0) {
      throw this.err('MCP_CREDENTIALS_MISSING', `MCP "${mcpName}" 凭证缺失`);
    }

    try {
      const code = m.handlerCode
        .replace(/import\s+.*?from\s+.*?;?\n?/g, '')
        .replace(/export\s+/g, '')
        .replace(/:\s*(any|string|number|boolean|void|Record<[^>]+>|Promise<[^>]+>)\s*/g, ' ');
      const fn = new Function('require', 'ctx', `return (async function() { ${code} return execute(ctx); })();`);
      const httpClient = new McpHttpClient(opts.principal?.principalId ?? opts.userId, m.name);
      const result = await fn(require, {
        params: opts.params || {},
        tool: opts.tool,
        toolName: opts.tool,
        userId: opts.userId,
        principal: opts.principal,
        credentials,
        http: httpClient,
      });
      return result;
    } catch (e: any) {
      this.logger.warn(`MCP ${mcpName}/${opts.tool} 执行失败: ${e.message}`);
      throw this.err('MCP_EXECUTION_ERROR', e.message);
    }
  }

  private err(code: string, message: string): Error {
    const e = new Error(message);
    (e as any).code = code;
    return e;
  }
}
