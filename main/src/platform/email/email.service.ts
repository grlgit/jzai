import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { DbService } from '../../db/db.service';
import * as crypto from 'crypto';
import * as nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { FileCleanupService } from '../../workspace/file-cleanup.service';
import { CredentialService } from '../../capability/skill/credential.service';
import * as fs from 'fs';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    private readonly db: DbService,
    private readonly fileCleanup: FileCleanupService,
    private readonly credentialService: CredentialService,
  ) {}

  // ── 密码加解密 ─────────────────────────────────────────────────────────

  encryptPassword(password: string): string {
    return this.credentialService.encrypt(password);
  }

  decryptPassword(encrypted: string): string {
    if (this.credentialService.isLegacyBase64(encrypted)) {
      const plain = Buffer.from(encrypted, 'base64').toString('utf-8');
      return plain;
    }
    return this.credentialService.decrypt(encrypted);
  }

  // ── 邮件服务器 CRUD ───────────────────────────────────────────────────

  async getAllServers(): Promise<any[]> {
    const result = await this.db.query(
      `SELECT id, name, smtp_host, smtp_port, smtp_encryption, imap_host, imap_port, imap_encryption, enabled, created_by, created_at, updated_at FROM jz_email_servers ORDER BY created_at DESC`,
    );
    return result.rows;
  }

  async getAvailableServers(): Promise<any[]> {
    const result = await this.db.query(
      `SELECT id, name, smtp_host, smtp_port, smtp_encryption, imap_host, imap_port, imap_encryption FROM jz_email_servers WHERE enabled = true ORDER BY name`,
    );
    return result.rows;
  }

  async getServer(id: string): Promise<any> {
    const result = await this.db.query(`SELECT * FROM jz_email_servers WHERE id = $1`, [id]);
    if (result.rows.length === 0) throw new NotFoundException('Email server not found');
    return result.rows[0];
  }

  async createServer(data: any, userId?: string): Promise<any> {
    const id = crypto.randomUUID();
    const result = await this.db.query(`
      INSERT INTO jz_email_servers (id, name, smtp_host, smtp_port, smtp_encryption, imap_host, imap_port, imap_encryption, enabled, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
      RETURNING *
    `, [
      id, data.name, data.smtp_host, data.smtp_port, data.smtp_encryption,
      data.imap_host, data.imap_port, data.imap_encryption,
      data.enabled !== false, userId || null,
    ]);
    return result.rows[0];
  }

  async updateServer(id: string, data: any): Promise<any> {
    await this.getServer(id);
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const key of ['name', 'smtp_host', 'smtp_port', 'smtp_encryption', 'imap_host', 'imap_port', 'imap_encryption', 'enabled']) {
      if (data[key] !== undefined) {
        updates.push(`${key} = $${paramIndex++}`);
        values.push(data[key]);
      }
    }
    updates.push(`updated_at = NOW()`);
    values.push(id);

    await this.db.query(`UPDATE jz_email_servers SET ${updates.join(', ')} WHERE id = $${paramIndex}`, values);
    return this.getServer(id);
  }

  async deleteServer(id: string): Promise<void> {
    await this.getServer(id);
    const checkResult = await this.db.query(
      'SELECT COUNT(*) as count FROM jz_email_accounts WHERE server_id = $1', [id],
    );
    if (parseInt(checkResult.rows[0].count, 10) > 0) {
      throw new ForbiddenException(`Cannot delete server: ${checkResult.rows[0].count} email account(s) still using it`);
    }
    await this.db.query('DELETE FROM jz_email_servers WHERE id = $1', [id]);
  }

  async testServer(id: string): Promise<any> {
    const server = await this.getServer(id);
    const result: any = { success: true, message: '', smtp: null, imap: null };

    try {
      result.smtp = await this.testSmtpConnection(server);
    } catch (err: any) {
      result.smtp = { success: false, message: err.message || 'SMTP connection failed' };
    }

    try {
      result.imap = await this.testImapConnection(server);
    } catch (err: any) {
      result.imap = { success: false, message: err.message || 'IMAP connection failed' };
    }

    result.success = result.smtp?.success || false;
    result.message = result.success
      ? 'SMTP 连接成功（IMAP 测试暂未实现）'
      : 'SMTP 连接失败';

    return result;
  }

  // ── 邮箱账号 CRUD ───────────────────────────────────────────────────────

  async getUserAccounts(userId: string): Promise<any[]> {
    const result = await this.db.query(`
      SELECT a.id, a.user_id, a.label, a.email_address, a.server_id, a.username, a.is_default, a.created_at, a.updated_at,
             s.name as server_name, s.smtp_host, s.smtp_port, s.imap_host, s.imap_port
      FROM jz_email_accounts a
      LEFT JOIN jz_email_servers s ON s.id = a.server_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
    `, [userId]);
    return result.rows;
  }

  async getAccount(id: string, userId?: string): Promise<any> {
    const result = await this.db.query(`
      SELECT a.*, s.name as server_name, s.smtp_host, s.smtp_port, s.smtp_encryption, s.imap_host, s.imap_port, s.imap_encryption
      FROM jz_email_accounts a
      LEFT JOIN jz_email_servers s ON s.id = a.server_id
      WHERE a.id = $1
    `, [id]);
    if (result.rows.length === 0) throw new NotFoundException('Email account not found');
    if (userId && result.rows[0].user_id !== userId) throw new ForbiddenException('Access denied');
    return result.rows[0];
  }

  async createAccount(data: any, userId: string): Promise<any> {
    const id = crypto.randomUUID();
    if (data.is_default) {
      await this.db.query('UPDATE jz_email_accounts SET is_default = false WHERE user_id = $1', [userId]);
    }
    const encryptedPassword = this.encryptPassword(data.password);
    await this.db.query(`
      INSERT INTO jz_email_accounts (id, user_id, label, email_address, server_id, encrypted_password, username, is_default, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
    `, [id, userId, data.label, data.email_address, data.server_id, encryptedPassword, data.username || '', data.is_default ? true : false]);
    return this.getAccount(id, userId);
  }

  async updateAccount(id: string, data: any, userId: string): Promise<any> {
    await this.getAccount(id, userId);
    const updates: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const key of ['label', 'email_address', 'server_id', 'username']) {
      if (data[key] !== undefined) {
        updates.push(`${key} = $${paramIndex++}`);
        values.push(data[key]);
      }
    }
    if (data.password !== undefined) {
      updates.push(`encrypted_password = $${paramIndex++}`);
      values.push(this.encryptPassword(data.password));
    }
    if (data.is_default !== undefined) {
      if (data.is_default) {
        await this.db.query('UPDATE jz_email_accounts SET is_default = false WHERE user_id = $1 AND id != $2', [userId, id]);
      }
      updates.push(`is_default = $${paramIndex++}`);
      values.push(data.is_default);
    }
    updates.push(`updated_at = NOW()`);
    values.push(id);
    values.push(userId);

    await this.db.query(
      `UPDATE jz_email_accounts SET ${updates.join(', ')} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`,
      values,
    );
    return this.getAccount(id, userId);
  }

  async deleteAccount(id: string, userId: string): Promise<void> {
    await this.getAccount(id, userId);
    await this.db.query('DELETE FROM jz_email_accounts WHERE id = $1 AND user_id = $2', [id, userId]);
  }

  async testAccount(id: string, userId: string): Promise<any> {
    const account = await this.getAccount(id, userId);
    const result: any = { success: true, message: '' };

    if (!account.server_id) {
      return { success: false, message: 'No server configured' };
    }

    try {
      result.smtp = await this.testSmtpWithAccount(account);
    } catch (err: any) {
      result.smtp = { success: false, message: err.message || 'SMTP connection failed' };
    }

    try {
      result.imap = await this.testImapConnection(account);
    } catch (err: any) {
      result.imap = { success: false, message: err.message || 'IMAP connection failed' };
    }

    result.success = result.smtp?.success || false;
    result.message = result.success
      ? 'SMTP 连接成功（IMAP 测试暂未实现）'
      : 'SMTP 连接失败';
    return result;
  }

  // ── 发送邮件 ─────────────────────────────────────────────────────────────

  async sendMail(userId: string, options: {
    to: string;
    subject: string;
    body: string;
    html?: string;
    cc?: string;
    bcc?: string;
    attachmentFileIds?: string[];
    fromLabel?: string;
  }): Promise<{ messageId: string }> {
    const accounts = await this.getUserAccounts(userId);
    const account = accounts.find(a => a.is_default) || accounts[0];
    if (!account) throw new Error('用户没有配置邮箱账号，无法发送邮件');

    const fullAccount = await this.getAccount(account.id, userId);
    const password = this.decryptPassword(fullAccount.encrypted_password);
    const smtpTransport = this.buildTransporter({ ...fullAccount, _password: password });

    const mailOptions: nodemailer.SendMailOptions = {
      from: options.fromLabel
        ? `"${options.fromLabel}" <${fullAccount.email_address}>`
        : fullAccount.email_address,
      to: options.to,
      subject: options.subject,
      text: options.body,
      cc: options.cc || undefined,
      bcc: options.bcc || undefined,
    };

    if (options.html) {
      mailOptions.html = options.html;
    }

    if (options.attachmentFileIds?.length) {
      mailOptions.attachments = [];
      for (const fileId of options.attachmentFileIds) {
        const resolved = this.fileCleanup.resolveExportPath(userId, fileId)
          || this.fileCleanup.resolveExportPath(userId, fileId, 'pdf');
        if (resolved && fs.existsSync(resolved)) {
          mailOptions.attachments.push({ filename: fileId, path: resolved });
        } else {
          this.logger.warn(`附件文件不存在或路径非法: ${fileId}`);
        }
      }
    }

    const info = await smtpTransport.sendMail(mailOptions);

    // 惰性重加密：如果使用了旧 Base64 密码，发送成功后就地升级
    if (this.credentialService.isLegacyBase64(fullAccount.encrypted_password)) {
      const upgraded = this.encryptPassword(password);
      await this.db.query('UPDATE jz_email_accounts SET encrypted_password = $1 WHERE id = $2', [upgraded, fullAccount.id]);
      this.logger.log(`账号 ${fullAccount.email_address} 密码已从 Base64 升级为 AES-256-GCM`);
    }

    this.logger.log(`邮件已发送: ${options.subject} → ${options.to} (messageId: ${info.messageId})`);
    return { messageId: info.messageId };
  }

  // ── SMTP 传输 ─────────────────────────────────────────────────────────

  private buildTransporter(account: any): Transporter {
    const host = account.smtp_host;
    const port = parseInt(account.smtp_port, 10) || 587;
    const encryption = account.smtp_encryption || 'tls';
    const password = account._password || this.decryptPassword(account.encrypted_password);
    const user = account.username || account.email_address;

    return nodemailer.createTransport({
      host,
      port,
      secure: encryption === 'ssl',
      auth: { user, pass: password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });
  }

  private async testSmtpConnection(server: any): Promise<any> {
    const transporter = nodemailer.createTransport({
      host: server.smtp_host,
      port: parseInt(server.smtp_port, 10) || 587,
      secure: (server.smtp_encryption || 'tls') === 'ssl',
      auth: undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
    });

    try {
      await transporter.verify();
      return { success: true, message: 'SMTP 连接成功（未认证，仅测试网络可达性）' };
    } finally {
      transporter.close();
    }
  }

  private async testSmtpWithAccount(account: any): Promise<any> {
    const password = this.decryptPassword(account.encrypted_password);
    const transporter = this.buildTransporter({ ...account, _password: password });

    try {
      await transporter.verify();
      return { success: true, message: 'SMTP connection OK' };
    } finally {
      transporter.close();
    }
  }

  private async testImapConnection(_server: any): Promise<any> {
    return { success: false, message: 'IMAP 连接测试尚未实现（需要安装 imapflow 或 node-imap 库）' };
  }
}
