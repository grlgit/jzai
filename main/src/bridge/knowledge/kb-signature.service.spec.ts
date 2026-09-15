import { Test, TestingModule } from '@nestjs/testing';
import { KbSignatureService, KbSignedHeaders } from './kb-signature.service';
import { AppConfigService } from '../../config/app-config.service';
import * as crypto from 'crypto';

describe('KbSignatureService', () => {
  let service: KbSignatureService;
  let appConfig: { get: jest.Mock };

  beforeEach(async () => {
    appConfig = { get: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KbSignatureService,
        { provide: AppConfigService, useValue: appConfig },
      ],
    }).compile();

    service = module.get<KbSignatureService>(KbSignatureService);
  });

  afterEach(() => {
    delete process.env.JWT_SECRET;
  });

  it('signs a user request with category scopes', () => {
    appConfig.get.mockReturnValue('test-secret');

    const headers = service.signRequest('GET', '/v1/documents', undefined, 'user-1', ['cat-a', 'cat-b']);
    expect(headers['X-JZ-User']).toBe('user-1');
    expect(headers['X-JZ-Scopes']).toBe('cat-a,cat-b');
    expect(headers['X-JZ-Timestamp']).toMatch(/^\d+$/);
    expect(headers['X-JZ-Signature']).toMatch(/^[a-f0-9]{64}$/);
  });

  it('signs ADMIN_ALL as the literal sentinel', () => {
    appConfig.get.mockReturnValue('test-secret');

    const headers = service.signRequest('POST', '/v1/knowledge-bases', { x: 1 }, 'user-1', 'ADMIN_ALL');
    expect(headers['X-JZ-Scopes']).toBe('ADMIN_ALL');
  });

  it('signs an internal request with __system__ and ADMIN_ALL', () => {
    appConfig.get.mockReturnValue('test-secret');

    const headers = service.signInternalRequest('GET', '/v1/knowledge-bases', undefined);
    expect(headers['X-JZ-User']).toBe('__system__');
    expect(headers['X-JZ-Scopes']).toBe('ADMIN_ALL');
  });

  it('produces a verifiable signature', () => {
    appConfig.get.mockReturnValue('test-secret');

    const method = 'POST';
    const path = '/v1/knowledge-bases/kb-1/documents/note';
    const body = { filename: 'a.md', path: '/wiki/', content: 'hello' };
    const scopes: string[] = ['cat-1'];
    const headers = service.signRequest(method, path, body, 'user-1', scopes);

    const timestamp = headers['X-JZ-Timestamp'];
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body), 'utf-8').digest('hex');
    const canonical = [method.toUpperCase(), path, timestamp, scopes.join(','), bodyHash].join('\n');
    const expected = crypto.createHmac('sha256', 'test-secret').update(canonical).digest('hex');

    expect(headers['X-JZ-Signature']).toBe(expected);
  });

  it('falls back to JWT_SECRET-derived dev secret when KB_INTERNAL_SECRET is unset', () => {
    appConfig.get.mockReturnValue('');
    process.env.JWT_SECRET = 'jwt-dev-secret';

    const headers = service.signInternalRequest('GET', '/v1/knowledge-bases', undefined);
    expect(headers['X-JZ-Signature']).toMatch(/^[a-f0-9]{64}$/);
  });
});
