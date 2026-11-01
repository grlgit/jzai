import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DbService } from '../../../db/db.service';
import { AppRegistryService } from './app-registry.service';

export interface McpExposeRecord {
  appId: string;
  allowed: boolean;
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
}

export interface DeclaredExpose {
  appId: string;
  appName?: string;
  toolIds: string[];
  /** 首方 APP 恒 true（无需表行） */
  firstParty: boolean;
  allowed: boolean;
  approvedBy?: string;
  approvedAt?: string;
  note?: string;
}

/** 首方 APP：platformCapabilities 含 appstore:manage */
export function isFirstPartyApp(manifest: any): boolean {
  return (manifest?.platformCapabilities ?? []).includes('appstore:manage');
}

/**
 * P3 APP MCP 暴露审批（docs/rework-2026H2/design-p3-app-mcp.md §4）。
 * 默认 fail-closed：三方 APP 声明 mcpExposed 不自动生效，须 admin 审批（jz_app_mcp_expose）。
 * 首方 APP 无表行也恒 allowed。校验器保持纯函数不查 DB，门控在运行期本服务。
 */
@Injectable()
export class AppMcpExposeService {
  private readonly logger = new Logger(AppMcpExposeService.name);

  constructor(
    private readonly db: DbService,
    private readonly registry: AppRegistryService,
  ) {}

  async isAllowed(appId: string): Promise<boolean> {
    const app = await this.registry.findOne(appId);
    if (!app || app.status !== 'active') return false;
    if (isFirstPartyApp(app.manifest)) return true;
    const row = await this.getRecord(appId);
    return row?.allowed === true;
  }

  async setAllowed(appId: string, allowed: boolean, actorId: string, note?: string): Promise<McpExposeRecord> {
    const app = await this.registry.findOne(appId);
    if (!app) throw new NotFoundException(`App ${appId} not found`);
    const { rows } = await this.db.query(
      `INSERT INTO jz_app_mcp_expose (app_id, allowed, approved_by, approved_at, note)
       VALUES ($1,$2,$3,NOW(),$4)
       ON CONFLICT (app_id) DO UPDATE SET
         allowed=$2, approved_by=$3, approved_at=NOW(), note=$4
       RETURNING app_id, allowed, approved_by, approved_at, note`,
      [appId, allowed, actorId, note ?? null],
    );
    this.logger.log(`MCP 暴露审批：${appId} → ${allowed}（by ${actorId}）`);
    return this.rowToRecord(rows[0]);
  }

  /** 管理界面数据源：全部声明了 mcpExposed 的 active APP + 审批状态 */
  async listDeclared(): Promise<DeclaredExpose[]> {
    const apps = (await this.registry.findAll()).filter(a => a.status === 'active');
    const out: DeclaredExpose[] = [];
    for (const app of apps) {
      const toolIds = (app.manifest?.backend?.toolProviders ?? [])
        .filter((tp: any) => tp.mcpExposed)
        .flatMap((tp: any) => tp.toolIds ?? []);
      if (toolIds.length === 0) continue;
      const firstParty = isFirstPartyApp(app.manifest);
      const record = await this.getRecord(app.appId);
      out.push({
        appId: app.appId,
        appName: app.manifest?.name?.zh ?? app.manifest?.name?.en ?? app.appId,
        toolIds,
        firstParty,
        allowed: firstParty || record?.allowed === true,
        approvedBy: record?.approvedBy,
        approvedAt: record?.approvedAt,
        note: record?.note,
      });
    }
    return out;
  }

  private async getRecord(appId: string): Promise<McpExposeRecord | undefined> {
    const { rows } = await this.db.query(
      `SELECT app_id, allowed, approved_by, approved_at, note FROM jz_app_mcp_expose WHERE app_id=$1`,
      [appId],
    );
    return rows[0] ? this.rowToRecord(rows[0]) : undefined;
  }

  private rowToRecord(r: any): McpExposeRecord {
    return {
      appId: r.app_id, allowed: r.allowed,
      approvedBy: r.approved_by ?? undefined,
      approvedAt: r.approved_at ?? undefined,
      note: r.note ?? undefined,
    };
  }
}
