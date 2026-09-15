import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { CoWorkerCacheService, AuthData } from './coworker-cache.service';
import { DbService } from '../../db/db.service';
import { UserService } from '../../user/user.service';

/**
 * Authentication guard for CoWorker API Key endpoints.
 * Validates API keys using two-level cache (memory + Redis) with database fallback.
 * Populates req.user with user context for downstream use.
 *
 * API key format: jw_<64-hex-chars> (jw_ = jianzhi-worker)
 */
@Injectable()
export class CoWorkerAuthGuard implements CanActivate {
  constructor(
    private readonly cache: CoWorkerCacheService,
    private readonly db: DbService,
    private readonly userService: UserService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Extract API key from multiple sources (flexibility for different clients)
    const apiKey = this.extractApiKey(request);
    if (!apiKey) {
      throw new UnauthorizedException('缺少CoWorker API密钥');
    }

    // Debug: log the received token format
    console.log(`[CoWorkerAuth] Received token: prefix=${apiKey.slice(0,10)}, length=${apiKey.length}, full=${apiKey.slice(0,30)}...`);

    // Try API key format first (jw_ + 64 hex chars)
    const authData = await this.resolveApiKey(apiKey);
    if (authData) {
      this.populateUser(request, authData);
      return true;
    }

    // Fallback 1: try JWT token (CoWorkers may use user token for API calls)
    if (apiKey.startsWith('eyJ') && apiKey.length > 100) {
      console.log(`[CoWorkerAuth] Trying JWT token fallback (length=${apiKey.length})`);
      const jwtAuth = await this.authenticateWithJwtToken(apiKey);
      if (jwtAuth) {
        console.log(`[CoWorkerAuth] Using JWT token fallback`);
        this.populateUser(request, jwtAuth);
        console.log(`[CoWorkerAuth] User populated: userId=${request.user?.id}, assignmentId=${request.user?.assignmentId}, coworkerId=${request.user?.coworkerId}`);
        return true;
      }
      console.log(`[CoWorkerAuth] JWT token fallback failed`);
    }

    // Fallback 2: try enrollment token (temporary compatibility)
    const enrollAuth = await this.authenticateWithEnrollmentToken(apiKey);
    if (enrollAuth) {
      console.log(`[CoWorkerAuth] Using enrollment token fallback for ${apiKey.slice(0,10)}...`);
      this.populateUser(request, enrollAuth);
      return true;
    }

    console.log(`[CoWorkerAuth] Invalid API key format: prefix=${apiKey.slice(0,5)}, length=${apiKey.length}`);
    throw new UnauthorizedException('API密钥格式无效');
  }

  /**
   * Resolve a jw_ API key to auth data (two-level cache + database).
   * Public because CoWorkerGateway authenticates AI-employee sockets with the
   * same long-lived credential; user JWTs expire and would break config push.
   */
  async resolveApiKey(apiKey: string): Promise<AuthData | null> {
    if (!apiKey?.startsWith('jw_') || apiKey.length !== 67) return null;

    // Level 1: Check cache (99.9% of requests)
    const cached = await this.cache.get(apiKey);
    if (cached) return cached;

    // Level 2: Database lookup
    const dbAuth = await this.lookupDatabase(apiKey);
    if (dbAuth) {
      await this.cache.set(apiKey, dbAuth);
    }
    return dbAuth;
  }

  /**
   * Authenticate using JWT token (temporary fallback)
   * Allows CoWorkers using user tokens to work until they receive updated configs.
   */
  private async authenticateWithJwtToken(token: string): Promise<AuthData | null> {
    try {
      console.log(`[CoWorkerAuth] Decoding JWT token directly...`);
      // Decode JWT directly to handle different claim formats
      const jwt = require('jsonwebtoken');
      const JWT_SECRET = process.env.JWT_SECRET || 'jianzhi-secret';

      // Ignore expiration for fallback authentication - CoWorker may have cached token
      const payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true }) as any;

      // Handle both 'id' and 'userId' claims in JWT
      const userId = payload?.id || payload?.userId;
      console.log(`[CoWorkerAuth] JWT payload userId: ${userId}`);

      if (!userId) {
        console.log(`[CoWorkerAuth] No userId found in JWT payload`);
        return null;
      }

      // Find CoWorker assignment for this user
      const { rows } = await this.db.query(
        `SELECT
          a.id as assignment_id,
          a.user_id,
          a.coworker_id
        FROM jz_coworker_assignments a
        WHERE a.user_id = $1
          AND a.status IN ('active', 'pending')
        LIMIT 1`,
        [userId]
      );

      console.log(`[CoWorkerAuth] Found ${rows.length} assignments for user ${userId}`);
      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        assignmentId: row.assignment_id,
        userId: row.user_id,
        coworkerId: row.coworker_id,
      };
    } catch (err: any) {
      console.error('[CoWorkerAuth] JWT token verification failed:', err.message);
      return null;
    }
  }

  /**
   * Authenticate using enrollment token (temporary fallback)
   * Allows CoWorkers with old configs to work until they receive updated configs.
   */
  private async authenticateWithEnrollmentToken(token: string): Promise<AuthData | null> {
    try {
      const { rows } = await this.db.query(
        `SELECT
          a.id as assignment_id,
          a.user_id,
          a.coworker_id
        FROM jz_coworker_assignments a
        WHERE a.enroll_token = $1
          AND a.status IN ('active', 'pending')
        LIMIT 1`,
        [token]
      );

      if (rows.length === 0) return null;

      const row = rows[0];
      return {
        assignmentId: row.assignment_id,
        userId: row.user_id,
        coworkerId: row.coworker_id,
      };
    } catch (err: any) {
      console.error('[CoWorkerAuth] Enrollment token lookup failed:', err.message);
      return null;
    }
  }

  /**
   * Extract API key from request (multiple sources).
   * Priority: Authorization header → api_key query → X-API-Key header
   */
  private extractApiKey(request: any): string | undefined {
    // 1. Authorization: Bearer <api_key> (standard)
    const authHeader = request.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      return authHeader.slice(7);
    }

    // 2. X-API-Key header (common for API keys)
    if (request.headers?.['x-api-key']) {
      return request.headers['x-api-key'];
    }

    // 3. api_key query parameter (for testing/simple clients)
    if (request.query?.api_key) {
      return request.query.api_key;
    }

    return undefined;
  }

  /**
   * Look up API key in database.
   * Returns null if not found, revoked, or assignment inactive.
   */
  private async lookupDatabase(apiKey: string): Promise<AuthData | null> {
    try {
      const { rows } = await this.db.query(
        `SELECT
          a.id as assignment_id,
          a.user_id,
          a.coworker_id,
          a.api_key_revoked_at
        FROM jz_coworker_assignments a
        WHERE a.api_key = $1
          AND a.api_key_revoked_at IS NULL
          AND a.status IN ('active', 'pending')
        LIMIT 1`,
        [apiKey]
      );

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      return {
        assignmentId: row.assignment_id,
        userId: row.user_id,
        coworkerId: row.coworker_id,
      };
    } catch (err: any) {
      // Log error but don't throw - treat as cache miss and retry later
      console.error('[CoWorkerAuth] Database lookup failed:', err.message);
      return null;
    }
  }

  /**
   * Populate req.user with user context for downstream use.
   * Format compatible with existing resolveAssignment logic.
   */
  private populateUser(request: any, authData: AuthData): void {
    request.user = {
      id: authData.userId,
      coworkerId: authData.coworkerId,
      assignmentId: authData.assignmentId,
      // Minimal fields for compatibility
      email: '',
      username: '',
      role: { id: '', name: '', permissions: [], isSystem: false },
      status: 'active',
    };
  }
}
