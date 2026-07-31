import { bearer, json, readBody, route, serve } from '../_shared/http.ts';
import { insertOne } from '../_shared/db.ts';
import { deviceFromMachineToken } from '../_shared/auth.ts';
import { signRealtimeToken } from '../_shared/jwt.ts';
import { dryRunPush, sendPush } from '../_shared/push.ts';
import { baseUrl, notifyRateLimit } from '../_shared/base.ts';
import { env } from '../_shared/env.ts';

/**
 * Cold boot cannot be timed from inside the isolate — the expensive part
 * (spin-up plus the supabase-js import graph) finishes before this module runs.
 * What we can report is whether a request was the FIRST on its isolate: `n:1`
 * lines carry the cold-start penalty, `n:2+` lines are warm. If the phone-side
 * delay tracks `n:1` you have a cold-start problem; if it happens on warm
 * invocations too, the time is downstream of this function.
 */
let invocations = 0;

/**
 * POST /api/notify  (Bearer machineToken)
 *   { tool, payload_ciphertext, timeout_sec }
 *   → { request_id, expires_at, realtime_token }
 *
 * Insert a row, fire a push, return. Never holds a connection — the hook waits on
 * Supabase Realtime, not on this function.
 *
 * `payload_ciphertext` is opaque here. We do not decrypt it, cannot decrypt it,
 * and never log it.
 */
export const handler = route(['POST'], async (req) => {
  // Stage timings. The question these answer is which of four suspects owns the
  // multi-second tail: cold boot, either DB round trip, or OneSignal. `boot` is
  // the giveaway for a cold isolate — it is ~0 on every warm invocation.
  const t0 = Date.now();
  const mark: Record<string, number> = { n: ++invocations };
  const at = (k: string) => (mark[k] = Date.now() - t0);

  const device = await deviceFromMachineToken(bearer(req));
  at('auth');
  if (!device) return json(401, { error: 'unauthorized' });

  const b = await readBody(req);
  const tool = String(b.tool ?? 'unknown').slice(0, 60);
  const ciphertext = b.payload_ciphertext;
  if (typeof ciphertext !== 'string' || !ciphertext.length) {
    return json(400, { error: 'payload_ciphertext_required' });
  }
  // Postgres would take far more; this is a sanity bound, not a feature.
  if (ciphertext.length > 64_000) return json(413, { error: 'payload_too_large' });

  // The hook always sends its own wait; 300 is the fallback for a client that
  // does not, and matches the shipped default. Clamped either way — `expires_at`
  // has to be something the hook can plausibly still be listening for.
  const timeoutSec = Math.min(Math.max(Number(b.timeout_sec) || 300, 10), 600);
  // Must mirror the hook's own wait exactly. Once past it nobody is listening, so
  // a late tap has to be told "timed out" instead of being counted as a success.
  const expiresAt = new Date(Date.now() + timeoutSec * 1000).toISOString();

  // Durable, per-device, and checked before anything is spent — this is the only
  // route that costs an OneSignal send and a row on every call. A refusal here is
  // safe by the same rule as every other failure: the hook throws, emits no
  // decision, and the prompt falls through to the terminal. It never approves.
  const rate = await notifyRateLimit(device.id);
  at('ratelimit');
  if (!rate.ok) {
    console.warn(`[notify] rate limited ${device.id} (${rate.scope})`);
    return json(429, { error: 'rate_limited', scope: rate.scope, retry_after: rate.retryAfter });
  }

  const row = await insertOne('requests', {
    device_id: device.id,
    tool,
    payload_ciphertext: ciphertext,
    expires_at: expiresAt,
  });
  at('insert');

  const base = baseUrl(req);
  let warning: string | undefined;
  try {
    const out = env('DRY_RUN') === '1'
      ? dryRunPush({ requestId: row.id, tool, base })
      : await sendPush({ deviceId: device.id, requestId: row.id, tool, base, ttlSec: timeoutSec });
    warning = 'warning' in out ? out.warning : undefined;
    at('push');
    if (warning) console.warn('[notify] push warning:', warning);
  } catch (err) {
    at('push_failed');
    console.log('[notify] timings', JSON.stringify(mark));
    // The row exists and the hook may still be answered from an already-open page,
    // so hand back the id — but say the push failed so the hook can log it. A
    // failure here still ends at the terminal prompt, never at "allow".
    console.error('[notify] push failed:', err instanceof Error ? err.message : err);
    return json(502, { error: 'push_failed', request_id: row.id });
  }

  // Read-only, device-scoped, expires with the wait. Lets the hook subscribe to
  // its own row under RLS without ever being handed a database credential.
  const realtimeToken = await signRealtimeToken(device.id, timeoutSec + 60);
  at('sign');

  // Cumulative offsets from the top of the handler, so each stage's own cost is
  // the gap to the previous key. `total` is everything except the cold boot.
  at('total');
  console.log('[notify] timings', JSON.stringify(mark));

  return json(200, {
    request_id: row.id,
    expires_at: expiresAt,
    realtime_token: realtimeToken,
    ...(warning ? { warning } : {}),
  });
});

serve(handler);
