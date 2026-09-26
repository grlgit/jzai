/**
 * X-JZ 验签单元测试。
 * 签名 fixture 复刻 main/src/bridge/knowledge/kb-signature.service.ts 的算法，
 * 保证 TS 验签与 main 签名互操作；空 body 须同时兼容 main('')与 Python(sha256(''))两种候选。
 */
import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { verifyInternalSignature, sha256Hex } from '../src/shared/signature';

const SECRET = 'test-secret-0123456789';

/** 复刻 main KbSignatureService.signRequest */
function mainSign(
  method: string,
  path: string,
  body: unknown,
  scopes: string[] | 'ADMIN_ALL',
  timestamp?: string,
) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const scopeHeader = scopes === 'ADMIN_ALL' ? 'ADMIN_ALL' : scopes.join(',');
  let bodyHash: string;
  if (body === undefined || body === null) bodyHash = '';
  else if (typeof body === 'string') bodyHash = sha256Hex(body);
  else if (Buffer.isBuffer(body)) bodyHash = sha256Hex(body);
  else bodyHash = sha256Hex(JSON.stringify(body));
  const canonical = [method.toUpperCase(), path, ts, scopeHeader, bodyHash].join('\n');
  const signature = crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
  return { user: 'u-1', scopes: scopeHeader, timestamp: ts, signature };
}

/** 复刻 Python 中间件期望的 canonical（body 恒为 raw bytes 的 sha256） */
function pythonSign(method: string, path: string, rawBody: Buffer, scopesHeader: string, timestamp?: string) {
  const ts = timestamp ?? Math.floor(Date.now() / 1000).toString();
  const canonical = [method.toUpperCase(), path, ts, scopesHeader, sha256Hex(rawBody)].join('\n');
  const signature = crypto.createHmac('sha256', SECRET).update(canonical).digest('hex');
  return { user: 'u-1', scopes: scopesHeader, timestamp: ts, signature };
}

function verify(headers: any, opts: Partial<Parameters<typeof verifyInternalSignature>[0]> = {}) {
  return verifyInternalSignature({
    method: 'GET',
    path: '/v1/knowledge-bases',
    rawBody: Buffer.alloc(0),
    headers,
    secret: SECRET,
    ...opts,
  });
}

describe('verifyInternalSignature', () => {
  it('无 X-JZ 头 → none（放行本地路径）', () => {
    expect(verify({}).kind).toBe('none');
  });

  it('头不全 → 401 Incomplete', () => {
    const r = verify({ user: 'u', timestamp: '123' });
    expect(r).toEqual({ kind: 'fail', detail: 'Incomplete internal authentication headers' });
  });

  it('时间戳非数字 → 401', () => {
    const h = mainSign('GET', '/v1/knowledge-bases', undefined, 'ADMIN_ALL', 'abc');
    const r = verify(h);
    expect(r).toEqual({ kind: 'fail', detail: 'Invalid internal authentication timestamp' });
  });

  it('时间戳过期 → 401', () => {
    const old = (Math.floor(Date.now() / 1000) - 400).toString();
    const h = mainSign('GET', '/v1/knowledge-bases', undefined, 'ADMIN_ALL', old);
    expect(verify(h)).toEqual({ kind: 'fail', detail: 'Internal authentication timestamp expired' });
  });

  it('main 签名：GET 无 body（hash 为空串）→ ok', () => {
    const h = mainSign('GET', '/v1/knowledge-bases', undefined, 'ADMIN_ALL');
    const r = verify(h);
    expect(r).toMatchObject({ kind: 'ok', user: 'u-1', adminAll: true, scopes: ['ADMIN_ALL'] });
  });

  it('Python 风格：空 body 用 sha256(b"") → ok（向后兼容）', () => {
    const h = pythonSign('GET', '/v1/knowledge-bases', Buffer.alloc(0), 'ADMIN_ALL');
    expect(verify(h).kind).toBe('ok');
  });

  it('main 签名：POST JSON body → ok', () => {
    const body = { filename: 'a.md', path: '/wiki/', content: '你好' };
    const raw = Buffer.from(JSON.stringify(body), 'utf-8');
    const h = mainSign('POST', '/v1/knowledge-bases/default/documents/note', body, ['cat-1', 'cat-2']);
    const r = verify(h, { method: 'POST', path: '/v1/knowledge-bases/default/documents/note', rawBody: raw });
    expect(r).toMatchObject({ kind: 'ok', scopes: ['cat-1', 'cat-2'], adminAll: false });
  });

  it('body 被篡改 → 401 Invalid signature', () => {
    const body = { a: 1 };
    const h = mainSign('POST', '/v1/x', body, 'ADMIN_ALL');
    const r = verify(h, { method: 'POST', path: '/v1/x', rawBody: Buffer.from(JSON.stringify({ a: 2 })) });
    expect(r).toEqual({ kind: 'fail', detail: 'Invalid internal authentication signature' });
  });

  it('path 不一致 → 401', () => {
    const h = mainSign('GET', '/v1/knowledge-bases', undefined, 'ADMIN_ALL');
    const r = verify(h, { path: '/v1/other' });
    expect(r.kind).toBe('fail');
  });

  it('签名非 hex → 401 而不是抛错', () => {
    const h = { ...mainSign('GET', '/v1/knowledge-bases', undefined, 'ADMIN_ALL'), signature: 'zzzz' };
    expect(verify(h)).toEqual({ kind: 'fail', detail: 'Invalid internal authentication signature' });
  });

  it('scopes 解析：去空白、滤空项', () => {
    const h = mainSign('GET', '/v1/knowledge-bases', undefined, ['a', ' b ', '']);
    const r = verify(h);
    expect(r).toMatchObject({ kind: 'ok', scopes: ['a', 'b'], adminAll: false });
  });

  it('密钥派生：与 main 相同的 JWT_SECRET 兜底', async () => {
    const { resolveInternalSecret } = await import('../src/config');
    const noop = () => {};
    expect(resolveInternalSecret('cfg', 'jwt', noop)).toBe('cfg');
    const derived = resolveInternalSecret('', 'jwt', noop);
    expect(derived).toBe(
      crypto.createHmac('sha256', 'jz-kb-internal').update('jwt').digest('hex'),
    );
    expect(resolveInternalSecret('', '', noop)).toBe('jz-dev-kb-internal-secret');
  });
});
