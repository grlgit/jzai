/**
 * Email Module Types
 */

// 邮件服务器配置
export interface EmailServer {
  id: string;
  name: string;
  smtp_host: string;
  smtp_port: number;
  smtp_encryption: 'ssl' | 'tls' | 'none';
  imap_host: string;
  imap_port: number;
  imap_encryption: 'ssl' | 'tls' | 'none';
  enabled: boolean;
  created_by?: string;
  created_at: Date;
  updated_at: Date;
}

// 用户邮箱账号
export interface EmailAccount {
  id: string;
  user_id: string;
  label: string;
  email_address: string;
  server_id?: string;
  username?: string;
  encrypted_password: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
  // 关联数据（不存储在数据库）
  server?: EmailServer;
}

// 创建服务器 DTO
export interface CreateServerDto {
  name: string;
  smtp_host: string;
  smtp_port: number;
  smtp_encryption: 'ssl' | 'tls' | 'none';
  imap_host: string;
  imap_port: number;
  imap_encryption: 'ssl' | 'tls' | 'none';
  enabled?: boolean;
}

// 更新服务器 DTO
export interface UpdateServerDto {
  name?: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_encryption?: 'ssl' | 'tls' | 'none';
  imap_host?: string;
  imap_port?: number;
  imap_encryption?: 'ssl' | 'tls' | 'none';
  enabled?: boolean;
}

// 创建账号 DTO
export interface CreateAccountDto {
  label: string;
  email_address: string;
  server_id: string;
  password: string;
  username?: string;
  is_default?: boolean;
}

// 更新账号 DTO
export interface UpdateAccountDto {
  label?: string;
  email_address?: string;
  server_id?: string;
  password?: string;
  username?: string;
  is_default?: boolean;
}

// 测试结果
export interface TestResult {
  success: boolean;
  message: string;
  smtp?: { success: boolean; message: string };
  imap?: { success: boolean; message: string };
}
