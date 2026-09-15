/**
 * Admin key storage with AES-GCM encryption in localStorage.
 * The encryption key is derived from a browser fingerprint (not secrets-grade,
 * but prevents casual localStorage inspection from revealing the admin secret).
 */

const STORAGE_KEY = 'jz_admin_auth';

async function deriveKey(): Promise<CryptoKey> {
  // Browser fingerprint as encryption seed (stable across sessions, unique per browser)
  const seed = [navigator.userAgent, navigator.language, screen.width, screen.height].join('|');
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function saveAdminKey(adminKey: string): Promise<void> {
  try {
    const key = await deriveKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(adminKey));
    const payload = {
      iv: btoa(String.fromCharCode(...iv)),
      data: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Fallback: store as-is if crypto not available
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ plain: adminKey }));
  }
}

export async function loadAdminKey(): Promise<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return '';
    const payload = JSON.parse(stored);

    // Fallback: plain text (legacy or crypto unavailable)
    if (payload.plain) return payload.plain;

    const key = await deriveKey();
    const iv = Uint8Array.from(atob(payload.iv), c => c.charCodeAt(0));
    const data = Uint8Array.from(atob(payload.data), c => c.charCodeAt(0));
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new TextDecoder().decode(decrypted);
  } catch {
    return '';
  }
}

export function clearAdminKey(): void {
  localStorage.removeItem(STORAGE_KEY);
  // Also clear legacy key
  localStorage.removeItem('jz_admin_key');
}

/** Redirect to /admin login on 401 */
export function handle401(): void {
  clearAdminKey();
  window.location.href = '/admin';
}
