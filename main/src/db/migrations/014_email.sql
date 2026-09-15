-- 014: Email server configs (admin) and user email accounts

-- 管理员配置的邮件服务器（每条记录包含 SMTP 发送 + IMAP 收取）
CREATE TABLE IF NOT EXISTS jz_email_servers (
  id TEXT PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  smtp_host VARCHAR(500) NOT NULL DEFAULT '',
  smtp_port INT NOT NULL DEFAULT 465,
  smtp_encryption VARCHAR(20) NOT NULL DEFAULT 'ssl',
  imap_host VARCHAR(500) NOT NULL DEFAULT '',
  imap_port INT NOT NULL DEFAULT 993,
  imap_encryption VARCHAR(20) NOT NULL DEFAULT 'ssl',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT REFERENCES jz_users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 用户的邮箱账号
CREATE TABLE IF NOT EXISTS jz_email_accounts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES jz_users(id) ON DELETE CASCADE,
  label VARCHAR(200) NOT NULL DEFAULT '',
  email_address VARCHAR(500) NOT NULL,
  server_id TEXT REFERENCES jz_email_servers(id) ON DELETE SET NULL,
  encrypted_password TEXT NOT NULL,
  username VARCHAR(500) DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, email_address)
);

CREATE INDEX IF NOT EXISTS idx_email_accounts_user ON jz_email_accounts(user_id);
