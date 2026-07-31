import { bearer, json, route, serve } from '../_shared/http.ts';
import { gt, selectMany } from '../_shared/db.ts';
import { deviceFromMachineToken, getRequest, phoneFromToken } from '../_shared/auth.ts';

/**
 * GET /api/request?id=<uuid>   (Bearer phoneToken | machineToken)
 * GET /api/request?pending=1   (Bearer phoneToken)
 *
 * Two callers, one route:
 *
 *  - the phone, fetching the ciphertext it is about to decrypt and display;
 *  - the hook, when its websocket died and it fell back to polling. That path is
 *    bounded and logged, and it is the only reason this route exists for the
 *    laptop at all.
 *
 * `pending=1` answers "is anything waiting for me right now" — iOS opens the
 * installed PWA at its start_url and drops the notification's target URL, so
 * without this the tap-through path has nothing to show. It enumerates, so it is
 * phone-only: a machineToken gets 403.
 */
export const handler = route(['GET'], async (req) => {
  const token = bearer(req);

  // Try the phone first: it is the common caller and the one allowed to enumerate.
  const phone = await phoneFromToken(token);
  const device = phone
    ? { id: phone.device_id }
    : await deviceFromMachineToken(token);
  if (!device) return json(401, { error: 'unauthorized' });

  const url = new URL(req.url);

  if (url.searchParams.get('pending') === '1') {
    if (!phone) return json(403, { error: 'phone_token_required' });
    const rows = await selectMany(
      'requests',
      {
        device_id: device.id,
        status: 'pending',
        expires_at: gt(new Date().toISOString()),
      },
      { select: 'id', order: ['created_at', { ascending: false }], limit: 1 },
    );
    return json(200, { id: rows[0]?.id ?? null });
  }

  // The phone's home screen shows what it has already answered. Enumerates, so
  // phone-only for the same reason as `pending=1`.
  if (url.searchParams.get('history') === '1') {
    if (!phone) return json(403, { error: 'phone_token_required' });
    const rows = await selectMany(
      'requests',
      { device_id: device.id },
      {
        select: 'id,tool,status,note,created_at,payload_ciphertext',
        order: ['created_at', { ascending: false }],
        limit: 20,
      },
    );
    return json(200, { requests: rows });
  }

  const r = await getRequest(url.searchParams.get('id'), device.id);
  if (!r) return json(404, { error: 'unknown_request' });

  return json(200, {
    id: r.id,
    tool: r.tool,
    status: r.status,
    note: r.note,
    created_at: r.created_at,
    expires_at: r.expires_at,
    // Opaque to us. The phone decrypts it; the hook ignores it.
    payload_ciphertext: r.payload_ciphertext,
    // The other direction, and the other blob we cannot read: which options were
    // picked. Only the polling fallback in the hook reads this — realtime carries
    // the whole row — but without it a dead websocket loses the answer.
    answer_ciphertext: r.answer_ciphertext ?? null,
  });
});

serve(handler);
