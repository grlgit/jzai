import { createPublicKey, verify, createDecipheriv, hkdfSync } from 'crypto';

export interface LicensePayload {
  fingerprint: string;
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

const HKDF_SALT = 'jianzhi-license-v1';

function deriveKey(fingerprint: string): Buffer {
  return Buffer.from(hkdfSync('sha256', fingerprint, HKDF_SALT, 'aes-key', 32));
}

/**
 * Verify and decrypt a license string.
 * Format: base64( signature(64) + iv(12) + authTag(16) + ciphertext )
 *
 * @throws Error if signature invalid, decryption fails, or fingerprint mismatch
 */
export function verifyLicense(licenseStr: string, localFingerprint: string): LicensePayload {
  const combined = Buffer.from(licenseStr, 'base64');
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

  const aesKey = deriveKey(localFingerprint);
  const decipher = createDecipheriv('aes-256-gcm', aesKey, iv);
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('License decryption failed (machine fingerprint mismatch?)');
  }

  const payload: LicensePayload = JSON.parse(plaintext.toString('utf-8'));

  // Verify fingerprint matches
  if (payload.fingerprint !== localFingerprint) {
    throw new Error('License fingerprint does not match this machine');
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
  cloudModelDirect: false,
  modelConfigEditable: false,
  customRoles: false,
  mcpServers: false,
};
