-- 飞书单点登录：记录飞书用户身份（unionId 唯一标识，跨应用稳定；无 unionId 时回退 openId）
ALTER TABLE jz_users ADD COLUMN IF NOT EXISTS feishu_unionid VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jz_users_feishu_unionid
  ON jz_users(feishu_unionid) WHERE feishu_unionid IS NOT NULL;
