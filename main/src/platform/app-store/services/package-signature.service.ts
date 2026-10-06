import { Injectable, Logger } from '@nestjs/common';
import { createHash, createPublicKey, verify } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type PackageSignatureStatus = 'valid' | 'unsigned' | 'invalid';

export interface PackageSignatureResult {
  status: PackageSignatureStatus;
  detail?: string;
}

export const SIGNATURE_FILE = 'PACKAGE-SIGNATURE.json';

// Public key for .jzapp package signature verification (independent from the
// license key pair). Private key lives only in release CI / signing env.
// Override via APP_PACKAGE_PUBLIC_KEY env for dev/testing.
const EMBEDDED_PACKAGE_PUBLIC_KEY = process.env.APP_PACKAGE_PUBLIC_KEY
  ? process.env.APP_PACKAGE_PUBLIC_KEY.includes('BEGIN')
    ? process.env.APP_PACKAGE_PUBLIC_KEY.replace(/\\n/g, '\n')
    : `-----BEGIN PUBLIC KEY-----\n${process.env.APP_PACKAGE_PUBLIC_KEY}\n-----END PUBLIC KEY-----`
  : `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAYFfUm4G8O2wRUWPQyUL+ed8LrpDypcdp+l0Y9Y8QR3w=
-----END PUBLIC KEY-----`;

/** 包签名强制开关：默认强制；本地开发可显式 APP_SIGNATURE_ENFORCE=off 关闭 */
export function isPackageSignatureEnforced(): boolean {
  return (process.env.APP_SIGNATURE_ENFORCE || '').toLowerCase() !== 'off';
}

/** Canonical payload for signing: files map with sorted keys. */
export function canonicalSignaturePayload(files: Record<string, string>): string {
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(files).sort()) sorted[key] = files[key];
  return JSON.stringify({ files: sorted });
}

/**
 * .jzapp 包签名验签（来源验证 + 防修改）。
 *
 * 包内 PACKAGE-SIGNATURE.json：{ files: {相对路径: sha256}, signature: base64 }
 * - 逐文件重算 sha256 比对（防修改）
 * - 文件集合必须完全一致（防新增/删除文件夹带）
 * - Ed25519 验签（防伪造清单）
 *
 * 注意：与主台其他校验同级——开源主台内的验签是诚实客户路径，
 * 最终防线是闭源 app-store APP 的独立验签（设计方案 3.1 节）。
 */
@Injectable()
export class PackageSignatureService {
  private readonly logger = new Logger(PackageSignatureService.name);
  private warnedDisabled = false;

  /** 计算包的 sha256（流式，避免大文件 OOM） */
  async hashFile(filePath: string): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', chunk => hash.update(chunk));
      stream.on('end', () => resolvePromise(hash.digest('hex')));
      stream.on('error', rejectPromise);
    });
  }

  /** 验签解包后的目录 */
  verifyDirectory(extractDir: string): PackageSignatureResult {
    const sigPath = path.join(extractDir, SIGNATURE_FILE);
    if (!fs.existsSync(sigPath)) {
      return { status: 'unsigned' };
    }

    let envelope: { files?: Record<string, string>; signature?: string };
    try {
      envelope = JSON.parse(fs.readFileSync(sigPath, 'utf-8'));
    } catch {
      return { status: 'invalid', detail: 'PACKAGE-SIGNATURE.json 无法解析' };
    }
    if (!envelope.files || typeof envelope.files !== 'object' || !envelope.signature) {
      return { status: 'invalid', detail: 'PACKAGE-SIGNATURE.json 缺少 files 或 signature' };
    }

    // 1. Ed25519 验签清单
    try {
      const canonical = canonicalSignaturePayload(envelope.files);
      const pubKey = createPublicKey(EMBEDDED_PACKAGE_PUBLIC_KEY);
      if (!verify(null, Buffer.from(canonical, 'utf-8'), pubKey, Buffer.from(envelope.signature, 'base64'))) {
        return { status: 'invalid', detail: '签名验签失败（清单被替换或密钥不符）' };
      }
    } catch (err: any) {
      return { status: 'invalid', detail: `签名验签异常: ${err.message}` };
    }

    // 2. 文件集合一致性（防新增/删除）
    const actual = new Set<string>();
    this.walk(extractDir, extractDir, actual);
    actual.delete(SIGNATURE_FILE);
    const listed = new Set(Object.keys(envelope.files));
    for (const f of actual) {
      if (!listed.has(f)) return { status: 'invalid', detail: `存在未签名文件: ${f}` };
    }
    for (const f of listed) {
      if (!actual.has(f)) return { status: 'invalid', detail: `签名清单中的文件缺失: ${f}` };
    }

    // 3. 逐文件 sha256 比对（防修改）
    for (const [rel, expected] of Object.entries(envelope.files)) {
      const full = path.join(extractDir, rel);
      // 防路径穿越
      if (!path.resolve(full).startsWith(path.resolve(extractDir) + path.sep)) {
        return { status: 'invalid', detail: `签名清单包含非法路径: ${rel}` };
      }
      const actualHash = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (actualHash !== expected) {
        return { status: 'invalid', detail: `文件被篡改: ${rel}` };
      }
    }

    return { status: 'valid' };
  }

  /** 校验结果是否放行；enforced=false 时记录告警并一律放行（开发模式） */
  check(result: PackageSignatureResult, firstParty: boolean): { ok: boolean; warning?: string } {
    if (!isPackageSignatureEnforced()) {
      if (!this.warnedDisabled) {
        this.logger.warn('APP_SIGNATURE_ENFORCE=off — 包签名校验已关闭（仅开发环境可用）');
        this.warnedDisabled = true;
      }
      return { ok: true, warning: '签名校验已关闭（APP_SIGNATURE_ENFORCE=off）' };
    }
    if (result.status === 'valid') return { ok: true };
    if (result.status === 'invalid') {
      return { ok: false, warning: `应用包签名验证失败: ${result.detail}` };
    }
    // unsigned
    return firstParty
      ? { ok: false, warning: '官方应用包缺少签名，拒绝安装' }
      : { ok: true, warning: '应用包未签名（第三方包来源与完整性无法保证）' };
  }

  private walk(base: string, dir: string, out: Set<string>): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(base, full, out);
      } else if (entry.isFile()) {
        out.add(path.relative(base, full).split(path.sep).join('/'));
      }
    }
  }
}
