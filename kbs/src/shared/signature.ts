/**
 * X-JZ-* 内部 HMAC 签名验证 — 与两侧既有实现逐字对齐：
 *
 *   canonical = METHOD\npath(不含query)\ntimestamp\nscopes\nsha256(rawBody)
 *   签名方: main/src/bridge/knowledge/kb-signature.service.ts
 *   旧验证方: llm_wiki/api/main.py:261-326
 *
 * 关键兼容点：空 body 时 main 的 hashBody(undefined) 产出 ''（空串），
 * 而 Python 中间件对 b'' 产出 sha256('')。两种候选都接受。
 */
import * as crypto from 'crypto';

export const INTERNAL_HEADER_TTL_SECONDS = 300;

export interface InternalHeaders {
  user?: string;
  scopes?: string;
  signature?: string;
  timestamp?: string;
}

export type VerifyResult =
  | { kind: 'none' } // 无 X-JZ 头 → 交给本地固定身份/JWT 路径
  | { kind: 'ok'; user: string; scopes: string[]; adminAll: boolean }
  | { kind: 'fail'; detail: string };

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function verifyInternalSignature(args: {
  method: string;
  path: string;
  rawBody: Buffer;
  headers: InternalHeaders;
  secret: string;
  now?: number; // 秒
  ttlSeconds?: number;
}): VerifyResult {
  const { method, path, rawBody, headers, secret } = args;
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const ttl = args.ttlSeconds ?? INTERNAL_HEADER_TTL_SECONDS;

  const { user, scopes, signature, timestamp } = headers;

  if (!user && !scopes && !signature && !timestamp) {
    return { kind: 'none' };
  }
  if (!(user && scopes && signature && timestamp)) {
    return { kind: 'fail', detail: 'Incomplete internal authentication headers' };
  }

  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts)) {
    return { kind: 'fail', detail: 'Invalid internal authentication timestamp' };
  }
  if (Math.abs(now - ts) > ttl) {
    return { kind: 'fail', detail: 'Internal authentication timestamp expired' };
  }
  if (!secret) {
    return { kind: 'fail', detail: 'Internal authentication not configured' };
  }

  // 空 body 双候选：''（main 风格）与 sha256('')（Python 风格）
  const bodyHashCandidates =
    rawBody.length > 0 ? [sha256Hex(rawBody)] : ['', sha256Hex(Buffer.alloc(0))];

  const provided = /^[0-9a-f]{64}$/i.test(signature) ? Buffer.from(signature, 'hex') : null;

  for (const bodyHash of bodyHashCandidates) {
    const canonical = [method.toUpperCase(), path, timestamp, scopes, bodyHash].join('\n');
    const expected = crypto.createHmac('sha256', secret).update(canonical, 'utf-8').digest();
    if (provided && provided.length === expected.length && crypto.timingSafeEqual(expected, provided)) {
      const scopeList = scopes
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { kind: 'ok', user, scopes: scopeList, adminAll: scopeList.includes('ADMIN_ALL') };
    }
  }

  return { kind: 'fail', detail: 'Invalid internal authentication signature' };
}
