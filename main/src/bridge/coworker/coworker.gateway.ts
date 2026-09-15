import {
  WebSocketGateway, WebSocketServer, SubscribeMessage,
  OnGatewayConnection, OnGatewayDisconnect, MessageBody, ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { CoWorkerService } from './coworker.service';
import { CoWorkerConfigService } from './coworker-config.service';
import { UserService } from '../../user/user.service';
import { CoWorkerAuthGuard } from './coworker-auth.guard';

interface ConnectedCW {
  socketId: string;
  assignmentId: string;
  coworkerId: string;
  userId: string;
  userName: string;
}

/**
 * WebSocket gateway for CoWorker instances.
 * Namespace: /ws/coworker
 *
 * Events (CW → Server):
 *   cw.heartbeat    — periodic heartbeat
 *   cw.config.check — check if config version has changed
 *   cw.chat.sync    — sync WeChat/channel messages to main platform
 *
 * Events (Server → CW):
 *   cw.config.update — push new config when admin modifies CoWorker
 *   cw.chat.send     — admin/employee sends message to CoWorker via main platform
 *   cw.chat.stream   — CoWorker streams response back
 *
 * Events (Admin/Employee → Server):
 *   cw.admin.send    — admin sends a message to a specific CoWorker
 */
@WebSocketGateway({
  cors: { origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : true, credentials: true },
  namespace: '/ws/coworker',
})
export class CoWorkerGateway implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server: Server;
  private readonly logger = new Logger(CoWorkerGateway.name);

  // Connected OpenClaw instances (by assignmentId)
  private connectedCWs = new Map<string, ConnectedCW>();
  // Socket → assignment mapping
  private socketToAssignment = new Map<string, string>();
  // Socket id → Socket instance
  private sockets = new Map<string, Socket>();
  // Admin/employee sockets (by userId)
  private adminSockets = new Map<string, Socket>();

  constructor(
    private readonly cwService: CoWorkerService,
    private readonly cwConfig: CoWorkerConfigService,
    private readonly userService: UserService,
    private readonly authGuard: CoWorkerAuthGuard,
  ) {}

  onModuleDestroy() {
    this.connectedCWs.clear();
    this.socketToAssignment.clear();
    this.sockets.clear();
    this.adminSockets.clear();
    this.logger.log('CoWorker gateway cleaned up');
  }

  async handleConnection(client: Socket) {
    const token = client.handshake.auth?.token || (client.handshake.query.token as string);
    if (!token) {
      this.logger.warn(`Rejected connection ${client.id}: no token`);
      client.disconnect();
      return;
    }

    const coworkerId = client.handshake.auth?.coworkerId || (client.handshake.query.coworkerId as string);

    if (coworkerId) {
      // OpenClaw instance. Must present the jw_ assignment api_key issued at
      // activation: user JWTs expire after 2h, and a rejected handshake means
      // cw.config.check never runs, so config push breaks permanently.
      await this.registerCoWorkerByApiKey(client, token, coworkerId);
      return;
    }

    // Admin/employee monitoring or chatting from the console
    const user = this.userService.verifyToken(token);
    if (!user) {
      this.logger.warn(`Rejected connection ${client.id}: invalid token`);
      client.disconnect();
      return;
    }

    this.sockets.set(client.id, client);
    this.adminSockets.set(user.id, client);
    this.logger.log(`Admin/employee connected: ${client.id} (${user.username || user.name})`);
  }

  handleDisconnect(client: Socket) {
    this.sockets.delete(client.id);

    const assignmentId = this.socketToAssignment.get(client.id);
    if (assignmentId) {
      this.connectedCWs.delete(assignmentId);
      this.socketToAssignment.delete(client.id);
      this.logger.log(`CoWorker disconnected: ${client.id} (assignment=${assignmentId})`);
    }

    // Remove from admin sockets
    for (const [userId, sock] of this.adminSockets) {
      if (sock.id === client.id) {
        this.adminSockets.delete(userId);
        break;
      }
    }
  }

  private async registerCoWorkerByApiKey(client: Socket, apiKey: string, coworkerId: string) {
    const auth = await this.authGuard.resolveApiKey(apiKey);
    if (!auth) {
      this.logger.warn(`Rejected CoWorker ${client.id}: api_key 无效/已吊销（AI员工须使用激活时下发的 jw_ 密钥，用户 JWT 会过期）`);
      client.emit('cw.error', {
        code: 'CREDENTIAL_INVALID',
        error: '凭据已失效，请重新激活 AI 员工',
      });
      client.disconnect();
      return;
    }

    if (auth.coworkerId !== coworkerId) {
      this.logger.warn(`Rejected CoWorker ${client.id}: api_key 属于 ${auth.coworkerId}，但握手声明 ${coworkerId}`);
      client.emit('cw.error', {
        code: 'CREDENTIAL_MISMATCH',
        error: '凭据与 AI 员工不匹配，请重新激活',
      });
      client.disconnect();
      return;
    }

    const user = await this.userService.getUser(auth.userId);
    const userName = user?.username || user?.name || auth.userId;

    this.sockets.set(client.id, client);
    this.connectedCWs.set(auth.assignmentId, {
      socketId: client.id,
      assignmentId: auth.assignmentId,
      coworkerId,
      userId: auth.userId,
      userName,
    });
    this.socketToAssignment.set(client.id, auth.assignmentId);

    await this.cwService.updateHeartbeat(auth.assignmentId);

    const assignment = await this.cwService.getAssignment(auth.assignmentId);
    this.logger.log(`CoWorker connected: ${client.id} (cw=${coworkerId}, user=${userName})`);
    client.emit('cw.registered', {
      assignmentId: auth.assignmentId,
      configVersion: assignment?.configVersion ?? 0,
    });

    // 主动推送完整配置：客户端连接后可能在 cw.registered 中同步版本号，
    // 导致后续 cw.config.check 的版本比较（server > client）永远为 false。
    // 在注册时直接推送，保证客户端拿到最新 openclaw.json。
    if (assignment && assignment.configVersion > 0) {
      const cw = await this.cwService.getById(auth.coworkerId);
      if (cw) {
        const json = this.cwConfig.generateConfigJson(cw, this.getMainUrl(), assignment.apiKey);
        client.emit('cw.config.update', {
          version: assignment.configVersion,
          json,
          soul: this.cwConfig.generateSoulMarkdown(cw),
        });
        this.logger.log(`[ConfigPush] Initial config pushed to ${client.id} (v${assignment.configVersion})`);
      }
    }
  }

  // ===== CW → Server Events =====

  @SubscribeMessage('cw.heartbeat')
  async handleHeartbeat(@ConnectedSocket() client: Socket) {
    const assignmentId = this.socketToAssignment.get(client.id);
    if (assignmentId) {
      await this.cwService.updateHeartbeat(assignmentId);
    }
  }

  @SubscribeMessage('cw.config.check')
  async handleConfigCheck(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { currentVersion: number },
  ) {
    const assignmentId = this.socketToAssignment.get(client.id);
    if (!assignmentId) return;

    const assignment = await this.cwService.getAssignment(assignmentId);
    if (!assignment) return;

    this.logger.log(`[ConfigCheck] Assignment ${assignmentId.slice(0,8)}: client v${data.currentVersion} vs server v${assignment.configVersion}, apiKey: ${assignment.apiKey ? assignment.apiKey.slice(0,20) + '...' : 'none'}`);

    if (assignment.configVersion > data.currentVersion) {
      // Config has changed, push new config with API key
      const cw = await this.cwService.getById(assignment.coworkerId);
      if (cw) {
        // Get or generate API key for this assignment
        const apiKey = assignment.apiKey;
        const mainUrl = this.getMainUrl();
        const json = this.cwConfig.generateConfigJson(cw, mainUrl, apiKey);
        client.emit('cw.config.update', {
          version: assignment.configVersion,
          json,
          soul: this.cwConfig.generateSoulMarkdown(cw),
        });
        this.logger.log(`[ConfigUpdate] Pushed to CoWorker ${assignment.coworkerId} (v${assignment.configVersion}, apiKey: ${apiKey ? apiKey.slice(0,20) + '...' : 'no'})`);
      }
    }
  }

  @SubscribeMessage('cw.chat.sync')
  async handleChatSync(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { messages: Array<{ channel: string; direction: string; content: string; metadata?: any; createdAt?: string }> },
  ) {
    const assignmentId = this.socketToAssignment.get(client.id);
    if (!assignmentId) return;

    const { randomUUID } = await import('crypto');
    const db = (this.cwService as any).db;

    for (const msg of data.messages) {
      await db.query(
        'INSERT INTO jz_coworker_messages (id, assignment_id, channel, direction, content, metadata, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), assignmentId, msg.channel || 'wechat', msg.direction, msg.content, JSON.stringify(msg.metadata || {}), msg.createdAt || new Date()],
      );
    }

    // Notify admin sockets if any
    const cw = this.connectedCWs.get(assignmentId);
    if (cw) {
      this.broadcastToAdmins('cw.messages.new', {
        coworkerId: cw.coworkerId,
        assignmentId,
        messages: data.messages,
      });
    }
  }

  // ===== Admin/Employee → CoWorker Events =====

  @SubscribeMessage('cw.admin.send')
  async handleAdminSend(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { coworkerId: string; assignmentId: string; content: string },
  ) {
    // Find connected CW
    const cw = this.connectedCWs.get(data.assignmentId);
    if (!cw) {
      client.emit('cw.admin.error', { error: 'CoWorker 不在线' });
      return;
    }

    // Forward message to CW
    const cwSocket = this.sockets.get(cw.socketId);
    if (cwSocket) {
      cwSocket.emit('cw.chat.send', {
        content: data.content,
        from: 'admin',
        timestamp: new Date().toISOString(),
      });
    }
  }

  @SubscribeMessage('cw.chat.stream')
  async handleCWStream(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { targetUserId?: string; delta: string; done: boolean },
  ) {
    // CW streams response back → forward to admin/employee
    const assignmentId = this.socketToAssignment.get(client.id);
    if (!assignmentId) return;

    const cw = this.connectedCWs.get(assignmentId);
    if (!cw) return;

    // Forward to admin or the employee who owns this CW
    const targetSocket = this.adminSockets.get(data.targetUserId || cw.userId);
    if (targetSocket) {
      targetSocket.emit('cw.chat.stream', {
        coworkerId: cw.coworkerId,
        assignmentId,
        delta: data.delta,
        done: data.done,
      });
    }
  }

  // ===== Server Push Methods (called by controller on config changes) =====

  /**
   * Push config update to a specific CoWorker when admin modifies it.
   * Called from CoWorkerController.update().
   * Automatically includes API key for authentication.
   */
  async pushConfigUpdate(coworkerId: string, configVersion: number) {
    for (const [, cw] of this.connectedCWs) {
      if (cw.coworkerId === coworkerId) {
        const assignment = await this.cwService.getAssignment(cw.assignmentId);
        if (!assignment) continue;

        const coworker = await this.cwService.getById(coworkerId);
        if (!coworker) continue;

        const apiKey = assignment.apiKey;
        const mainUrl = this.getMainUrl();
        const json = this.cwConfig.generateConfigJson(coworker, mainUrl, apiKey);

        const sock = this.sockets.get(cw.socketId);
        if (sock) {
          sock.emit('cw.config.update', { version: configVersion, json, soul: this.cwConfig.generateSoulMarkdown(coworker) });
          this.logger.log(`Config pushed to ${cw.socketId} for CoWorker ${coworkerId} (apiKey: ${apiKey ? 'yes' : 'no'})`);
        }
      }
    }
  }

  /**
   * Force push API key config to all connected CoWorkers.
   * Called after migration to ensure all online instances get their API keys.
   */
  async pushApiKeyConfigToAll() {
    let pushed = 0;
    for (const [assignmentId, cw] of this.connectedCWs) {
      const assignment = await this.cwService.getAssignment(assignmentId);
      if (!assignment?.apiKey) {
        this.logger.warn(`Assignment ${assignmentId} has no API key, skipping`);
        continue;
      }

      const coworker = await this.cwService.getById(cw.coworkerId);
      if (!coworker) continue;

      const mainUrl = this.getMainUrl();
      const json = this.cwConfig.generateConfigJson(coworker, mainUrl, assignment.apiKey);

      const sock = this.sockets.get(cw.socketId);
      if (sock) {
        sock.emit('cw.config.update', {
          version: assignment.configVersion || Date.now(),
          json,
          soul: this.cwConfig.generateSoulMarkdown(coworker),
        });
        pushed++;
      }
    }
    this.logger.log(`Pushed API key config to ${pushed} connected CoWorkers`);
    return pushed;
  }

  /**
   * Get online status of CoWorkers.
   */
  getOnlineStatus(): Map<string, { assignmentId: string; socketId: string; userId: string }> {
    const result = new Map<string, any>();
    for (const [assignmentId, cw] of this.connectedCWs) {
      result.set(cw.coworkerId, { assignmentId, socketId: cw.socketId, userId: cw.userId });
    }
    return result;
  }

  private broadcastToAdmins(event: string, data: any) {
    for (const [, socket] of this.adminSockets) {
      socket.emit(event, data);
    }
  }

  private getMainUrl(): string {
    return process.env.MAIN_BACKEND_URL || 'http://localhost:1111';
  }

  // ===== Soul Sync Optimization =====

  /**
   * 推送去重缓存 - 记录已推送的配置版本
   * Map<assignmentId, { configVersion, pushedAt }>
   */
  private pushCache = new Map<string, { configVersion: number; pushedAt: number }>();
  private readonly PUSH_CACHE_TTL = 60000; // 1分钟缓存

  /**
   * 带去重的配置推送
   * 如果相同版本已推送过（且在缓存期内），则跳过推送
   */
  async pushConfigUpdateWithDedup(coworkerId: string, configVersion: number): Promise<number> {
    const now = Date.now();
    let pushed = 0;

    for (const [assignmentId, cw] of this.connectedCWs) {
      if (cw.coworkerId !== coworkerId) continue;

      // 检查推送缓存
      const cached = this.pushCache.get(assignmentId);
      if (cached && cached.configVersion === configVersion) {
        // 相同版本，检查缓存是否过期
        if (now - cached.pushedAt < this.PUSH_CACHE_TTL) {
          this.logger.debug(`Skipped duplicate push to ${assignmentId} (version ${configVersion})`);
          continue;
        }
      }

      const assignment = await this.cwService.getAssignment(assignmentId);
      if (!assignment) continue;

      const coworker = await this.cwService.getById(coworkerId);
      if (!coworker) continue;

      const apiKey = assignment.apiKey;
      const mainUrl = this.getMainUrl();
      const json = this.cwConfig.generateConfigJson(coworker, mainUrl, apiKey);

      const sock = this.sockets.get(cw.socketId);
      if (sock) {
        sock.emit('cw.config.update', { version: configVersion, json, soul: this.cwConfig.generateSoulMarkdown(coworker) });
        this.pushCache.set(assignmentId, { configVersion, pushedAt: now });
        pushed++;
        this.logger.log(`Config pushed to ${cw.socketId} for CoWorker ${coworkerId} (v${configVersion})`);
      }
    }

    return pushed;
  }

  /**
   * 清理过期的推送缓存
   */
  private cleanPushCache(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, value] of this.pushCache.entries()) {
      if (now - value.pushedAt > this.PUSH_CACHE_TTL) {
        expiredKeys.push(key);
      }
    }

    for (const key of expiredKeys) {
      this.pushCache.delete(key);
    }

    if (expiredKeys.length > 0) {
      this.logger.debug(`Cleaned ${expiredKeys.length} expired push cache entries`);
    }
  }

  /**
   * Gateway重载前检查 - 检查是否有正在进行的配置推送
   * 返回true表示可以安全重载
   */
  async canGatewayReload(): Promise<{ canReload: boolean; reason?: string; activePushes: number }> {
    let activePushes = 0;

    // 统计最近1分钟内有推送活动的分配
    const now = Date.now();
    for (const [assignmentId, cached] of this.pushCache.entries()) {
      if (now - cached.pushedAt < 60000) { // 1分钟内有推送
        activePushes++;
      }
    }

    if (activePushes > 0) {
      return {
        canReload: false,
        reason: `有${activePushes}个分配正在接收配置推送`,
        activePushes,
      };
    }

    // 检查是否有正在进行的Soul同步
    const { rows: syncingAssignments } = await (this.cwService as any).db.query(`
      SELECT COUNT(*) as count FROM jz_coworker_assignments
      WHERE sync_status IN ('pushing', 'syncing')
    `);

    const syncingCount = Number(syncingAssignments[0].count);
    if (syncingCount > 0) {
      return {
        canReload: false,
        reason: `有${syncingCount}个分配正在同步Soul`,
        activePushes: syncingCount,
      };
    }

    return { canReload: true, activePushes: 0 };
  }

  /**
   * 获取Soul同步状态摘要
   */
  async getSyncStatusSummary(): Promise<{
    totalAssignments: number;
    activeAssignments: number;
    pushingCount: number;
    syncingCount: number;
    failedCount: number;
    idleCount: number;
  }> {
    const { rows } = await (this.cwService as any).db.query(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN sync_status = 'pushing' THEN 1 ELSE 0 END) as pushing,
        SUM(CASE WHEN sync_status = 'syncing' THEN 1 ELSE 0 END) as syncing,
        SUM(CASE WHEN sync_status = 'failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN sync_status = 'idle' OR sync_status IS NULL THEN 1 ELSE 0 END) as idle
      FROM jz_coworker_assignments
    `);

    const row = rows[0];
    return {
      totalAssignments: Number(row.total),
      activeAssignments: Number(row.active),
      pushingCount: Number(row.pushing),
      syncingCount: Number(row.syncing),
      failedCount: Number(row.failed),
      idleCount: Number(row.idle),
    };
  }

  /**
   * 定期清理推送缓存（在handleConnection时触发）
   */
  private periodicCacheCleanup() {
    this.cleanPushCache();
  }

  /**
   * 广播用户信息变更通知
   * 向用户的所有连接的CoWorker客户端推送用户信息更新
   */
  broadcastUserProfileUpdate(userId: string, profile: any): void {
    const userSocket = this.adminSockets.get(userId);
    if (userSocket) {
      userSocket.emit('user_profile_updated', {
        userId,
        profile: {
          email: profile.email,
          phone: profile.phone,
          department: profile.department,
          position: profile.position,
          preferences: profile.preferences,
        },
        version: profile.version,
        updatedAt: new Date().toISOString(),
      });
      this.logger.log(`User profile update notification sent to user ${userId}`);
    }
  }

  /**
   * 广播用户信息变更到特定分配的CoWorker
   */
  broadcastUserProfileUpdateToCoWorker(userId: string, coworkerId: string, profile: any): void {
    for (const [, cw] of this.connectedCWs) {
      if (cw.coworkerId === coworkerId && cw.userId === userId) {
        const sock = this.sockets.get(cw.socketId);
        if (sock) {
          sock.emit('user_profile_updated', {
            userId,
            coworkerId,
            profile: {
              email: profile.email,
              phone: profile.phone,
              department: profile.department,
              position: profile.position,
              preferences: profile.preferences,
            },
            version: profile.version,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  }
}
