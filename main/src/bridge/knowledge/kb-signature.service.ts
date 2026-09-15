import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { AppConfigService } from '../../config/app-config.service';

export interface KbSignedHeaders extends Record<string, string> {
  'X-JZ-User': string;
  'X-JZ-Scopes': string;
  'X-JZ-Timestamp': string;
  'X-JZ-Signature': string;
}

/**
 * Signs internal REST proxy requests to llm_wiki with HMAC-SHA256.
 *
 * The main platform and llm_wiki share KB_INTERNAL_SECRET. When the secret is
 * not configured, the service falls back to a deterministic dev secret derived
 * from JWT_SECRET so that local development keeps working. Production must set
 * KB_INTERNAL_SECRET explicitly.
 */
@Injectable()
export class KbSignatureService {
  private readonly logger = new Logger(KbSignatureService.name);

  constructor(private readonly appConfig: AppConfigService) {}

  /**
   * Sign a request on behalf of a specific user.
   * scopes is either a list of category IDs or the ADMIN_ALL sentinel.
   */
  signRequest(
    method: string,
    path: string,
    body: unknown,
    userId: string,
    scopes: string[] | 'ADMIN_ALL',
  ): KbSignedHeaders {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const scopeHeader = scopes === 'ADMIN_ALL' ? 'ADMIN_ALL' : scopes.join(',');
    const bodyHash = this.hashBody(body);
    const canonical = [method.toUpperCase(), path, timestamp, scopeHeader, bodyHash].join('\n');
    const signature = crypto
      .createHmac('sha256', this.getSecret())
      .update(canonical)
      .digest('hex');

    return {
      'X-JZ-User': userId,
      'X-JZ-Scopes': scopeHeader,
      'X-JZ-Timestamp': timestamp,
      'X-JZ-Signature': signature,
    };
  }

  /**
   * Sign an internal service request with the system identity and full access.
   */
  signInternalRequest(
    method: string,
    path: string,
    body: unknown,
  ): KbSignedHeaders {
    return this.signRequest(method, path, body, '__system__', 'ADMIN_ALL');
  }

  private hashBody(body: unknown): string {
    if (body === undefined || body === null) {
      return '';
    }
    if (typeof body === 'string') {
      return crypto.createHash('sha256').update(body, 'utf-8').digest('hex');
    }
    if (Buffer.isBuffer(body)) {
      return crypto.createHash('sha256').update(body).digest('hex');
    }
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(body), 'utf-8')
      .digest('hex');
  }

  private getSecret(): string {
    const configured = this.appConfig.get<string>('KB_INTERNAL_SECRET', '');
    if (configured) {
      return configured;
    }
    const jwtSecret = process.env.JWT_SECRET || '';
    if (jwtSecret) {
      this.logger.warn(
        'KB_INTERNAL_SECRET not set; falling back to JWT_SECRET derived dev secret. Set KB_INTERNAL_SECRET in production.',
      );
      return crypto.createHmac('sha256', 'jz-kb-internal').update(jwtSecret).digest('hex');
    }
    this.logger.warn(
      'KB_INTERNAL_SECRET and JWT_SECRET not set; using fixed dev secret. Set KB_INTERNAL_SECRET in production.',
    );
    return 'jz-dev-kb-internal-secret';
  }
}
