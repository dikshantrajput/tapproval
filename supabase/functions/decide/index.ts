import { bearer, json, readBody, route, serve } from '../_shared/http.ts';
import { gt, RestError, updateWhere } from '../_shared/db.ts';
import { getRequest, phoneFromToken } from '../_shared/auth.ts';

/**
 * POST /api/decide  (Bearer phoneToken)
 *   { id, verdict, note }                          → { status, applied }
 *   { id, verdict: 'answer', answer_ciphertext }   → { status, applied }
 *
 * The write is a single conditional UPDATE: still pending, not yet expired, and
 * belonging to this phone's device. So two phones tapping at once produce one
 * winner, and a tap that lands a second after expiry cannot flip a row the hook
 * has already stopped listening to.
 *
 * `status` in the response is what the database holds, not what the caller asked
 * for. The phone renders that, so a late tap reads "Timed out" rather than a
 * cheerful lie.
 */
export const handler = route(['POST'], async (req) => {
  const phone = await phoneFromToken(bearer(req));
  if (!phone) return json(401, { error: 'unauthorized' });

  const b = await readBody(req);

  // `answer` settles an AskUserQuestion request: the phone sends which options were
  // picked, sealed with the device's payload key. Opaque here, exactly like the
  // request payload — we store it and forward it, and cannot read either.
  const answering = b.verdict === 'answer';
  const answerCiphertext = typeof b.answer_ciphertext === 'string' ? b.answer_ciphertext : '';
  if (answering) {
    if (!answerCiphertext) return json(400, { error: 'answer_ciphertext_required' });
    if (answerCiphertext.length > 64_000) return json(413, { error: 'answer_too_large' });
  }

  const verdict = answering ? 'answer' : b.verdict === 'allow' ? 'allow' : 'deny';
  const note = typeof b.note === 'string' && b.note.trim()
    ? b.note.trim().slice(0, 500)
    : null;

  const [updated] = await updateWhere(
    'requests',
    {
      id: String(b.id ?? ''),
      // Scopes the write to this phone's own device. A second tenant's phoneToken
      // matches nothing here even with a valid request id.
      device_id: phone.device_id,
      status: 'pending',
      expires_at: gt(new Date().toISOString()),
    },
    {
      status: verdict,
      note,
      ...(answering ? { answer_ciphertext: answerCiphertext } : {}),
      decided_at: new Date().toISOString(),
      decided_by: phone.id,
      // Where, not just what. The counterpart is /api/local-decide, which records
      // the prompts answered at the keyboard and stamps 'terminal'.
      decided_on: 'phone',
    },
  ).catch((err: unknown) => {
    // Malformed id (22P02 invalid_text_representation) — same answer as "not ours".
    if (err instanceof RestError && (err.status === 400 || err.code === '22P02')) return [];
    throw err;
  });

  if (updated) {
    console.log(`[decide${b.source === 'sw' ? ':sw' : ''}] ${updated.id} → ${updated.status}`);
    return json(200, { status: updated.status, applied: true });
  }

  // Lost the race, expired, or never ours. Report the truth if we may see it.
  const current = await getRequest(b.id, phone.device_id);
  if (!current) return json(404, { error: 'unknown_request' });
  console.log(`[decide] ${current.id} rejected (already ${current.status})`);
  return json(200, {
    status: current.status,
    // Same verdict twice is a success, not a conflict: the service worker and the
    // tapped-through page routinely both land on the same answer.
    applied: current.status === verdict,
  });
});

serve(handler);
