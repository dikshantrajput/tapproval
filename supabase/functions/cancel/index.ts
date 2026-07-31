import { bearer, json, readBody, route, serve } from '../_shared/http.ts';
import { RestError, updateWhere } from '../_shared/db.ts';
import { deviceFromMachineToken, getRequest } from '../_shared/auth.ts';

/**
 * POST /api/cancel  (Bearer machineToken)  { id } → { status, cancelled }
 *
 * The laptop withdrawing a question it is no longer listening to: the user
 * answered in the terminal, hit escape, or the hook's wait ran out. Without this
 * the row sits `pending` until its deadline and the notification still opens a
 * live Approve/Deny screen — a tap that decides nothing while looking like it did.
 *
 * machineToken only. The phone answers requests; it does not withdraw them.
 *
 * Conditional on `status = 'pending'`, so it can never overwrite a real verdict —
 * if the phone answered a moment before the hook gave up, that answer stands and
 * the response reports it.
 */
export const handler = route(['POST'], async (req) => {
  const device = await deviceFromMachineToken(bearer(req));
  if (!device) return json(401, { error: 'unauthorized' });

  const b = await readBody(req);
  const id = String(b.id ?? '');

  const [updated] = await updateWhere(
    'requests',
    { id, device_id: device.id, status: 'pending' },
    { status: 'cancelled', decided_at: new Date().toISOString() },
  ).catch((err: unknown) => {
    if (err instanceof RestError && (err.status === 400 || err.code === '22P02')) return [];
    throw err;
  });

  if (updated) {
    console.log(`[cancel] ${updated.id} → cancelled`);
    return json(200, { status: 'cancelled', cancelled: true });
  }

  const current = await getRequest(id, device.id);
  if (!current) return json(404, { error: 'unknown_request' });
  console.log(`[cancel] ${current.id} not cancelled (already ${current.status})`);
  return json(200, { status: current.status, cancelled: false });
});

serve(handler);
