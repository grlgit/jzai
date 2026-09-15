import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { DbService } from '../db/db.service';
import { CacheService } from '../cache/cache.service';

const _securityLogger = new Logger('Security');
let JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    _securityLogger.error('JWT_SECRET 环境变量未设置，生产环境不允许启动！');
    process.exit(1);
  }
  // 开发环境：生成固定种子密钥（基于机器信息，重启不变）
  JWT_SECRET = crypto.createHash('sha256').update(`jz-dev-${require('os').hostname()}`).digest('hex');
  _securityLogger.warn('JWT_SECRET 未设置，使用开发环境密钥。生产环境请设置: JWT_SECRET=<你的密钥>');
}

export const ALL_PERMISSIONS = [
  'chat:use', 'chat:coworker',
  'kb:read', 'kb:write', 'kb:review',
  'cw:view', 'cw:manage', 'cw:build',
  'dash:view', 'dash:view_all',
  'cfg:model', 'cfg:automation', 'cfg:users',
  'sys:admin',
] as const;

export type Permission = typeof ALL_PERMISSIONS[number];

export interface Role {
  id: string; name: string; description: string; permissions: Permission[]; isSystem: boolean;
}

export interface UserPublic {
  id: string; name: string; username: string; email: string; role: Role; status: string; lastLoginAt?: string;
}

const DEFAULT_ROLES: Role[] = [
  { id: 'admin', name: '管理员', description: '拥有系统全部权限', permissions: [...ALL_PERMISSIONS], isSystem: true },
  { id: 'user', name: '普通用户', description: '使用对话、查看企业心智、查看个人看板', permissions: ['chat:use', 'chat:coworker', 'kb:read', 'dash:view'], isSystem: true },
];

@Injectable()
export class UserService implements OnModuleInit {
  private readonly logger = new Logger(UserService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
  ) {}

  async onModuleInit() {
    await this.seedRoles();
    const { rows } = await this.db.query('SELECT COUNT(*) FROM jz_users');
    if (Number(rows[0].count) === 0) {
      const initPassword = crypto.randomBytes(8).toString('hex');
      await this.createUser('admin', 'admin@company.com', initPassword, 'admin', '管理员');
      // Mark admin password as NOT changed (will be set via wizard or forced on first login)
      await this.db.query("UPDATE jz_users SET password_changed = FALSE WHERE role_id = 'admin'");
      // Write initial password to a secure file as fallback
      const pwFile = require('path').join(process.cwd(), '.init-admin-password');
      require('fs').writeFileSync(pwFile, `admin@company.com:${initPassword}\n`, { mode: 0o600 });
      this.logger.warn(`初始管理员已创建 — 账号: admin@company.com，密码已写入 ${pwFile}`);

      // Ensure jz_installation row exists for setup tracking
      try {
        const { rows: instRows } = await this.db.query('SELECT COUNT(*) FROM jz_installation');
        if (Number(instRows[0].count) === 0) {
          const { createHash } = await import('crypto');
          const { hostname } = await import('os');
          const fp = createHash('sha256').update(`init-${hostname()}-${Date.now()}`).digest('hex');
          await this.db.query(
            `INSERT INTO jz_installation (id, machine_fingerprint, edition, company_name, setup_phase)
             VALUES ($1, $2, 'community', '未命名企业', 'pending')`,
            [crypto.randomUUID(), fp],
          );
        }
      } catch (err: any) {
        this.logger.warn(`Init installation row failed: ${err.message}`);
      }
    }
  }

  private async seedRoles() {
    for (const r of DEFAULT_ROLES) {
      await this.db.query(
        `INSERT INTO jz_roles(id, name, description, permissions, is_system)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
        [r.id, r.name, r.description, r.permissions, r.isSystem],
      );
    }
  }

  // ===== Roles =====

  async listRoles(): Promise<Role[]> {
    const { rows } = await this.db.query('SELECT * FROM jz_roles ORDER BY is_system DESC, name');
    return rows.map(this.mapRole);
  }

  async getRole(id: string): Promise<Role | undefined> {
    const { rows } = await this.db.query('SELECT * FROM jz_roles WHERE id=$1', [id]);
    return rows[0] ? this.mapRole(rows[0]) : undefined;
  }

  async createRole(name: string, description: string, permissions: Permission[]): Promise<Role> {
    const id = name.toLowerCase().replace(/\s+/g, '_') + '_' + Date.now().toString(36).slice(-4);
    await this.db.query('INSERT INTO jz_roles(id,name,description,permissions,is_system) VALUES($1,$2,$3,$4,FALSE)', [id, name, description, permissions]);
    return { id, name, description, permissions, isSystem: false };
  }

  async updateRole(id: string, updates: { name?: string; description?: string; permissions?: Permission[] }): Promise<Role | null> {
    const role = await this.getRole(id);
    if (!role) return null;
    const name = updates.name || role.name;
    const desc = updates.description || role.description;
    const perms = updates.permissions || role.permissions;
    await this.db.query('UPDATE jz_roles SET name=$2, description=$3, permissions=$4 WHERE id=$1', [id, name, desc, perms]);
    return { ...role, name, description: desc, permissions: perms };
  }

  async deleteRole(id: string): Promise<boolean> {
    const role = await this.getRole(id);
    if (!role || role.isSystem) return false;
    const { rows } = await this.db.query('SELECT COUNT(*) FROM jz_users WHERE role_id=$1', [id]);
    if (Number(rows[0].count) > 0) return false;
    await this.db.query('DELETE FROM jz_roles WHERE id=$1', [id]);
    return true;
  }

  getAllPermissions() {
    const labels: Record<string, string> = {
      'chat:use': '使用主智能体对话', 'chat:coworker': '与CoWorker对话',
      'kb:read': '浏览企业心智', 'kb:write': '管理企业心智内容', 'kb:review': '审核知识建议',
      'cw:view': '查看CoWorker列表', 'cw:manage': '管理CoWorker配置', 'cw:build': '构建CoWorker镜像',
      'dash:view': '查看个人看板', 'dash:view_all': '查看全员看板',
      'cfg:model': '管理模型配置', 'cfg:automation': '管理快捷系统', 'cfg:users': '管理用户和角色',
      'sys:admin': '系统管理员',
    };
    return ALL_PERMISSIONS.map(p => ({ id: p, module: p.split(':')[0], action: p.split(':')[1], label: labels[p] || p }));
  }

  // ===== Users =====

  async createUser(name: string, email: string, password: string, roleId: string = 'user', username?: string): Promise<UserPublic> {
    const id = crypto.randomUUID();  // 使用 UUID 避免并发 ID 碰撞
    const hash = await bcrypt.hash(password, 10);
    const uname = username || name;
    try {
      await this.db.query('INSERT INTO jz_users(id,name,username,email,password,role_id) VALUES($1,$2,$3,$4,$5,$6)', [id, name, uname, email, hash, roleId]);
    } catch (err: any) {
      if (err.code === '23505') {
        // email 唯一约束违规
        if (err.constraint === 'jz_users_email_key') throw new Error('邮箱已存在');
        // id 主键违规（理论上 UUID 不会碰撞，但防御性编程）
        if (err.constraint === 'jz_users_pkey') throw new Error('用户ID冲突，请重试');
      }
      throw err;
    }
    return (await this.getUser(id))!;
  }

  async login(account: string, password: string): Promise<{ token: string; accessToken: string; refreshToken: string; user: UserPublic; passwordChanged: boolean }> {
    const { rows } = await this.db.query('SELECT * FROM jz_users WHERE email=$1 OR name=$1', [account]);
    const user = rows[0];
    if (!user) throw new Error('用户不存在');
    if (user.status === 'disabled') throw new Error('账号已禁用');
    if (!await bcrypt.compare(password, user.password)) throw new Error('密码错误');

    await this.db.query('UPDATE jz_users SET last_login_at=NOW() WHERE id=$1', [user.id]);
    const role = await this.getRole(user.role_id);
    const accessToken = this.signAccessToken(user, role);
    const refreshToken = await this.createRefreshToken(user.id, user.role_id);
    return { token: accessToken, accessToken, refreshToken, user: await this.mapUser(user), passwordChanged: user.password_changed !== false };
  }

  /** Sign a short-lived access token (2h) */
  signAccessToken(user: any, role?: Role | undefined): string {
    return jwt.sign(
      { id: user.id, email: user.email, username: user.username || user.name, roleId: user.role_id, permissions: role?.permissions || [] },
      JWT_SECRET, { expiresIn: '2h' },
    );
  }

  /**
   * Sign a CoWorker access token that includes coworkerId in the JWT claims.
   * Used by Windows CoWorker clients to authenticate LLM proxy calls without
   * requiring a separate X-Coworker-Id header.
   */
  signCoWorkerToken(user: any, coworkerId: string, role?: Role | undefined): string {
    return jwt.sign(
      {
        id: user.id,
        email: user.email,
        username: user.username || user.name,
        roleId: user.role_id,
        permissions: role?.permissions || [],
        coworkerId, // Include coworkerId in JWT for LLM proxy authentication
      },
      JWT_SECRET,
      { expiresIn: '2h' },
    );
  }

  /**
   * Sign a short-lived OEM access token for embedded third-party sessions.
   * Carries the scoped permission set + oem markers so guards can recognize and
   * further constrain it. Keeps JWT_SECRET encapsulated in this service.
   */
  signOemToken(params: {
    userId: string; email: string; username: string; roleId: string;
    permissions: Permission[]; appId: string; externalUid: string;
    expiresInSeconds?: number;
  }): string {
    return jwt.sign(
      {
        id: params.userId, email: params.email, username: params.username,
        roleId: params.roleId, permissions: params.permissions,
        oem: true, app_id: params.appId, external_uid: params.externalUid,
      },
      JWT_SECRET, { expiresIn: params.expiresInSeconds ?? 900 },
    );
  }

  /** Create a refresh token stored in Redis (7d). Returns empty string if Redis unavailable. */
  async createRefreshToken(userId: string, roleId: string): Promise<string> {
    if (!this.cache.isAvailable) return '';
    const refreshToken = crypto.randomBytes(48).toString('base64url');
    await this.cache.set(`refresh:${refreshToken}`, { userId, roleId, issuedAt: Date.now() }, 7 * 24 * 3600);
    return refreshToken;
  }

  /** Consume a refresh token (one-time use) and issue new pair */
  async consumeRefreshToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    const data = await this.cache.get<{ userId: string; roleId: string }>(`refresh:${refreshToken}`);
    if (!data) return null;

    // Delete old token (rotation)
    await this.cache.del(`refresh:${refreshToken}`);

    const user = await this.getUser(data.userId);
    if (!user || user.status === 'disabled') return null;

    const role = await this.getRole(user.role.id);
    const newAccessToken = this.signAccessToken({ id: user.id, email: user.email, username: user.username, role_id: user.role.id }, role);
    const newRefreshToken = await this.createRefreshToken(user.id, user.role.id);
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
  }

  /** Invalidate a refresh token (logout) */
  async revokeRefreshToken(refreshToken: string): Promise<void> {
    await this.cache.del(`refresh:${refreshToken}`);
  }

  verifyToken(token: string): UserPublic | null {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      // Return from token payload (sync, no DB call)
      // Include additional JWT claims like coworkerId for downstream use
      const user: any = {
        id: payload.id,
        name: '',
        username: payload.username || '',
        email: payload.email,
        role: { id: payload.roleId, name: '', description: '', permissions: payload.permissions, isSystem: false },
        status: 'active'
      };
      // Forward additional claims from JWT (e.g., coworkerId for CoWorker clients)
      if (payload.coworkerId) user.coworkerId = payload.coworkerId;
      return user;
    } catch { return null; }
  }

  /** Decode OEM-specific claims from a token. Returns null if not an OEM token or invalid. */
  decodeOem(token: string): { appId: string; externalUid: string } | null {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      if (!payload.oem || !payload.app_id) return null;
      return { appId: payload.app_id, externalUid: payload.external_uid || '' };
    } catch { return null; }
  }

  async verifyTokenFull(token: string): Promise<UserPublic | null> {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      return await this.getUser(payload.id);
    } catch { return null; }
  }

  hasPermission(token: string, permission: Permission): boolean {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      return payload.permissions?.includes(permission) || payload.permissions?.includes('sys:admin');
    } catch { return false; }
  }

  async listUsers(): Promise<UserPublic[]> {
    const { rows } = await this.db.query('SELECT * FROM jz_users ORDER BY created_at');
    return Promise.all(rows.map(u => this.mapUser(u)));
  }

  async getUser(id: string): Promise<UserPublic | null> {
    const { rows } = await this.db.query('SELECT * FROM jz_users WHERE id=$1', [id]);
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async updateUser(id: string, updates: { name?: string; username?: string; password?: string; roleId?: string; status?: string }): Promise<UserPublic | null> {
    // 使用事务确保所有更新的原子性
    return this.db.transaction(async (client) => {
      if (updates.name) await client.query('UPDATE jz_users SET name=$2 WHERE id=$1', [id, updates.name]);
      if (updates.username) await client.query('UPDATE jz_users SET username=$2 WHERE id=$1', [id, updates.username]);
      if (updates.roleId) await client.query('UPDATE jz_users SET role_id=$2 WHERE id=$1', [id, updates.roleId]);
      if (updates.status) await client.query('UPDATE jz_users SET status=$2 WHERE id=$1', [id, updates.status]);
      if (updates.password) {
        const hash = await bcrypt.hash(updates.password, 10);
        await client.query('UPDATE jz_users SET password=$2, password_changed=TRUE WHERE id=$1', [id, hash]);
      }
      // 事务提交后获取更新后的用户数据
      return this.getUser(id);
    });
  }

  async deleteUser(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM jz_users WHERE id=$1', [id]);
    return (rowCount || 0) > 0;
  }

  private mapRole(row: any): Role {
    return { id: row.id, name: row.name, description: row.description, permissions: row.permissions || [], isSystem: row.is_system };
  }

  private async mapUser(row: any): Promise<UserPublic> {
    const role = await this.getRole(row.role_id) || DEFAULT_ROLES[1];
    return { id: row.id, name: row.name, username: row.username || row.name, email: row.email, role, status: row.status, lastLoginAt: row.last_login_at?.toISOString() };
  }

  // ===== User Profile Management (Revised: Reuse jz_users, only extend in jz_user_profiles) =====

  /**
   * 获取用户完整信息（包括扩展信息）
   */
  async getUserProfile(userId: string): Promise<any | null> {
    const { rows } = await this.db.query(`
      SELECT
        u.id, u.name, u.username, u.email, u.status, u.last_login_at, u.created_at,
        p.id as profile_id, p.phone, p.department, p.position, p.manager_id,
        p.preferences, p.version, p.is_first_fill, p.first_filled_at,
        p.created_at as profile_created_at, p.updated_at as profile_updated_at
      FROM jz_users u
      LEFT JOIN jz_user_profiles p ON u.id = p.user_id
      WHERE u.id = $1
    `, [userId]);

    if (rows.length === 0) return null;

    const row = rows[0];
    return {
      // 用户基本信息（来自jz_users）
      id: row.id,
      name: row.name,
      username: row.username,
      email: row.email,
      status: row.status,
      lastLoginAt: row.last_login_at,
      createdAt: row.created_at,

      // 扩展信息（来自jz_user_profiles）
      profileId: row.profile_id,
      phone: row.phone,
      department: row.department,
      position: row.position,
      managerId: row.manager_id,
      preferences: typeof row.preferences === 'string' ? JSON.parse(row.preferences) : (row.preferences || {}),
      version: row.version || 1,
      isFirstFill: row.is_first_fill || true,
      firstFilledAt: row.first_filled_at,
      profileUpdatedAt: row.profile_updated_at,
    };
  }

  /**
   * 更新用户信息
   * @param userId 用户ID
   * @param updates 更新内容（email更新jz_users，其他更新jz_user_profiles）
   * @param skipValidation 是否跳过验证
   */
  async updateUserProfile(
    userId: string,
    updates: {
      email?: string;
      name?: string;
      phone?: string;
      department?: string;
      position?: string;
      preferences?: Record<string, any>;
    },
    skipValidation = false,
  ): Promise<any> {
    return await this.db.transaction(async (client) => {
      // 1. 验证邮箱格式（如果要更新邮箱）
      if (updates.email) {
        if (!this.validateEmailFormat(updates.email)) {
          throw new Error('邮箱格式不正确');
        }
      }

      // 2. 更新jz_users表（email, name）
      if (updates.email || updates.name) {
        const userUpdates: string[] = [];
        const userValues: any[] = [];
        let paramIndex = 1;

        if (updates.email) {
          userUpdates.push(`email = $${paramIndex++}`);
          userValues.push(updates.email);
        }
        if (updates.name) {
          userUpdates.push(`name = $${paramIndex++}`);
          userValues.push(updates.name);
        }

        if (userUpdates.length > 0) {
          userValues.push(userId);
          await client.query(
            `UPDATE jz_users SET ${userUpdates.join(', ')} WHERE id = $${paramIndex}`,
            userValues
          );
        }
      }

      // 3. 更新jz_user_profiles表（扩展字段）
      if (updates.phone || updates.department || updates.position || updates.preferences) {
        const profileUpdates: string[] = [];

        if (updates.phone !== undefined) {
          profileUpdates.push('phone = EXCLUDED.phone');
        }
        if (updates.department !== undefined) {
          profileUpdates.push('department = EXCLUDED.department');
        }
        if (updates.position !== undefined) {
          profileUpdates.push('position = EXCLUDED.position');
        }
        if (updates.preferences !== undefined) {
          profileUpdates.push('preferences = EXCLUDED.preferences');
        }
        profileUpdates.push('updated_at = NOW()');

        // 使用 UPSERT 确保profile记录存在
        await client.query(`
          INSERT INTO jz_user_profiles (user_id, phone, department, position, preferences, is_first_fill)
          VALUES ($1, $2, $3, $4, $5, true)
          ON CONFLICT (user_id) DO UPDATE SET
            ${profileUpdates.join(', ')}
        `, [
          userId,
          updates.phone ?? null,
          updates.department ?? null,
          updates.position ?? null,
          updates.preferences ? JSON.stringify(updates.preferences) : '{}',
        ]);
      }

      this.logger.log(`User profile updated: ${userId}`);

      // 返回更新后的完整信息
      return await this.getUserProfile(userId);
    });
  }

  /**
   * 检查用户信息是否完整
   * 用于判断是否需要提示用户补充信息
   */
  async isProfileComplete(userId: string): Promise<boolean> {
    const profile = await this.getUserProfile(userId);
    if (!profile) return false;

    // 必填项检查
    const requiredFields = ['email'];
    for (const field of requiredFields) {
      if (!profile[field] || profile[field].trim() === '') {
        return false;
      }
    }

    return true;
  }

  /**
   * 获取用户信息变更历史
   */
  async getProfileChangeHistory(userId: string, limit = 20): Promise<any[]> {
    const { rows } = await this.db.query(`
      SELECT c.*, u.name as user_name
      FROM jz_user_profile_changes c
      LEFT JOIN jz_users u ON c.user_id = u.id
      WHERE c.user_id = $1
      ORDER BY c.changed_at DESC
      LIMIT $2
    `, [userId, limit]);

    return rows.map(row => ({
      id: row.id,
      fieldName: row.field_name,
      oldValue: row.old_value,
      newValue: row.new_value,
      changeReason: row.change_reason,
      changeSource: row.change_source,
      changedAt: row.changed_at,
      userName: row.user_name,
    }));
  }

  /**
   * 验证邮箱格式
   */
  validateEmailFormat(email: string): boolean {
    const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    return emailRegex.test(email);
  }

  /**
   * 同步用户邮箱到主用户表（当用户更新个人信息时）
   */
  private async syncEmailToUserTable(userId: string, email: string): Promise<void> {
    await this.db.query('UPDATE jz_users SET email = $2 WHERE id = $1', [userId, email]);
  }
}
