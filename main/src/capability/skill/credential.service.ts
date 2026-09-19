import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { WorkspaceService } from '../../workspace/workspace.service';
import { McpHttpClient } from '../mcp/mcp-http-client';

const ALGO = 'aes-256-gcm';
const _credKeySource = process.env.CREDENTIAL_KEY || process.env.CREDENTIAL_ENCRYPTION_KEY || process.env.JWT_SECRET || '';
if (!_credKeySource && process.env.NODE_ENV === 'production') {
  new Logger('Security').error('CREDENTIAL_KEY / CREDENTIAL_ENCRYPTION_KEY / JWT_SECRET 未设置，凭证加密不可用');
}
const ENCRYPT_KEY = crypto.createHash('sha256')
  .update(_credKeySource || `jz-dev-${require('os').hostname()}`)
  .digest();

function _encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, ENCRYPT_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), encrypted.toString('hex'), tag.toString('hex')].join(':');
}

function _decrypt(data: string): string {
  const [ivHex, encHex, tagHex] = data.split(':');
  const decipher = crypto.createDecipheriv(ALGO, ENCRYPT_KEY, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex')) + decipher.final('utf8');
}

@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);
  private static readonly GLOBAL_USER = '_global';

  constructor(private readonly workspace: WorkspaceService) {}

  private getFilePath(userId: string): string {
    return this.workspace.getUserFilePath(userId, 'credentials.enc');
  }

  private loadAll(userId: string): Record<string, Record<string, string>> {
    // Try encrypted file first
    const encPath = this.getFilePath(userId);
    if (fs.existsSync(encPath)) {
      try {
        return JSON.parse(_decrypt(fs.readFileSync(encPath, 'utf-8')));
      } catch {
        this.logger.warn(`Failed to decrypt credentials for ${userId}`);
        return {};
      }
    }
    // Migrate from legacy plaintext format
    const legacyPath = this.workspace.getUserFilePath(userId, 'credentials.json');
    if (fs.existsSync(legacyPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        this.saveAll(userId, data); // re-save encrypted
        fs.unlinkSync(legacyPath); // remove plaintext
        this.logger.log(`Migrated credentials to encrypted format for ${userId}`);
        return data;
      } catch { return {}; }
    }
    return {};
  }

  private saveAll(userId: string, data: Record<string, Record<string, string>>) {
    fs.writeFileSync(this.getFilePath(userId), _encrypt(JSON.stringify(data)), 'utf-8');
  }

  /**
   * Low-level AES-256-GCM encryption. Used by other services that need
   * at-rest encryption outside the file-based credential store.
   */
  encrypt(plaintext: string): string {
    return _encrypt(plaintext);
  }

  /** Low-level AES-256-GCM decryption. */
  decrypt(ciphertext: string): string {
    return _decrypt(ciphertext);
  }

  /** Returns true if the ciphertext uses the legacy Base64 (unencrypted) format. */
  isLegacyBase64(enc: string): boolean {
    return !enc.includes(':');
  }

  getUserCredentials(userId: string, systemName: string): Record<string, string> | null {
    const all = this.loadAll(userId);
    return all[systemName] || null;
  }

  saveUserCredentials(userId: string, systemName: string, credentials: Record<string, string>) {
    const all = this.loadAll(userId);
    all[systemName] = credentials;
    this.saveAll(userId, all);
    McpHttpClient.clearAllSessions();
    this.logger.log(`Saved credentials for user=${userId}, system=${systemName}`);
  }

  deleteUserCredentials(userId: string, systemName: string) {
    const all = this.loadAll(userId);
    delete all[systemName];
    this.saveAll(userId, all);
    McpHttpClient.clearAllSessions();
  }

  listUserSystems(userId: string): Record<string, Record<string, string>> {
    return this.loadAll(userId);
  }

  // ===== Global Credentials =====

  getGlobalCredentials(systemName: string): Record<string, string> | null {
    const all = this.loadAll(CredentialService.GLOBAL_USER);
    return all[systemName] || null;
  }

  saveGlobalCredentials(systemName: string, credentials: Record<string, string>) {
    const all = this.loadAll(CredentialService.GLOBAL_USER);
    all[systemName] = credentials;
    this.saveAll(CredentialService.GLOBAL_USER, all);
    McpHttpClient.clearAllSessions();
    this.logger.log(`Saved global credentials for system=${systemName}`);
  }

  deleteGlobalCredentials(systemName: string) {
    const all = this.loadAll(CredentialService.GLOBAL_USER);
    delete all[systemName];
    this.saveAll(CredentialService.GLOBAL_USER, all);
    McpHttpClient.clearAllSessions();
  }

  listGlobalSystems(): Record<string, Record<string, string>> {
    return this.loadAll(CredentialService.GLOBAL_USER);
  }

  /**
   * Resolve credentials with fallback chain:
   * scope='global' → global only
   * scope='user' or undefined → user first, then global fallback
   */
  resolveCredentials(userId: string, systemName: string, scope?: 'global' | 'user'): Record<string, string> | null {
    if (scope === 'global') {
      return this.getGlobalCredentials(systemName);
    }
    const userCreds = userId ? this.getUserCredentials(userId, systemName) : null;
    if (userCreds && Object.keys(userCreds).length > 0) return userCreds;
    return this.getGlobalCredentials(systemName);
  }
}
