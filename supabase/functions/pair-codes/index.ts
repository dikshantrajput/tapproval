import { bearer, json, readBody, route, serve } from '../_shared/http.ts';
import { gte, insertOne, RestError, selectMany } from '../_shared/db.ts';
import { deviceFromMachineToken, randomIndex } from '../_shared/auth.ts';

/**
 * POST /api/pair-codes  (Bearer machineToken) → { code, ttl }
 *
 * The QR carries `https://<domain>/p/<code>` — six characters, single use, two
 * minutes. Screenshotting it is harmless once it is claimed or expired, which is
 * the whole point: the old QR embedded a permanent full-access secret. The
 * machineToken never appears in the QR, the code, or a log line.
 */

// Crockford-style: uppercase alphanumerics minus 0/O/1/I/L, so nothing here is
// ambiguous when read off a screen. 31 symbols, six of them ≈ 29.7 bits — against
// a 120-second window and the per-device rate limit below, guessing is not the
// weak link.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const TTL_SEC = 120;

const makeCode = () =>
  Array.from({ length: 6 }, () => ALPHABET[randomIndex(ALPHABET.length)]).join('');

export const handler = route(['POST'], async (req) => {
  const device = await deviceFromMachineToken(bearer(req));
  if (!device) return json(401, { error: 'unauthorized' });

  const { payload_key: payloadKey } = await readBody(req);
  // The key is generated on the laptop. If one is missing the phone would end up
  // unable to read anything, so refuse rather than pair something broken.
  if (typeof payloadKey !== 'string' || payloadKey.length < 40) {
    return json(400, { error: 'payload_key_required' });
  }

  // Durable, per-device: 10 codes a minute. Enough for a retried scan, not
  // enough to make guessing the live code space worthwhile.
  const recent = await selectMany(
    'pair_codes',
    {
      device_id: device.id,
      created_at: gte(new Date(Date.now() - 60_000).toISOString()),
    },
    { select: 'code' },
  );
  if (recent.length >= 10) return json(429, { error: 'rate_limited' });

  const expiresAt = new Date(Date.now() + TTL_SEC * 1000).toISOString();

  // Retry on the vanishingly unlikely collision with a live code.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = makeCode();
    try {
      await insertOne('pair_codes', {
        code,
        device_id: device.id,
        payload_key: payloadKey,
        expires_at: expiresAt,
      });
      return json(200, { code, ttl: TTL_SEC });
    } catch (err) {
      // 409 / 23505 unique_violation: this code is already live. Try another.
      if (!(err instanceof RestError) || (err.status !== 409 && err.code !== '23505')) throw err;
    }
  }
  return json(503, { error: 'could_not_allocate_code' });
});

serve(handler);
