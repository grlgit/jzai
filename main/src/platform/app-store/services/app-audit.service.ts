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

  /**
   * 递归脱敏：key 含 secret/password/credential/apiKey/authorization/token（tokenId 除外）
   * 或值形如 jzdev_* Bearer token 时替换为 [redacted]。
   */
  private redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(v => this.redact(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = this.isSensitiveKey(k) ? '[redacted]' : this.redact(v);
      }
      return out;
    }
    if (typeof value === 'string' && /^jzdev_[0-9a-f]+$/i.test(value)) return '[redacted]';
    return value;
  }

  private isSensitiveKey(key: string): boolean {
    const k = key.toLowerCase();
    if (/tokenid/.test(k)) return false;
    return /secret|password|credential|api[-_]?key|authorization|token/.test(k);
  }

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
        [appId, action, actorId, JSON.stringify(this.redact(payload))],
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
