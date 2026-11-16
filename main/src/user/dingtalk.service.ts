import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import * as crypto from 'crypto';
import { DbService } from '../db/db.service';
import { CacheService } from '../cache/cache.service';
import { UserService } from './user.service';

const DINGTALK_API_BASE = 'https://api.dingtalk.com';
const DINGTALK_OAPI_BASE = 'https://oapi.dingtalk.com';

/** 与普通登录返回结构保持一致（前端 useAuth 直接复用落库逻辑） */
export interface DingtalkLoginResult {
  token: string;
  accessToken: string;
  refreshToken: string;
  user: any;
  passwordChanged: boolean;
  isNewUser: boolean;
}

@Injectable()
export class DingtalkService {
  private readonly logger = new Logger(DingtalkService.name);

  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly userService: UserService,
  ) {}

  private get appKey(): string { return process.env.DINGTALK_APP_KEY || ''; }
  private get appSecret(): string { return process.env.DINGTALK_APP_SECRET || ''; }

  get configured(): boolean {
    return !!(this.appKey && this.appSecret);
  }

  /** 企业 corpId（免登 requestAuthCode 必需），非敏感信息可公开 */
  get corpId(): string {
    return process.env.DINGTALK_CORP_ID || '';
  }

  /** 企业应用 access_token（钉钉侧，与系统 JWT 无关），Redis 缓存至有效期前 5 分钟 */
  private async getDingtalkAccessToken(): Promise<string> {
    if (!this.configured) throw new UnauthorizedException('钉钉登录未配置（缺少 DINGTALK_APP_KEY/DINGTALK_APP_SECRET）');
    const cached = await this.cache.get<string>('dingtalk:access_token');
    if (cached) return cached;

    const res = await fetch(`${DINGTALK_API_BASE}/v1.0/oauth2/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appKey: this.appKey, appSecret: this.appSecret }),
    });
    const data = await res.json() as any;
    if (!data.accessToken) {
      this.logger.error(`获取钉钉 access_token 失败: ${JSON.stringify(data)}`);
      throw new UnauthorizedException('钉钉凭证无效，请检查 DINGTALK_APP_KEY/APP_SECRET 配置');
    }
    // expireIn 单位秒（通常 7200），提前 5 分钟过期
    await this.cache.set('dingtalk:access_token', data.accessToken, Math.max(60, (data.expireIn || 7200) - 300));
    return data.accessToken;
  }

  /** 免登授权码（5 分钟有效、一次性）换取钉钉用户身份 */
  private async getUserByAuthCode(authCode: string): Promise<{ userid: string; unionid: string; name: string }> {
    const accessToken = await this.getDingtalkAccessToken();

    const res = await fetch(`${DINGTALK_OAPI_BASE}/topapi/v2/user/getuserinfo?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: authCode }),
    });
    const data = await res.json() as any;
    if (data.errcode !== 0 || !data.result?.userid) {
      this.logger.error(`钉钉免登换身份失败: ${JSON.stringify(data)}`);
      throw new UnauthorizedException('钉钉授权码无效或已过期，请重试');
    }
    const { userid, unionid } = data.result;

    // 仅取姓名用于显示（不采集手机号/邮箱等个人信息）
    let name = `钉钉用户_${userid.slice(-6)}`;
    try {
      const res2 = await fetch(`${DINGTALK_OAPI_BASE}/topapi/v2/user/get?access_token=${accessToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userid }),
      });
      const data2 = await res2.json() as any;
      if (data2.errcode === 0 && data2.result?.name) name = data2.result.name;
    } catch (e: any) {
      this.logger.warn(`获取钉钉用户姓名失败（不影响登录）: ${e.message}`);
    }
    return { userid, unionid: unionid || userid, name };
  }

  /** 免登主流程：换身份 → 查找/自动创建账号 → 签发系统 token */
  async loginWithAuthCode(authCode: string): Promise<DingtalkLoginResult> {
    if (!authCode) throw new UnauthorizedException('缺少钉钉授权码');
    const { unionid, name } = await this.getUserByAuthCode(authCode);

    const { rows } = await this.db.query(
      'SELECT * FROM jz_users WHERE dingtalk_unionid=$1 LIMIT 1', [unionid]);
    let dbUser = rows[0];
    const isNewUser = !dbUser;

    if (dbUser && dbUser.status === 'disabled') throw new UnauthorizedException('账号已禁用');

    if (!dbUser) {
      // 首次登录自动创建：随机密码（不会被直接登录使用，除非管理员重置），默认普通用户角色
      const id = crypto.randomUUID();
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const email = `dingtalk-${unionid}@dingtalk.local`;
      const hash = await bcrypt.hash(randomPassword, 10);
      try {
        await this.db.query(
          'INSERT INTO jz_users(id,name,username,email,password,role_id,password_changed,dingtalk_unionid) VALUES($1,$2,$3,$4,$5,$6,TRUE,$7)',
          [id, name, name, email, hash, 'user', unionid]);
      } catch (err: any) {
        // 并发首登撞唯一索引：回查已有账号即可，其他错误照常抛出
        const { rows: retry } = await this.db.query(
          'SELECT * FROM jz_users WHERE dingtalk_unionid=$1 LIMIT 1', [unionid]);
        if (!retry[0]) throw err;
      }
      const { rows: finalRows } = await this.db.query(
        'SELECT * FROM jz_users WHERE dingtalk_unionid=$1 LIMIT 1', [unionid]);
      dbUser = finalRows[0];
      this.logger.log(`钉钉用户首次登录，已自动创建账号: ${name} (${unionid})`);
    }

    await this.db.query('UPDATE jz_users SET last_login_at=NOW() WHERE id=$1', [dbUser.id]);
    const role = await this.userService.getRole(dbUser.role_id);
    const accessToken = this.userService.signAccessToken(dbUser, role);
    const refreshToken = await this.userService.createRefreshToken(dbUser.id, dbUser.role_id);
    const user = await this.userService.getUser(dbUser.id);
    return { token: accessToken, accessToken, refreshToken, user, passwordChanged: true, isNewUser };
  }
}
