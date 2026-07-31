#!/usr/bin/env node
/**
 * Claude Code PostToolUse / Stop / SessionEnd hook — the other half of the story.
 *
 * The permission hook can only record what the phone did. Everything else —
 * every prompt you answered at the keyboard because you were sitting at it —
 * ended as `cancelled`: "your machine stopped waiting", with no verdict attached.
 * That is the common case, so most of the history was blank.
 *
 * This hook fills it in, after the fact, from two sources that are both facts
 * rather than guesses:
 *
 *   PostToolUse   the tool ran. Nothing runs without permission, so the terminal
 *                 prompt was approved — and for AskUserQuestion the response
 *                 carries the selection that was made.
 *   Stop /        the transcript is on disk by now. A refused call has a
 *   SessionEnd    tool_result saying so, in the user's own turn, verbatim from
 *                 Claude Code. That is a deny we can report without inferring it.
 *
 * What it will not do is invent the third case. A prompt that was interrupted, or
 * abandoned when the session ended, has no decision to record — those rows stay
 * `cancelled`, which is exactly what happened to them.
 *
 * Writes nothing to stdout: none of these events take a decision from a hook, and
 * a stray byte on a hook's stdout is how you lose one. Failures are logged to
 * stderr and swallowed — a missing history entry must never break a session.
 */
const log = (...a) => process.stderr.write(`[reconcile-hook] ${a.join(' ')}\n`);

const QUESTION_TOOL = 'AskUserQuestion';

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------- transcripts */

/**
 * What the terminal did lives in lib/transcript.mjs, shared with the permission
 * hook — which asks the same file the opposite question before it notifies ("has
 * this already been answered here?"). One reader, so the two cannot disagree about
 * what a refusal looks like.
 */

/* ---------------------------------------------------------------- answers */

/**
 * Pull the selection out of an AskUserQuestion response.
 *
 * Shape has moved around across versions, so this accepts the ones seen rather
 * than one — and if none of them fit, the row is still recorded as answered, just
 * without the detail. "Answered at the keyboard, content unknown" is true and
 * useful; a fabricated selection would not be either.
 */
function answersFrom(response) {
  const out = {};
  const take = (q, a) => {
    const question = String(q ?? '').trim();
    const answer = Array.isArray(a) ? a.map(String).join(', ') : String(a ?? '').trim();
    if (question && answer) out[question] = answer;
  };

  const raw = typeof response === 'string' ? tryJson(response) : response;
  const list = Array.isArray(raw?.answers) ? raw.answers
    : Array.isArray(raw) ? raw
    : null;

  if (list) {
    for (const a of list) take(a?.question ?? a?.header, a?.answer ?? a?.selected ?? a?.choice);
  } else if (raw?.answers && typeof raw.answers === 'object') {
    for (const [q, a] of Object.entries(raw.answers)) take(q, a);
  }
  return out;
}

const tryJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ---------------------------------------------------------------- reporting */

/**
 * Tell the server what was decided here.
 *
 * machineToken, not a phone token: this is the laptop reporting its own history.
 * The server refuses to overwrite a verdict that came from a phone, so a tap that
 * landed a moment before the fall-through always wins.
 *
 * A selection travels under the same envelope as everything else — encrypted on
 * this machine, before the request leaves it. The server stores a blob it cannot
 * read, exactly as it does for an answer that came from the phone.
 */
async function report(cfg, trace, { outcome, note, answers }) {
  const base = cfg.mode === 'hosted' ? cfg.apiBase : cfg.url;
  const body = { id: trace.requestId, outcome, note };

  if (outcome === 'answer') {
    if (cfg.mode === 'hosted') {
      const { encryptPayload } = await import('../lib/crypto.mjs');
      body.answer_ciphertext = encryptPayload(cfg.payloadKey, { answers: answers ?? {} });
    } else {
      // Self-hosted keeps everything on this machine, so there is no envelope.
      body.answers = answers ?? {};
    }
  }

  const res = await fetch(`${base}/api/local-decide`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cfg.machineToken ? { authorization: `Bearer ${cfg.machineToken}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? `HTTP ${res.status}`);
  return out;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch { return log('unparseable stdin'); }

  const { fingerprint, list, drop } = await import('../lib/local-trace.mjs');
  const { outcomeFor } = await import('../lib/transcript.mjs');

  const sessionId = event.session_id ?? '';
  const traces = list(sessionId);
  // The overwhelmingly common case: the phone answered, or nothing fell through.
  // Costs one readdir of an empty directory and stops here.
  if (!traces.length) return;

  const { loadHookConfig } = await import('../lib/hook-config.mjs');
  const cfg = loadHookConfig();
  if (!(cfg.mode === 'hosted' ? cfg.apiBase && cfg.machineToken : cfg.url)) {
    return log('not configured — leaving traces for a later run');
  }

  const eventName = event.hook_event_name ?? '';
  const settle = async (trace, decision) => {
    try {
      const out = await report(cfg, trace, decision);
      log(`${trace.requestId} → ${out.status}${out.applied ? '' : ' (not applied)'}`);
      // Applied or not, the answer is in: applied means we recorded it, and not
      // applied means the phone got there first. Either way it is settled, and a
      // trace left behind would be re-reported on the next Stop.
      drop(trace);
    } catch (err) {
      // Keep the trace. Stop fires again, and the sweep in `list` eventually
      // clears it if the network never comes back.
      log(`could not report ${trace.requestId}: ${err.message}`);
    }
  };

  if (eventName === 'PostToolUse') {
    // The tool ran, so its prompt was approved. Match by fingerprint: two Bash
    // calls in one session are not the same call, and a loop makes that common.
    const fp = fingerprint(event.tool_name, event.tool_input);
    const trace = traces.find((t) => t.fp === fp);
    if (!trace) return;

    if (event.tool_name === QUESTION_TOOL) {
      const answers = answersFrom(event.tool_response);
      log(`${trace.requestId}: answered in the terminal (${Object.keys(answers).length} question(s) read)`);
      return settle(trace, { outcome: 'answer', note: 'Answered in the terminal', answers });
    }
    return settle(trace, { outcome: 'allow', note: 'Approved in the terminal' });
  }

  // Stop / SessionEnd: whatever PostToolUse could not tell us. A denied call never
  // reaches PostToolUse at all, so this is the only place it can be picked up.
  const transcript = event.transcript_path ?? '';
  for (const trace of traces) {
    let decision = transcript
      ? outcomeFor(transcript, trace, fingerprint)
      : null;

    // A question that completed was answered, not approved. The transcript can
    // only tell us the call succeeded — the selection itself lives in the tool
    // response, which is PostToolUse's to read and is gone by now. So it is
    // recorded as answered with nothing attached: true, and better than filing a
    // verdict against a prompt that never asked for one.
    if (decision?.outcome === 'allow' && trace.tool === QUESTION_TOOL) {
      decision = { outcome: 'answer', note: 'Answered in the terminal', answers: {} };
    }

    if (decision) {
      await settle(trace, decision);
    } else if (eventName === 'SessionEnd') {
      // The session is over and the transcript never said. Nothing more will ever
      // arrive for this row, so stop carrying it — it stays `cancelled`, which is
      // the truth: we stopped waiting and never found out.
      log(`${trace.requestId}: no outcome in the transcript — leaving it withdrawn`);
      drop(trace);
    }
  }
}

main().catch((err) => log(`fatal: ${err.stack}`));
