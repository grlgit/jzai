import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DbService } from '../../../db/db.service';
import { AppConfigService } from '../../../config/app-config.service';
import { AppRegistryService } from './app-registry.service';
import { AppAuditService } from './app-audit.service';
import { CredentialService } from '../../../capability/skill/credential.service';
import { ToolBridgeService } from '../../../agent/tool-bridge/tool-bridge.service';
import { DevUploadService } from './dev-upload.service';
import { createDevMcpPrincipal } from '../runtime/invocation-principal';

export type DevTokenScope = 'read' | 'invoke' | 'manage';

interface StoredDevToken {
  tokenId: string;
  tokenHash: string; // sha256(token)，不可逆；原始 token 不落库
  issuedBy: string;
  scopes: DevTokenScope[];
  issuedAt: string;
  expiresAt?: string;
}

export interface VerifiedDevToken {
  tokenId: string;
  scopes: DevTokenScope[];
}

const DEV_TOKEN_SCOPE = 'dev-mcp';
const DEFAULT_DEV_TOKEN_SCOPES: DevTokenScope[] = ['read', 'invoke', 'manage'];

/**
 * 框架内置 MCP 工具（不依赖首方包 mcpExposed）。
 * 大包上传编排：begin 预留句柄 → 客户端 multipart 直推 /api/dev/uploads → status 感知状态
 * → 把 uploadId 传给 jd_install_app/jd_upgrade_app/jd_validate_package（jz-devtools 双模工具）。
 */
const BUILTIN_TOOLS: Array<{ name: string; description: string; inputSchema: unknown }> = [
  {
    name: 'jd_upload_begin',
    description:
      '大包上传第一步（包 >1MB 时必须走本通道，否则 JSON body 超 1mb 限制）：预留上传句柄，返回 {uploadId, uploadUrl, expiresAt}。' +
      '随后用 HTTP multipart（字段名 package，Authorization: Bearer <dev-token>）把 .jzapp 直推 uploadUrl；' +
      '再调 jd_upload_status 确认 ready；最后把 uploadId 传给 jd_install_app/jd_upgrade_app/jd_validate_package 执行。' +
      '句柄 30 分钟过期、一次性使用。小包仍可走 files 内联。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'jd_upload_status',
    description:
      '查询上传句柄状态：pending（等待文件）/ready（可执行）/consumed（已执行）/expired（已过期）。' +
      '返回 {uploadId, status, size, sha256, createdAt, expiresAt}。',
    inputSchema: {
      type: 'object',
      properties: { uploadId: { type: 'string', description: 'jd_upload_begin 返回的句柄 id' } },
      required: ['uploadId'],
    },
  },
];

/**
 * Dev MCP（/api/dev/mcp）的支撑服务：
 * - dev token 签发/校验/吊销（jz_credentials scope=dev-mcp，AES-256-GCM）
 * - mcpExposed 工具聚合（仅首方包可声明，validator 已门控）
 * - resources（jzdev://docs/*、jzdev://templates/*，来自首方包安装目录）
 *
 * 多实例约束：与 v4 §1.4-A 一致——本端点依赖进程内注册表，仅支持单实例部署
 * （当前 docker-compose 恒为单 main 实例；多实例形态下不要开启 devMcp.enabled）。
 */
@Injectable()
export class DevMcpService {
  private readonly logger = new Logger(DevMcpService.name);

  constructor(
    private readonly db: DbService,
    private readonly config: AppConfigService,
    private readonly registry: AppRegistryService,
    private readonly audit: AppAuditService,
    private readonly credentials: CredentialService,
    private readonly moduleRef: ModuleRef,
    private readonly uploads: DevUploadService,
  ) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('devMcp.enabled', false) === true;
  }

  // ── dev token ──

  /**
   * 签发 dev token。token 仅本次返回；库中只保存 sha256 哈希与 tokenId/scope/签发元数据。
   * scopes 缺省为全量（read/invoke/manage），管理员可按最小授权收窄。
   */
  async issueToken(issuedBy: string, scopes?: DevTokenScope[]): Promise<{ token: string; tokenId: string }> {
    const token = `jzdev_${crypto.randomBytes(24).toString('hex')}`;
    const tokenId = `dtok_${crypto.randomBytes(4).toString('hex')}`;
    const payload: StoredDevToken = {
      tokenId,
      tokenHash: this.hashToken(token),
      issuedBy,
      scopes: scopes?.length ? scopes : DEFAULT_DEV_TOKEN_SCOPES,
      issuedAt: new Date().toISOString(),
    };
    await this.db.query(
      `INSERT INTO jz_credentials (scope, key, value_enc) VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO UPDATE SET value_enc=$3, updated_at=NOW()`,
      [DEV_TOKEN_SCOPE, tokenId, this.credentials.encrypt(JSON.stringify(payload))],
    );
    await this.audit.log('dev-mcp', 'dev_token_issue', issuedBy, { tokenId, scopes: payload.scopes });
    return { token, tokenId };
  }

  async getTokenStatus(): Promise<{
    issued: boolean;
    tokens: Array<{ tokenId: string; issuedBy: string; scopes: DevTokenScope[]; issuedAt: string; expiresAt?: string }>;
  }> {
    const stored = await this.readStoredTokens();
    return {
      issued: stored.length > 0,
      tokens: stored.map(({ tokenId, issuedBy, scopes, issuedAt, expiresAt }) => ({
        tokenId, issuedBy, scopes, issuedAt, expiresAt,
      })),
    };
  }

  /** 吊销单个 token；tokenId 缺省时吊销全部。 */
  async revokeToken(actorId: string, tokenId?: string): Promise<void> {
    if (tokenId) {
      await this.db.query(`DELETE FROM jz_credentials WHERE scope=$1 AND key=$2`, [DEV_TOKEN_SCOPE, tokenId]);
    } else {
      await this.db.query(`DELETE FROM jz_credentials WHERE scope=$1`, [DEV_TOKEN_SCOPE]);
    }
    await this.audit.log('dev-mcp', 'dev_token_revoke', actorId, tokenId ? { tokenId } : { all: true });
  }

  /** 校验 token，成功返回稳定 tokenId 与 scope；失败/过期返回 null。 */
  async verifyToken(token: string | undefined): Promise<VerifiedDevToken | null> {
    if (!token) return null;
    const hash = Buffer.from(this.hashToken(token));
    for (const stored of await this.readStoredTokens()) {
      const b = Buffer.from(stored.tokenHash);
      if (hash.length === b.length && crypto.timingSafeEqual(hash, b)) {
        if (stored.expiresAt && Date.parse(stored.expiresAt) <= Date.now()) return null;
        return { tokenId: stored.tokenId, scopes: stored.scopes };
      }
    }
    return null;
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async readStoredTokens(): Promise<StoredDevToken[]> {
    const res = await this.db.query(
      `SELECT value_enc FROM jz_credentials WHERE scope=$1`,
      [DEV_TOKEN_SCOPE],
    );
    const out: StoredDevToken[] = [];
    for (const row of res.rows) {
      try {
        const parsed = JSON.parse(this.credentials.decrypt(row.value_enc));
        if (parsed?.tokenId && parsed?.tokenHash) out.push(parsed);
      } catch {
        // 单条损坏不影响其余 token
      }
    }
    return out;
  }

  // ── tools（mcpExposed 聚合）──

  private async getExposedToolIds(): Promise<Set<string>> {
    const apps = await this.registry.findAll();
    const ids = new Set<string>();
    for (const app of apps.filter(a => a.status === 'active')) {
      for (const tp of app.manifest?.backend?.toolProviders ?? []) {
        if (tp.mcpExposed) for (const t of tp.toolIds ?? []) ids.add(t);
      }
    }
    return ids;
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const exposed = await this.getExposedToolIds();
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const exposedTools = exposed.size === 0 ? [] : bridge.getCatalog()
      .filter((e: any) => exposed.has(e.id))
      .map((e: any) => ({
        name: e.id,
        description: e.description ?? e.label ?? '',
        inputSchema: e.parameters ?? { type: 'object', properties: {} },
      }));
    return [...BUILTIN_TOOLS, ...exposedTools];
  }

  async callTool(name: string, args: unknown, actorId: string): Promise<unknown> {
    const builtin = BUILTIN_TOOLS.find(t => t.name === name);
    if (builtin) {
      const result = this.callBuiltinTool(name, args ?? {});
      await this.audit.log('dev-mcp', 'dev_mcp_call', actorId, { tool: name });
      return result;
    }
    const exposed = await this.getExposedToolIds();
    if (!exposed.has(name)) throw new Error(`Tool not exposed via dev MCP: ${name}`);
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const result = await bridge.callTool(name, args, createDevMcpPrincipal(actorId));
    await this.audit.log('dev-mcp', 'dev_mcp_call', actorId, { tool: name });
    return result;
  }

  private callBuiltinTool(name: string, args: any): unknown {
    switch (name) {
      case 'jd_upload_begin': {
        const record = this.uploads.begin();
        return {
          ...record,
          uploadUrl: '/api/dev/uploads',
          hint: `curl -X POST <instance>/api/dev/uploads -H "Authorization: Bearer <dev-token>" -F "package=@<your-app>.jzapp" -F "uploadId=${record.uploadId}"`,
        };
      }
      case 'jd_upload_status':
        if (!args?.uploadId) throw new Error('uploadId is required');
        return this.uploads.get(args.uploadId);
      default:
        throw new Error(`Unknown builtin tool: ${name}`);
    }
  }

  // ── resources（首方包 docs/ 与 templates/）──

  private async resourceRoots(): Promise<string[]> {
    const apps = await this.registry.findAll();
    return apps
      .filter(a => a.status === 'active' && a.installDir
        && (a.manifest?.platformCapabilities ?? []).includes('appstore:manage'))
      .map(a => a.installDir!);
  }

  async listResources(): Promise<Array<{ uri: string; name: string; mimeType: string }>> {
    const out: Array<{ uri: string; name: string; mimeType: string }> = [];
    for (const root of await this.resourceRoots()) {
      for (const [scope, prefix] of [['docs', 'jzdev://docs/'], ['templates', 'jzdev://templates/']] as const) {
        const dir = path.join(root, scope);
        for (const file of this.walk(dir)) {
          out.push({
            uri: prefix + path.relative(dir, file).split(path.sep).join('/'),
            name: path.basename(file),
            mimeType: file.endsWith('.json') ? 'application/json' : 'text/markdown',
          });
        }
      }
    }
    return out;
  }

  async readResource(uri: string): Promise<{ uri: string; mimeType: string; text: string }> {
    const match = uri.match(/^jzdev:\/\/(docs|templates)\/(.+)$/);
    if (!match) throw new Error(`Unsupported resource uri: ${uri}`);
    const [, scope, rel] = match;
    if (path.isAbsolute(rel) || rel.split(/[\\/]+/).includes('..')) throw new Error('Path traversal rejected');
    const candidates = path.extname(rel) ? [rel] : [rel, `${rel}.md`];
    for (const root of await this.resourceRoots()) {
      const base = path.resolve(root, scope);
      for (const candidate of candidates) {
        const target = path.resolve(base, candidate);
        if (target.startsWith(base + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
          return {
            uri: `jzdev://${scope}/${candidate.split(path.sep).join('/')}`,
            mimeType: target.endsWith('.json') ? 'application/json' : 'text/markdown',
            text: fs.readFileSync(target, 'utf-8'),
          };
        }
      }
    }
    throw new Error(`Resource not found: ${uri}`);
  }

  private walk(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...this.walk(full));
      else if (entry.isFile() && !entry.name.startsWith('.')) out.push(full);
    }
    return out;
  }
}
