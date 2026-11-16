-- 钉钉单点登录：记录钉钉用户身份（unionId 唯一标识，跨应用稳定）
ALTER TABLE jz_users ADD COLUMN IF NOT EXISTS dingtalk_unionid VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jz_users_dingtalk_unionid
  ON jz_users(dingtalk_unionid) WHERE dingtalk_unionid IS NOT NULL;
