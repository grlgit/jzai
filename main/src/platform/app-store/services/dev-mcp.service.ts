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

interface StoredDevToken {
  token: string;
  issuedBy: string;
  issuedAt: string;
}

const DEV_TOKEN_SCOPE = 'dev-mcp';
const DEV_TOKEN_KEY = 'token';

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
  ) {}

  isEnabled(): boolean {
    return this.config.get<boolean>('devMcp.enabled', false) === true;
  }

  // ── dev token ──

  async issueToken(issuedBy: string): Promise<string> {
    const token = `jzdev_${crypto.randomBytes(24).toString('hex')}`;
    const payload: StoredDevToken = { token, issuedBy, issuedAt: new Date().toISOString() };
    await this.db.query(
      `INSERT INTO jz_credentials (scope, key, value_enc) VALUES ($1, $2, $3)
       ON CONFLICT (scope, key) DO UPDATE SET value_enc=$3, updated_at=NOW()`,
      [DEV_TOKEN_SCOPE, DEV_TOKEN_KEY, this.credentials.encrypt(JSON.stringify(payload))],
    );
    await this.audit.log('dev-mcp', 'dev_token_issue', issuedBy);
    return token;
  }

  async getTokenStatus(): Promise<{ issued: boolean; issuedBy?: string; issuedAt?: string }> {
    const stored = await this.readStoredToken();
    return stored
      ? { issued: true, issuedBy: stored.issuedBy, issuedAt: stored.issuedAt }
      : { issued: false };
  }

  async revokeToken(actorId: string): Promise<void> {
    await this.db.query(`DELETE FROM jz_credentials WHERE scope=$1 AND key=$2`, [DEV_TOKEN_SCOPE, DEV_TOKEN_KEY]);
    await this.audit.log('dev-mcp', 'dev_token_revoke', actorId);
  }

  async verifyToken(token: string | undefined): Promise<boolean> {
    if (!token) return false;
    const stored = await this.readStoredToken();
    if (!stored) return false;
    const a = Buffer.from(token);
    const b = Buffer.from(stored.token);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async readStoredToken(): Promise<StoredDevToken | null> {
    const res = await this.db.query(
      `SELECT value_enc FROM jz_credentials WHERE scope=$1 AND key=$2`,
      [DEV_TOKEN_SCOPE, DEV_TOKEN_KEY],
    );
    if (res.rows.length === 0) return null;
    try {
      return JSON.parse(this.credentials.decrypt(res.rows[0].value_enc));
    } catch {
      return null;
    }
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
    if (exposed.size === 0) return [];
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    return bridge.getCatalog()
      .filter((e: any) => exposed.has(e.id))
      .map((e: any) => ({
        name: e.id,
        description: e.description ?? e.label ?? '',
        inputSchema: e.parameters ?? { type: 'object', properties: {} },
      }));
  }

  async callTool(name: string, args: unknown, actorId: string): Promise<unknown> {
    const exposed = await this.getExposedToolIds();
    if (!exposed.has(name)) throw new Error(`Tool not exposed via dev MCP: ${name}`);
    const bridge = this.moduleRef.get(ToolBridgeService, { strict: false });
    const result = await bridge.callTool(name, args, undefined);
    await this.audit.log('dev-mcp', 'dev_mcp_call', actorId, { tool: name });
    return result;
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
    if (rel.includes('..')) throw new Error('Path traversal rejected');
    for (const root of await this.resourceRoots()) {
      const base = path.resolve(root, scope);
      const target = path.resolve(base, rel);
      if (target.startsWith(base + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile()) {
        return {
          uri,
          mimeType: target.endsWith('.json') ? 'application/json' : 'text/markdown',
          text: fs.readFileSync(target, 'utf-8'),
        };
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
