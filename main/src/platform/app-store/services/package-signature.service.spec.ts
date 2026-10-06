import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, generateKeyPairSync, sign } from 'crypto';

/**
 * PackageSignatureService 验签与 app-license 验签的 roundtrip 测试。
 * 两个模块的公钥都在模块加载时从 env 读取，因此用 jest.resetModules + 动态 import 隔离。
 */
describe('PackageSignatureService & AppLicense (crypto roundtrip)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  let dir: string;
  let service: any;
  let canonicalFn: (files: Record<string, string>) => string;

  const writeFile = (rel: string, content: string) => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  const signDir = (targetDir: string) => {
    const files: Record<string, string> = {};
    const walk = (base: string, d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) { walk(base, full); continue; }
        const rel = path.relative(base, full).split(path.sep).join('/');
        files[rel] = createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    };
    walk(targetDir, targetDir);
    const canonical = canonicalFn(files);
    const signature = sign(null, Buffer.from(canonical, 'utf-8'), privateKey).toString('base64');
    fs.writeFileSync(path.join(targetDir, 'PACKAGE-SIGNATURE.json'), JSON.stringify({ files, signature }));
  };

  beforeEach(async () => {
    jest.resetModules();
    process.env.APP_PACKAGE_PUBLIC_KEY = pubPem;
    process.env.LICENSE_PUBLIC_KEY = pubPem;
    delete process.env.APP_SIGNATURE_ENFORCE;

    const mod = require('./package-signature.service');
    service = new mod.PackageSignatureService();
    canonicalFn = mod.canonicalSignaturePayload;

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jzsig-'));
    writeFile('manifest.json', '{"appId":"com.jianzhi.test"}');
    writeFile('dist/index.js', 'console.log(1)');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.APP_PACKAGE_PUBLIC_KEY;
    delete process.env.LICENSE_PUBLIC_KEY;
    delete process.env.APP_SIGNATURE_ENFORCE;
  });

  it('验签通过：签名后未改动', () => {
    signDir(dir);
    expect(service.verifyDirectory(dir).status).toBe('valid');
  });

  it('拒绝：文件被篡改', () => {
    signDir(dir);
    writeFile('dist/index.js', 'console.log("hacked")');
    const result = service.verifyDirectory(dir);
    expect(result.status).toBe('invalid');
    expect(result.detail).toContain('篡改');
  });

  it('拒绝：新增未签名文件', () => {
    signDir(dir);
    writeFile('dist/evil.js', 'malware');
    expect(service.verifyDirectory(dir).status).toBe('invalid');
  });

  it('拒绝：签名清单中的文件被删除', () => {
    signDir(dir);
    fs.rmSync(path.join(dir, 'dist/index.js'));
    expect(service.verifyDirectory(dir).status).toBe('invalid');
  });

  it('拒绝：签名清单被替换（验签失败）', () => {
    signDir(dir);
    const other = generateKeyPairSync('ed25519');
    const files = { 'manifest.json': createHash('sha256').update(fs.readFileSync(path.join(dir, 'manifest.json'))).digest('hex') };
    const canonical = canonicalFn(files);
    const signature = sign(null, Buffer.from(canonical, 'utf-8'), other.privateKey).toString('base64');
    fs.writeFileSync(path.join(dir, 'PACKAGE-SIGNATURE.json'), JSON.stringify({ files, signature }));
    expect(service.verifyDirectory(dir).status).toBe('invalid');
  });

  it('unsigned：无签名文件', () => {
    expect(service.verifyDirectory(dir).status).toBe('unsigned');
  });

  it('check：官方包未签名默认拒绝；APP_SIGNATURE_ENFORCE=off 放行', () => {
    const unsigned = service.verifyDirectory(dir);
    expect(service.check(unsigned, true).ok).toBe(false);
    expect(service.check(unsigned, false).ok).toBe(true); // 第三方未签名仅告警
    process.env.APP_SIGNATURE_ENFORCE = 'off';
    expect(service.check(unsigned, true).ok).toBe(true);
  });

  it('app-license roundtrip：签发→验签→过期判定', async () => {
    // 复刻 website signAppLicense 的 seal 过程（hkdf + aes-256-gcm + ed25519）
    const { hkdfSync, randomBytes, createCipheriv } = require('crypto');
    const STATIC_KEY_IKM = 'jz-license-v2-7f3a9c1e5b48d206e9f1a3c5';
    const aesKey = Buffer.from(hkdfSync('sha256', STATIC_KEY_IKM, 'jianzhi-license-v2', 'aes-key', 32));
    const payload = {
      type: 'app', version: 1, installationId: 'inst-1', appId: 'com.jianzhi.test',
      period: 'monthly', issuedAt: Math.floor(Date.now() / 1000),
      expiresAt: Math.floor(Date.now() / 1000) + 86400,
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
    const encrypted = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    const signature = sign(null, blob, privateKey);
    const licenseStr = Buffer.concat([signature, blob]).toString('base64');

    const appLicense = require('../../../edition/app-license');
    const verified = appLicense.verifyAppLicense(licenseStr, 'inst-1', 'com.jianzhi.test');
    expect(verified.appId).toBe('com.jianzhi.test');
    expect(appLicense.isAppLicenseExpired(verified)).toBe(false);

    // installationId 不符
    expect(() => appLicense.verifyAppLicense(licenseStr, 'inst-2', 'com.jianzhi.test')).toThrow();
    // appId 不符
    expect(() => appLicense.verifyAppLicense(licenseStr, 'inst-1', 'com.jianzhi.other')).toThrow();
    // 过期判定
    expect(appLicense.isAppLicenseExpired({ ...verified, expiresAt: 1 })).toBe(true);
    // 平台 license payload 不能被当作 APP license
    const platformPayload = { version: 2, installationId: 'inst-1', phone: '138', edition: 'community', features: {}, issuedAt: 1, expiresAt: 0 };
    const iv2 = randomBytes(12);
    const cipher2 = createCipheriv('aes-256-gcm', aesKey, iv2);
    const encrypted2 = Buffer.concat([cipher2.update(Buffer.from(JSON.stringify(platformPayload))), cipher2.final()]);
    const blob2 = Buffer.concat([iv2, cipher2.getAuthTag(), encrypted2]);
    const platformLicense = Buffer.concat([sign(null, blob2, privateKey), blob2]).toString('base64');
    expect(() => appLicense.verifyAppLicense(platformLicense, 'inst-1', 'com.jianzhi.test')).toThrow('Not an app license');
  });
});
