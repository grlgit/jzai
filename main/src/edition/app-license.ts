import { unseal } from './license';

/**
 * APP subscription license (mirror of website's AppLicensePayload).
 * `type:'app'` distinguishes it from platform licenses so neither side
 * accepts cross-usage: platform licenses have no `type` field, and
 * verifyLicense() rejects version !== 2.
 */
export interface AppLicensePayload {
  type: 'app';
  version: 1;
  installationId: string;
  appId: string;
  period: 'monthly' | 'quarterly' | 'yearly';
  issuedAt: number;
  expiresAt: number;  // unix seconds
}

/**
 * Verify and decrypt an APP license string, checking it belongs to this
 * installation and this app.
 *
 * @throws Error if signature/decryption fails, payload is not an app license,
 *         or installationId/appId does not match
 */
export function verifyAppLicense(
  licenseStr: string,
  localInstallationId: string,
  appId: string,
): AppLicensePayload {
  const payload = unseal(licenseStr) as Partial<AppLicensePayload>;

  if (payload.type !== 'app' || payload.version !== 1) {
    throw new Error('Not an app license');
  }
  if (payload.installationId !== localInstallationId) {
    throw new Error('License does not match this installation');
  }
  if (payload.appId !== appId) {
    throw new Error('License does not match this app');
  }

  return payload as AppLicensePayload;
}

/** Check if an APP license payload has expired */
export function isAppLicenseExpired(payload: AppLicensePayload): boolean {
  return Math.floor(Date.now() / 1000) > payload.expiresAt;
}
