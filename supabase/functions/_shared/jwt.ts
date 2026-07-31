/**
 * Mints the short-lived JWT the hook hands to Supabase Realtime.
 *
 * This is what makes the RLS policy on `requests` mean something: the hook
 * connects as `authenticated` with a `device_id` claim, and Postgres itself
 * refuses to stream another tenant's rows. Without it we would have to open
 * `requests` to anon and leak tool names and device ids to anyone holding the
 * (public) anon key. If this breaks, every approval silently degrades to the
 * hook's bounded polling fallback — hence the test that decodes the claims.
 *
 * Lifetime is the hook's wait plus a small margin — long enough to cover the
 * subscription, short enough to be uninteresting if it leaks. It grants read on
 * one device's rows and nothing else; it cannot decide anything.
 *
 * HS256 over SUPABASE_JWT_SECRET, via Web Crypto rather than node:crypto.
 */

import { jwtSecret } from './env.ts';
import { b64url } from './auth.ts';

const enc = new TextEncoder();
const b64json = (o: unknown) => b64url(enc.encode(JSON.stringify(o)));

export async function signRealtimeToken(deviceId: string, ttlSec: number): Promise<string> {
  const secret = jwtSecret();
  if (!secret) throw new Error('AAP_JWT_SECRET / SUPABASE_JWT_SECRET not set');

  const now = Math.floor(Date.now() / 1000);
  const head = b64json({ alg: 'HS256', typ: 'JWT' });
  const body = b64json({
    role: 'authenticated',
    sub: deviceId,
    device_id: deviceId,
    iat: now,
    exp: now + Math.min(Math.max(ttlSec, 60), 900),
  });

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}
