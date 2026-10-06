import { createPublicKey, verify, createDecipheriv, hkdfSync } from 'crypto';

/**
 * License v2: bound to (phone, installationId) pair — no machine fingerprint.
 * installationId is this installation's stable local ID (jz_installation.id),
 * generated once and persisted; website uses the same value as jzw_installations.id.
 */
export interface LicensePayload {
  version: 2;
  installationId: string;
  phone: string;
  edition: 'community' | 'professional';
  features: {
    maxCoWorkers: number;
    cloudModelDirect: boolean;
    modelConfigEditable: boolean;
    customRoles: boolean;
    mcpServers: boolean;
  };
  issuedAt: number;
  expiresAt: number;  // 0 = never expires (community)
}

// Ed25519 public key from website (embedded at build time)
// Replace this when deploying with a new key pair.
// Public key for license verification.
// Override via LICENSE_PUBLIC_KEY env for dev/testing; production key embedded below.
const EMBEDDED_PUBLIC_KEY = process.env.LICENSE_PUBLIC_KEY
  ? process.env.LICENSE_PUBLIC_KEY.includes('BEGIN') ? process.env.LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n')
    : `-----BEGIN PUBLIC KEY-----\n${process.env.LICENSE_PUBLIC_KEY}\n-----END PUBLIC KEY-----`
  : `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEATM347xGq83SgtIIem7FbBYhvlp5ZpCvsfa5xEh4CwtI=
-----END PUBLIC KEY-----`;

const HKDF_SALT = 'jianzhi-license-v2';

// Static AES key input material — must match website (LICENSE_STATIC_KEY).
// Integrity is guaranteed by the Ed25519 signature; AES only obfuscates contents.
const STATIC_KEY_IKM = process.env.LICENSE_STATIC_KEY || 'jz-license-v2-7f3a9c1e5b48d206e9f1a3c5';

function deriveKey(): Buffer {
  return Buffer.from(hkdfSync('sha256', STATIC_KEY_IKM, HKDF_SALT, 'aes-key', 32));
}

/**
 * Verify signature and decrypt a sealed payload.
 * Format: base64( signature(64) + iv(12) + authTag(16) + ciphertext )
 *
 * @throws Error if signature invalid or decryption fails
 */
export function unseal(sealed: string): unknown {
  const combined = Buffer.from(sealed, 'base64');
  if (combined.length < 64 + 12 + 16 + 1) {
    throw new Error('License too short');
  }

  // Split: signature(64) + blob(iv + authTag + ciphertext)
  const signature = combined.subarray(0, 64);
  const blob = combined.subarray(64);

  // Verify Ed25519 signature
  const pubKey = createPublicKey(EMBEDDED_PUBLIC_KEY);
  if (!verify(null, blob, pubKey, signature)) {
    throw new Error('License signature verification failed');
  }

  // Decrypt: iv(12) + authTag(16) + ciphertext
  const iv = blob.subarray(0, 12);
  const authTag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);

  const aesKey = deriveKey();
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('License decryption failed (legacy v1 license?)');
  }

  return JSON.parse(plaintext.toString('utf-8'));
}

/**
 * Verify and decrypt a platform license string.
 *
 * @throws Error if signature invalid, decryption fails, license is a legacy v1
 *         license, or installationId does not match this installation
 */
export function verifyLicense(licenseStr: string, localInstallationId: string): LicensePayload {
  const payload = unseal(licenseStr) as LicensePayload;

  // v1 licenses (fingerprint-bound) are no longer accepted — trigger re-registration
  if (payload.version !== 2) {
    throw new Error('Legacy license format — re-registration required');
  }

  // Verify the license belongs to this installation
  if (payload.installationId !== localInstallationId) {
    throw new Error('License does not match this installation');
  }

  return payload;
}

/** Check if a license payload has expired */
export function isLicenseExpired(payload: LicensePayload): boolean {
  if (payload.expiresAt === 0) return false; // never expires (community)
  return Math.floor(Date.now() / 1000) > payload.expiresAt;
}

/** Default community features (fallback when no valid license) */
export const DEFAULT_COMMUNITY_FEATURES: LicensePayload['features'] = {
  maxCoWorkers: 3,
  cloudModelDirect: true,
  modelConfigEditable: true,
  customRoles: false,
  mcpServers: false,
};
