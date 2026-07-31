/**
 * Public origin of the PWA, plus best-effort throttling.
 *
 * PUBLIC_BASE_URL matters more here than it did on Vercel: the function's own
 * host is now <project>.supabase.co, which serves no HTML. Every URL inside a
 * push has to point at the Vercel domain, so PUBLIC_BASE_URL is effectively
 * required in hosted mode and the request headers are only a local-dev fallback.
 */

import { env } from './env.ts';
import { gte, insertOne, selectMany } from './db.ts';
import { sha256 } from './auth.ts';

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

/**
 * The caller's address, as far as it can be trusted.
 *
 * `x-forwarded-for` is append-only: each proxy adds what it saw to the END. So the
 * FIRST entry is whatever the client sent, which a client is free to invent — and
 * taking it (as this did) makes every per-IP limit bypassable by rotating a header,
 * no isolate churn required. The last entry is the one our own edge appended and
 * the only one nothing upstream could forge.
 *
 * `cf-connecting-ip` is set by the edge and stripped from client input, so it is
 * preferred where present; XFF's last hop is the fallback.
 *
 * If your deployment sits behind a different proxy chain, verify this before
 * trusting it — log the raw header on one request and count the hops.
 */
export function clientIp(req: Request): string {
  const direct = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-real-ip');
  if (direct?.trim()) return direct.trim();

  const hops = (req.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  return hops[hops.length - 1] ?? 'unknown';
}

/**
 * Durable per-IP limiting for the two routes that have no token to key on.
 *
 * Split into count and record rather than one call, because the two routes count
 * different things. Registration counts every attempt; claiming counts only the
 * attempts that found no live code — a real pairing is already self-limiting,
 * since the code is single-use, and charging for success would punish a phone
 * that pairs, gets cleared, and pairs again.
 *
 * Both are cold paths — once per `setup`, once per pairing — so the extra round
 * trip costs nothing anybody will feel.
 *
 * The address is hashed before it is written, so nothing stored here can be read
 * back into an IP, including by us.
 */
export const REGISTER_PER_DAY = 20;
export const CLAIM_FAILURES_PER_HOUR = 30;
export const DAY_MS = 86_400_000;
export const HOUR_MS = 3_600_000;

/** True when this address has already used up `max` events in the window. */
export async function ipOverLimit(
  req: Request,
  kind: 'register' | 'claim',
  max: number,
  windowMs: number,
): Promise<boolean> {
  const recent = await selectMany(
    'ip_events',
    {
      ip_hash: await sha256(clientIp(req)),
      kind,
      created_at: gte(new Date(Date.now() - windowMs).toISOString()),
    },
    { select: 'id', limit: max },
  );
  return recent.length >= max;
}

/**
 * Records one event.
 *
 * Best-effort on purpose: failing to write the counter must never turn into
 * failing the request the user actually made. The in-memory bucket in front of
 * this is still standing if it does.
 */
export async function ipRecord(req: Request, kind: 'register' | 'claim'): Promise<void> {
  try {
    await insertOne('ip_events', { ip_hash: await sha256(clientIp(req)), kind });
  } catch (err) {
    console.warn('[ip] could not record event:', err instanceof Error ? err.message : err);
  }
}

/**
 * The durable half: how many requests this device has created recently.
 *
 * `throttle` above cannot hold /api/notify, because notify is the one route that
 * spends money on every call — an OneSignal send, a row, an invocation — and an
 * in-memory bucket that resets with the isolate is not a budget. This counts rows
 * in Postgres instead, so it survives isolate churn and a fleet of them.
 *
 * One query, not two. It reads the timestamps of the most recent requests in the
 * hour window and derives both limits from that list, because the minute window is
 * a suffix of the hour window — a second round trip on the hot path would cost
 * more than the check is worth. `limit` is HOUR_MAX + 1: enough to know the hourly
 * cap is reached without ever pulling an unbounded set across the wire.
 *
 * Index-covered by requests_device_history_idx (device_id, created_at desc).
 */
export const NOTIFY_PER_HOUR = 60;
export const NOTIFY_PER_MIN = 10;

export type RateVerdict = { ok: true } | { ok: false; scope: 'hour' | 'minute'; retryAfter: number };

export async function notifyRateLimit(deviceId: string): Promise<RateVerdict> {
  const now = Date.now();
  const hourAgo = new Date(now - 3_600_000).toISOString();

  const rows = await selectMany(
    'requests',
    { device_id: deviceId, created_at: gte(hourAgo) },
    { select: 'created_at', order: ['created_at', { ascending: false }], limit: NOTIFY_PER_HOUR + 1 },
  );

  const times = rows.map((r) => new Date(r.created_at as string).getTime());

  // Oldest row in the window is what has to age out before the next one is
  // allowed, so it gives the caller a real retry-after rather than a guess.
  if (times.length >= NOTIFY_PER_HOUR) {
    const oldest = times[times.length - 1];
    return { ok: false, scope: 'hour', retryAfter: Math.max(1, Math.ceil((oldest + 3_600_000 - now) / 1000)) };
  }

  const minute = times.filter((t) => t > now - 60_000);
  if (minute.length >= NOTIFY_PER_MIN) {
    const oldest = minute[minute.length - 1];
    return { ok: false, scope: 'minute', retryAfter: Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000)) };
  }

  return { ok: true };
}
