import { json, readBody, route, serve } from '../_shared/http.ts';
import { insertOne } from '../_shared/db.ts';
import { newToken, sha256 } from '../_shared/auth.ts';
import { clientIp, throttle } from '../_shared/base.ts';
import { env } from '../_shared/env.ts';

/**
 * POST /api/devices — register a laptop. Unauthenticated by design: this is what
 * makes `npx agent-approvals setup` promptless, with no account and no email.
 *
 * The device is worthless until a phone claims a pair code, so the worst an abuser
 * gets is a row. The returned `machineToken` is shown exactly once — we keep only
 * its hash and cannot recover it, for the user or for ourselves.
 */
export const handler = route(['POST'], async (req) => {
  if (!throttle(`reg:${clientIp(req)}`, 5, 60_000)) {
    return json(429, { error: 'rate_limited' });
  }

  const { label } = await readBody(req);
  const machineToken = newToken();

  const device = await insertOne('devices', {
    machine_token_hash: await sha256(machineToken),
    label: typeof label === 'string' ? label.slice(0, 80) : null,
  });

  return json(200, {
    device_id: device.id,
    machine_token: machineToken,
    // The hook needs these for its Realtime subscription. The anon key is public
    // by design — RLS plus the device-scoped JWT are what protect the rows.
    // Both are injected into every Edge Function; nothing to configure.
    supabase_url: env('SUPABASE_URL'),
    supabase_anon_key: env('SUPABASE_ANON_KEY'),
  });
});

serve(handler);
