import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../db/db.service';

/**
 * Gateway崩溃报告接口
 */
export interface CrashReport {
  assignmentId: string;
  coworkerId: string;
  userId?: string;
  crashCode?: number;
  crashSignal?: string;
  crashReason: 'exit' | 'signal' | 'error' | 'timeout' | 'oom' | 'unknown';
  wasConnected?: boolean;
  activeTasks?: number;
  uptimeSeconds?: number;
  errorMessage?: string;
  errorStack?: string;
  restartAttempted?: boolean;
  restartSuccess?: boolean;
  restartCountInWindow?: number;
  clientVersion?: string;
  osPlatform?: string;
  osArch?: string;
  nodeVersion?: string;
  metadata?: Record<string, any>;
}

/**
 * Gateway健康快照接口
 */
export interface HealthSnapshot {
  assignmentId: string;
  isConnected: boolean;
  lastHeartbeatAt?: Date;
  heartbeatIntervalMs?: number;
  activeTasks?: number;
  completedTasks?: number;
  failedTasks?: number;
  memoryUsageMb?: number;
  cpuUsagePercent?: number;
  gatewayUptimeSeconds?: number;
  gatewayRestartCount?: number;
  syncStatus?: string;
  lastSyncAt?: Date;
  syncErrorCount?: number;
  metadata?: Record<string, any>;
}

/**
 * Gateway健康统计接口
 */
export interface GatewayHealthStats {
  totalCrashes: number;
  crashesByReason: Record<string, number>;
  frequentCrashAssignments: Array<{
    assignmentId: string;
    crashCount: number;
    lastCrashAt: Date;
  }>;
  avgRecoveryTime: number;
  currentConnections: number;
  activeTasks: number;
}

/**
 * Gateway健康监控服务
 *
 * 功能：
 * 1. 记录Gateway崩溃历史
 * 2. 保存健康状态快照
 * 3. 提供健康统计数据
 * 4. 频繁崩溃检测
 */
@Injectable()
export class GatewayHealthService {
  private readonly logger = new Logger(GatewayHealthService.name);

  constructor(private readonly db: DbService) {}

  /**
   * 记录Gateway崩溃事件
   */
  async reportCrash(report: CrashReport): Promise<{ recorded: boolean; crashId?: string }> {
    try {
      const { randomUUID } = await import('crypto');
      const crashId = randomUUID();

      await this.db.query(
        `INSERT INTO jz_gateway_crash_history (
          id, assignment_id, coworker_id, user_id,
          crash_code, crash_signal, crash_reason,
          was_connected, active_tasks, uptime_seconds,
          error_message, error_stack,
          crashed_at,
          restart_attempted, restart_success, restart_count_in_window,
          client_version, os_platform, os_arch, node_version,
          metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          crashId,
          report.assignmentId,
          report.coworkerId,
          report.userId || null,
          report.crashCode || null,
          report.crashSignal || null,
          report.crashReason,
          report.wasConnected ?? false,
          report.activeTasks ?? 0,
          report.uptimeSeconds || null,
          report.errorMessage || null,
          report.errorStack || null,
          report.restartAttempted ?? false,
          report.restartSuccess ?? null,
          report.restartCountInWindow ?? 0,
          report.clientVersion || null,
          report.osPlatform || null,
          report.osArch || null,
          report.nodeVersion || null,
          JSON.stringify(report.metadata || {}),
        ]
      );

      this.logger.warn(
        `Gateway crash recorded: ${report.assignmentId.slice(0,8)} reason=${report.crashReason} ` +
        `tasks=${report.activeTasks} connected=${report.wasConnected}`
      );

      // 检测频繁崩溃
      await this.checkFrequentCrashes(report.assignmentId);

      return { recorded: true, crashId };
    } catch (error: any) {
      this.logger.error(`Failed to record crash: ${error.message}`);
      return { recorded: false };
    }
  }

  /**
   * 保存健康状态快照
   */
  async saveHealthSnapshot(snapshot: HealthSnapshot): Promise<{ saved: boolean }> {
    try {
      const { randomUUID } = await import('crypto');

      await this.db.query(
        `INSERT INTO jz_gateway_health_snapshots (
          id, assignment_id,
          is_connected, last_heartbeat_at, heartbeat_interval_ms,
          active_tasks, completed_tasks, failed_tasks,
          memory_usage_mb, cpu_usage_percent,
          gateway_uptime_seconds, gateway_restart_count,
          sync_status, last_sync_at, sync_error_count,
          snapshot_at, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW(), $16)`,
        [
          randomUUID(),
          snapshot.assignmentId,
          snapshot.isConnected,
          snapshot.lastHeartbeatAt || null,
          snapshot.heartbeatIntervalMs || null,
          snapshot.activeTasks ?? 0,
          snapshot.completedTasks ?? 0,
          snapshot.failedTasks ?? 0,
          snapshot.memoryUsageMb || null,
          snapshot.cpuUsagePercent || null,
          snapshot.gatewayUptimeSeconds || null,
          snapshot.gatewayRestartCount ?? 0,
          snapshot.syncStatus || null,
          snapshot.lastSyncAt || null,
          snapshot.syncErrorCount ?? 0,
          JSON.stringify(snapshot.metadata || {}),
        ]
      );

      return { saved: true };
    } catch (error: any) {
      this.logger.error(`Failed to save health snapshot: ${error.message}`);
      return { saved: false };
    }
  }

  /**
   * 获取Gateway健康统计
   */
  async getHealthStats(timeWindow: string = '24 hours'): Promise<GatewayHealthStats> {
    const stats: GatewayHealthStats = {
      totalCrashes: 0,
      crashesByReason: {},
      frequentCrashAssignments: [],
      avgRecoveryTime: 0,
      currentConnections: 0,
      activeTasks: 0,
    };

    try {
      // 总崩溃次数
      const { rows: crashRows } = await this.db.query(
        `SELECT COUNT(*) as count FROM jz_gateway_crash_history
         WHERE crashed_at > NOW() - INTERVAL '${timeWindow}'`
      );
      stats.totalCrashes = Number(crashRows[0]?.count || 0);

      // 按原因分组
      const { rows: byReason } = await this.db.query(
        `SELECT crash_reason, COUNT(*) as count FROM jz_gateway_crash_history
         WHERE crashed_at > NOW() - INTERVAL '${timeWindow}'
         GROUP BY crash_reason`
      );
      for (const row of byReason) {
        stats.crashesByReason[row.crash_reason] = Number(row.count);
      }

      // 频繁崩溃的分配（最近24小时内崩溃>=3次）
      const { rows: frequentRows } = await this.db.query(
        `SELECT assignment_id, COUNT(*) as crash_count, MAX(crashed_at) as last_crash_at
         FROM jz_gateway_crash_history
         WHERE crashed_at > NOW() - INTERVAL '24 hours'
         GROUP BY assignment_id
         HAVING COUNT(*) >= 3
         ORDER BY crash_count DESC
         LIMIT 10`
      );
      stats.frequentCrashAssignments = frequentRows.map((row: any) => ({
        assignmentId: row.assignment_id,
        crashCount: Number(row.crash_count),
        lastCrashAt: row.last_crash_at,
      }));

      // 平均恢复时间
      const { rows: recoveryRows } = await this.db.query(
        `SELECT AVG(recovery_duration_ms) as avg_time
         FROM jz_gateway_crash_history
         WHERE crashed_at > NOW() - INTERVAL '${timeWindow}'
         AND recovery_duration_ms IS NOT NULL`
      );
      stats.avgRecoveryTime = Number(recoveryRows[0]?.avg_time || 0);

      // 当前连接数和活跃任务（从最新快照）
      const { rows: currentRows } = await this.db.query(
        `SELECT
           SUM(CASE WHEN is_connected = true THEN 1 ELSE 0 END) as connections,
           SUM(COALESCE(active_tasks, 0)) as tasks
         FROM jz_gateway_health_snapshots
         WHERE snapshot_at > NOW() - INTERVAL '5 minutes'
         AND id IN (
           SELECT DISTINCT ON (assignment_id) id
           FROM jz_gateway_health_snapshots
           ORDER BY assignment_id, snapshot_at DESC
         )`
      );
      stats.currentConnections = Number(currentRows[0]?.connections || 0);
      stats.activeTasks = Number(currentRows[0]?.tasks || 0);

    } catch (error: any) {
      this.logger.error(`Failed to get health stats: ${error.message}`);
    }

    return stats;
  }

  /**
   * 获取特定分配的崩溃历史
   */
  async getCrashHistory(
    assignmentId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<Array<CrashReport & { id: string; crashedAt: Date; recoveredAt?: Date }>> {
    try {
      const { rows } = await this.db.query(
        `SELECT
           id, assignment_id, coworker_id, user_id,
           crash_code, crash_signal, crash_reason,
           was_connected, active_tasks, uptime_seconds,
           error_message, error_stack,
           crashed_at, recovered_at, recovery_duration_ms,
           restart_attempted, restart_success, restart_count_in_window,
           client_version, os_platform, os_arch, node_version,
           metadata
         FROM jz_gateway_crash_history
         WHERE assignment_id = $1
         ORDER BY crashed_at DESC
         LIMIT $2 OFFSET $3`,
        [assignmentId, limit, offset]
      );

      return rows.map((row: any) => ({
        id: row.id,
        assignmentId: row.assignment_id,
        coworkerId: row.coworker_id,
        userId: row.user_id,
        crashCode: row.crash_code,
        crashSignal: row.crash_signal,
        crashReason: row.crash_reason,
        wasConnected: row.was_connected,
        activeTasks: row.active_tasks,
        uptimeSeconds: row.uptime_seconds,
        errorMessage: row.error_message,
        errorStack: row.error_stack,
        crashedAt: row.crashed_at,
        recoveredAt: row.recovered_at,
        recoveryDurationMs: row.recovery_duration_ms,
        restartAttempted: row.restart_attempted,
        restartSuccess: row.restart_success,
        restartCountInWindow: row.restart_count_in_window,
        clientVersion: row.client_version,
        osPlatform: row.os_platform,
        osArch: row.os_arch,
        nodeVersion: row.node_version,
        metadata: row.metadata,
      }));
    } catch (error: any) {
      this.logger.error(`Failed to get crash history: ${error.message}`);
      return [];
    }
  }

  /**
   * 更新崩溃恢复信息
   */
  async updateRecoveryInfo(
    crashId: string,
    recoveredAt: Date,
    success: boolean
  ): Promise<{ updated: boolean }> {
    try {
      const durationMs = recoveredAt.getTime(); // 简化，实际需要从crashedAt计算

      await this.db.query(
        `UPDATE jz_gateway_crash_history
         SET recovered_at = $1,
             recovery_duration_ms = $2,
             restart_success = $3
         WHERE id = $4`,
        [recoveredAt, durationMs, success, crashId]
      );

      return { updated: true };
    } catch (error: any) {
      this.logger.error(`Failed to update recovery info: ${error.message}`);
      return { updated: false };
    }
  }

  /**
   * 检测频繁崩溃并记录告警
   */
  private async checkFrequentCrashes(assignmentId: string): Promise<void> {
    try {
      // 检查最近1小时内的崩溃次数
      const { rows } = await this.db.query(
        `SELECT COUNT(*) as count
         FROM jz_gateway_crash_history
         WHERE assignment_id = $1
         AND crashed_at > NOW() - INTERVAL '1 hour'`,
        [assignmentId]
      );

      const crashCount = Number(rows[0]?.count || 0);

      if (crashCount >= 5) {
        this.logger.error(
          `Frequent crashes detected for assignment ${assignmentId.slice(0,8)}: ` +
          `${crashCount} crashes in the last hour`
        );
        // 这里可以触发告警通知（如发送邮件、推送通知等）
      }
    } catch (error: any) {
      this.logger.error(`Failed to check frequent crashes: ${error.message}`);
    }
  }

  /**
   * 清理旧的健康数据（90天以上）
   */
  async cleanupOldData(): Promise<{ crashesCleaned: number; snapshotsCleaned: number }> {
    let crashesCleaned = 0;
    let snapshotsCleaned = 0;

    try {
      const crashResult = await this.db.query(
        `DELETE FROM jz_gateway_crash_history WHERE crashed_at < NOW() - INTERVAL '90 days'`
      );
      crashesCleaned = crashResult.rowCount || 0;

      const snapshotResult = await this.db.query(
        `DELETE FROM jz_gateway_health_snapshots WHERE snapshot_at < NOW() - INTERVAL '90 days'`
      );
      snapshotsCleaned = snapshotResult.rowCount || 0;

      this.logger.log(`Cleaned up old health data: ${crashesCleaned} crashes, ${snapshotsCleaned} snapshots`);
    } catch (error: any) {
      this.logger.error(`Failed to cleanup old data: ${error.message}`);
    }

    return { crashesCleaned, snapshotsCleaned };
  }
}
