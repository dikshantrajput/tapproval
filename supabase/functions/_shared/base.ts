/**
 * Public origin of the PWA, plus best-effort throttling.
 *
 * PUBLIC_BASE_URL matters more here than it did on Vercel: the function's own
 * host is now <project>.supabase.co, which serves no HTML. Every URL inside a
 * push has to point at the Vercel domain, so PUBLIC_BASE_URL is effectively
 * required in hosted mode and the request headers are only a local-dev fallback.
 */

import { env } from './env.ts';

export function baseUrl(req: Request): string {
  const configured = env('PUBLIC_BASE_URL');
  if (configured) return configured.replace(/\/$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  return host ? `${proto}://${host}` : new URL(req.url).origin;
}

/**
 * Best-effort rate limiting. An Edge Function instance is short-lived and there
 * are several of them, so this thins abuse rather than stopping it — the real
 * limits are the per-device DB checks and the fact that nothing here is worth
 * stealing without a token. Keep the durable limits in Postgres.
 */
const buckets = new Map<string, number[]>();
export function throttle(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) return false;
  hits.push(now);
  buckets.set(key, hits);
  if (buckets.size > 5000) buckets.clear();
  return true;
}

export const clientIp = (req: Request): string =>
  (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
