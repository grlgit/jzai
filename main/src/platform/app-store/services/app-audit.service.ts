import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../../db/db.service';

export type AuditAction =
  | 'install' | 'uninstall' | 'upgrade'
  | 'grant_change' | 'config_update' | 'status_change'
  | 'dev_mcp_call' | 'dev_token_issue' | 'dev_token_revoke';

export interface AuditEntry {
  id: string;
  appId: string;
  action: AuditAction;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: Date;
}

@Injectable()
export class AppAuditService {
  private readonly logger = new Logger(AppAuditService.name);

  constructor(private readonly db: DbService) {}

  async log(
    appId: string,
    action: AuditAction,
    actorId: string | null,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO jz_app_audit_log (app_id, action, actor_id, detail)
         VALUES ($1, $2, $3, $4)`,
        [appId, action, actorId, JSON.stringify(payload)],
      );
    } catch (err) {
      // Audit log failures must not interrupt main flows
      this.logger.error(`Failed to write audit log for ${appId}/${action}: ${err.message}`);
    }
  }

  async getLogs(appId: string, limit = 100): Promise<AuditEntry[]> {
    const res = await this.db.query(
      `SELECT id, app_id, action, actor_id, detail, created_at
       FROM jz_app_audit_log
       WHERE app_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [appId, limit],
    );
    return res.rows.map(r => ({
      id: r.id,
      appId: r.app_id,
      action: r.action,
      actorId: r.actor_id,
      payload: r.detail,
      createdAt: r.created_at,
    }));
  }
}
