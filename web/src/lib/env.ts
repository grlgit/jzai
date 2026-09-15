/**
 * Get the main platform API base URL.
 *
 * Browser: returns '' (empty) — all fetch('/api/...') use relative paths,
 * proxied by Next.js rewrites to the backend.
 *
 * SSR: returns the actual backend URL for server-side API calls.
 */
export function getMainUrl(): string {
  if (typeof window !== 'undefined') return '';
  return process.env.MAIN_BACKEND_URL || 'http://localhost:1111';
}

/**
 * Get the KB API base URL for direct access (TUS upload, file download).
 *
 * Browser: returns '/kb-api' (proxied by Next.js rewrites).
 * SSR: returns the actual KB URL.
 */
export function getKbDirectUrl(): string {
  if (typeof window !== 'undefined') return '/kb-api';
  return process.env.KB_API_URL || 'http://localhost:8000';
}
