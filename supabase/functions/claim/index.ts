import { json, readBody, route, serve } from '../_shared/http.ts';
import { gt, insertOne, isNull, updateWhere } from '../_shared/db.ts';
import { newToken, sha256 } from '../_shared/auth.ts';
import { clientIp, throttle } from '../_shared/base.ts';
import { env } from '../_shared/env.ts';

/**
 * POST /api/claim { code } → { device_id, phone_id, phone_token, payload_key,
 *                              onesignal_app_id }
 *
 * Trades a pair code for this phone's own credentials. Single use: the claim is a
 * conditional UPDATE, so two phones racing the same code produce exactly one
 * winner and the loser gets 410.
 *
 * This is the only response in the system that contains `payload_key`, and it is
 * the last moment the server can read it — the row is wiped in the same request.
 */
export const handler = route(['POST'], async (req) => {
  if (!throttle(`claim:${clientIp(req)}`, 20, 60_000)) {
    return json(429, { error: 'rate_limited' });
  }

  const body = await readBody(req);
  const code = String(body.code ?? '').trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) return json(400, { error: 'bad_code' });

  // Claim and validate in one statement: unclaimed AND unexpired, or nothing.
  const [claimed] = await updateWhere(
    'pair_codes',
    {
      code,
      claimed_at: isNull,
      expires_at: gt(new Date().toISOString()),
    },
    { claimed_at: new Date().toISOString() },
  );
  if (!claimed) return json(410, { error: 'code_expired_or_used' });

  const phoneToken = newToken();
  const phone = await insertOne('phones', {
    device_id: claimed.device_id,
    phone_token_hash: await sha256(phoneToken),
    user_agent: String(req.headers.get('user-agent') ?? '').slice(0, 200),
  });

  // Hand the key over, then forget it. From here on the ciphertext in `requests`
  // is unreadable by this server, by us, and by anyone who dumps the database.
  await updateWhere('pair_codes', { code }, { payload_key: null });

  return json(200, {
    device_id: claimed.device_id,
    phone_id: phone.id,
    phone_token: phoneToken,
    payload_key: claimed.payload_key,
    onesignal_app_id: env('ONESIGNAL_APP_ID'),
  });
});

serve(handler);
