import { bearer, json, readBody, route, serve } from '../_shared/http.ts';
import { inList, RestError, updateWhere } from '../_shared/db.ts';
import { deviceFromMachineToken, getRequest } from '../_shared/auth.ts';

/**
 * POST /api/local-decide  (Bearer machineToken)
 *   { id, outcome: 'allow' | 'deny' }                        → { status, applied }
 *   { id, outcome: 'answer', answer_ciphertext }             → { status, applied }
 *
 * The laptop recording a decision that was made on the laptop.
 *
 * Most prompts are answered at the keyboard, not on the phone — you were sitting
 * there, so you pressed a key. Those rows used to end as `cancelled`: "your
 * machine stopped waiting", carrying no verdict, which left the history mostly
 * empty exactly where the common case lives. The reconcile hook now watches what
 * the terminal actually did and reports it here.
 *
 * `local_*` rather than reusing `allow`/`deny`/`answer`, because where a decision
 * was made is the thing the history exists to record and the two are not
 * interchangeable. `decided_by` cannot express it either — it references `phones`,
 * and there was no phone involved.
 *
 * machineToken only. A phone reports what a phone did, through /api/decide.
 *
 * The write is conditional on the row NOT already carrying a phone verdict. So a
 * tap that landed a second before the prompt fell through to the terminal always
 * wins, and this route can never overwrite it — it reports back what the database
 * actually holds instead.
 */

/** What a laptop-side outcome is stored as. */
const STATUS = {
  allow: 'local_allow',
  deny: 'local_deny',
  answer: 'local_answer',
} as const;

/**
 * The statuses this may overwrite.
 *
 * `cancelled` is the expected one — the hook withdrew the request on its way out.
 * `expired` and `pending` are the races around it: the sweeper may have got there
 * first, or the cancel may never have arrived. All three mean "nobody on a phone
 * has decided this", which is the only precondition that matters.
 *
 * Notably absent: allow, deny, answer, and the three `local_*`. A settled row is
 * settled, and re-reporting must be a no-op rather than a last-writer-wins race —
 * PostToolUse and Stop can both fire for the same trace.
 */
const OVERWRITABLE = ['pending', 'cancelled', 'expired'] as const;

export const handler = route(['POST'], async (req) => {
  const device = await deviceFromMachineToken(bearer(req));
  if (!device) return json(401, { error: 'unauthorized' });

  const b = await readBody(req);
  const id = String(b.id ?? '');

  const outcome = String(b.outcome ?? '') as keyof typeof STATUS;
  const status = STATUS[outcome];
  if (!status) return json(400, { error: 'bad_outcome' });

  // A selection made in the terminal travels the same way one made on the phone
  // does: sealed with the device's payload key, opaque here. The check constraint
  // on `requests` requires it for an answer status and forbids it for every other
  // one, so a malformed report is rejected by the database rather than stored.
  const answerCiphertext = typeof b.answer_ciphertext === 'string' ? b.answer_ciphertext : '';
  if (outcome === 'answer') {
    if (!answerCiphertext) return json(400, { error: 'answer_ciphertext_required' });
    if (answerCiphertext.length > 64_000) return json(413, { error: 'answer_too_large' });
  }

  const note = typeof b.note === 'string' && b.note.trim()
    ? b.note.trim().slice(0, 500)
    : null;

  const [updated] = await updateWhere(
    'requests',
    {
      id,
      // Scopes the write to this device. Another tenant's machineToken matches
      // nothing here even holding a valid request id.
      device_id: device.id,
      status: inList(OVERWRITABLE),
    },
    {
      status,
      note,
      decided_on: 'terminal',
      // Deliberately left alone: `decided_by` references a phone, and there is
      // none. Null there plus `decided_on = 'terminal'` is the whole story.
      ...(outcome === 'answer' ? { answer_ciphertext: answerCiphertext } : {}),
      decided_at: new Date().toISOString(),
    },
  ).catch((err: unknown) => {
    // Malformed id (22P02 invalid_text_representation) — same answer as "not ours".
    if (err instanceof RestError && (err.status === 400 || err.code === '22P02')) return [];
    throw err;
  });

  if (updated) {
    console.log(`[local-decide] ${updated.id} → ${updated.status}`);
    return json(200, { status: updated.status, applied: true });
  }

  // Already settled, or never ours. Report the truth if we may see it — the hook
  // logs this, and "not applied" there means a phone got there first.
  const current = await getRequest(id, device.id);
  if (!current) return json(404, { error: 'unknown_request' });
  console.log(`[local-decide] ${current.id} not applied (already ${current.status})`);
  return json(200, {
    status: current.status,
    // Same outcome twice is a success, not a conflict: PostToolUse and Stop can
    // both report the same tool call, and a retry after a failed report is normal.
    applied: current.status === status,
  });
});

serve(handler);
