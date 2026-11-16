import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { DbService } from '../db/db.service';
import { UserService } from './user.service';

const FEISHU_API_BASE = 'https://open.feishu.cn/open-apis';

/** 与普通登录返回结构保持一致（前端 useAuth 直接复用落库逻辑） */
export interface FeishuLoginResult {
  token: string;
  accessToken: string;
  refreshToken: string;
  user: any;
  passwordChanged: boolean;
  isNewUser: boolean;
}

@Injectable()
export class FeishuService {
  private readonly logger = new Logger(FeishuService.name);

  constructor(
    private readonly db: DbService,
    private readonly userService: UserService,
  ) {}

  private get appId(): string { return process.env.FEISHU_APP_ID || ''; }
  private get appSecret(): string { return process.env.FEISHU_APP_SECRET || ''; }

  get configured(): boolean {
    return !!(this.appId && this.appSecret);
  }

  /** 应用 app_id（飞书侧公开标识，非敏感信息可公开；前端 h5sdk getAuthCode / OAuth 跳转需要） */
  get publicAppId(): string {
    return this.appId;
  }

  /** 授权码换 user_access_token：优先 v1 OIDC（JSSDK getAuthCode 场景，无需 redirect_uri），
   *  失败时回退 v2 OAuth（重定向授权场景，redirect_uri 须与授权时一致） */
  private async exchangeUserAccessToken(authCode: string, redirectUri?: string): Promise<string> {
    let res = await fetch(`${FEISHU_API_BASE}/authen/v1/oidc/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
        grant_type: 'authorization_code',
        code: authCode,
      }),
    });
    let data = await res.json() as any;
    if (data.code === 0 && data.data?.access_token) return data.data.access_token as string;

    res = await fetch(`${FEISHU_API_BASE}/authen/v2/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: this.appId,
        client_secret: this.appSecret,
        code: authCode,
        redirect_uri: redirectUri || undefined,
      }),
    });
    data = await res.json() as any;
    if (data.code === 0 && data.access_token) return data.access_token as string;

    this.logger.error(`飞书授权码换 user_access_token 失败: ${JSON.stringify(data)}`);
    throw new UnauthorizedException('飞书授权码无效或已过期，请重试');
  }

  /** 免登授权码（一次性）换飞书用户身份：先换 user_access_token，再取用户信息 */
  private async getUserByAuthCode(authCode: string, redirectUri?: string): Promise<{ openId: string; unionId: string; name: string }> {
    if (!this.configured) throw new UnauthorizedException('飞书登录未配置（缺少 FEISHU_APP_ID/FEISHU_APP_SECRET）');

    const userAccessToken = await this.exchangeUserAccessToken(authCode, redirectUri);

    const res2 = await fetch(`${FEISHU_API_BASE}/authen/v1/user_info`, {
      headers: { Authorization: `Bearer ${userAccessToken}` },
    });
    const data2 = await res2.json() as any;
    const info = data2?.data;
    if (data2.code !== 0 || !info?.open_id) {
      this.logger.error(`获取飞书用户信息失败: ${JSON.stringify(data2)}`);
      throw new UnauthorizedException('获取飞书用户信息失败，请重试');
    }
    // unionId 跨应用稳定，优先；与钉钉免登保持一致的账号名格式（飞书用户_XXXXXX）
    const openId: string = info.open_id;
    const unionId: string = info.union_id || openId;
    const name: string = `飞书用户_${unionId.slice(-6)}`;
    return { openId, unionId, name };
  }

  /** 免登主流程：换身份 → 查找/自动创建账号 → 签发系统 token */
  async loginWithAuthCode(authCode: string, redirectUri?: string): Promise<FeishuLoginResult> {
    if (!authCode) throw new UnauthorizedException('缺少飞书授权码');
    const { unionId, name } = await this.getUserByAuthCode(authCode, redirectUri);

    const { rows } = await this.db.query(
      'SELECT * FROM jz_users WHERE feishu_unionid=$1 LIMIT 1', [unionId]);
    let dbUser = rows[0];
    const isNewUser = !dbUser;

    if (dbUser && dbUser.status === 'disabled') throw new UnauthorizedException('账号已禁用');

    if (!dbUser) {
      // 首次登录自动创建：随机密码（不会被直接登录使用，除非管理员重置），默认普通用户角色
      const id = crypto.randomUUID();
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const email = `feishu-${unionId}@feishu.local`;
      const hash = await bcrypt.hash(randomPassword, 10);
      try {
        await this.db.query(
          'INSERT INTO jz_users(id,name,username,email,password,role_id,password_changed,feishu_unionid) VALUES($1,$2,$3,$4,$5,$6,TRUE,$7)',
          [id, name, name, email, hash, 'user', unionId]);
      } catch (err: any) {
        // 并发首登撞唯一索引：回查已有账号即可，其他错误照常抛出
        const { rows: retry } = await this.db.query(
          'SELECT * FROM jz_users WHERE feishu_unionid=$1 LIMIT 1', [unionId]);
        if (!retry[0]) throw err;
      }
      const { rows: finalRows } = await this.db.query(
        'SELECT * FROM jz_users WHERE feishu_unionid=$1 LIMIT 1', [unionId]);
      dbUser = finalRows[0];
      this.logger.log(`飞书用户首次登录，已自动创建账号: ${name} (${unionId})`);
    }

    await this.db.query('UPDATE jz_users SET last_login_at=NOW() WHERE id=$1', [dbUser.id]);
    const role = await this.userService.getRole(dbUser.role_id);
    const accessToken = this.userService.signAccessToken(dbUser, role);
    const refreshToken = await this.userService.createRefreshToken(dbUser.id, dbUser.role_id);
    const user = await this.userService.getUser(dbUser.id);
    return { token: accessToken, accessToken, refreshToken, user, passwordChanged: true, isNewUser };
  }
}
