#!/usr/bin/env node
/**
 * Claude Code PermissionRequest hook.
 *
 * stdin  : the hook event JSON from Claude Code
 * stdout : ONLY the decision JSON — anything else silently voids the decision
 * stderr : logs (safe, shown to the user on non-zero exit)
 *
 * Fails to "ask" on every error path. A hook that fails open would silently
 * grant permissions when the network is down.
 *
 * Two modes, one contract:
 *   hosted      encrypt → POST /api/notify → Supabase Realtime → decision
 *   self-hosted POST /api/notify → long-poll /api/wait/:id → decision
 */
const log = (...a) => process.stderr.write(`[approval-hook] ${a.join(' ')}\n`);

// stdout belongs to the decision and nothing else. A stray byte from any
// dependency — a deprecation notice, a debug line from the Realtime client —
// voids the decision silently, which is the hardest failure here to diagnose.
// Nail the console to stderr before importing anything that might print.
console.log = console.info = console.debug = console.warn =
  (...a) => process.stderr.write(a.map(String).join(' ') + '\n');
console.error = (...a) => process.stderr.write(a.map(String).join(' ') + '\n');

// Loaded lazily in main(), after the console has been nailed to stderr above —
// nothing this hook imports may print to stdout before then.
let CONFIG_PATH = '~/.claude/tapproval.json';

/**
 * Should this prompt reach the phone at all?
 *
 * Everything reaching the phone is right when you are away from the machine and
 * spam when you are sitting at it, so there is a way to narrow it: `muted` for all
 * of them, `onlyTools` for a shortlist, `skipTools` for the noisy few. A filtered
 * prompt makes no row, no push and no network call — it lands in the terminal, the
 * same place every other non-answer lands, so nothing is lost by being quiet.
 *
 * `onlyTools` wins when set: an explicit shortlist is a stronger statement than a
 * blocklist, and honouring both at once would make an empty intersection silently
 * mute everything.
 */
function wantsNotify(cfg, toolName) {
  if (cfg.muted) return 'muted';
  if (cfg.onlyTools.length) {
    return cfg.onlyTools.includes(toolName) ? null : `${toolName} is not in onlyTools`;
  }
  if (cfg.skipTools.includes(toolName)) return `${toolName} is in skipTools`;
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

/* ------------------------------------------------------------- questions */

/**
 * AskUserQuestion is not a permission — it is a choice.
 *
 * Claude hands us a set of questions and their options, and what it wants back is
 * a selection, not allow/deny. The phone renders the options as buttons and the
 * answer comes home as `answers`, which we graft onto the tool input so the tool
 * returns the user's picks. Nothing else about the flow changes: the same row, the
 * same push, the same wait, the same fall-through to the terminal.
 *
 * Everything is clamped and re-validated on the way back in — a selected label
 * that is not one of the offered options is dropped, never forwarded.
 */
const QUESTION_TOOL = 'AskUserQuestion';

function normaliseQuestions(input = {}) {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  return qs.slice(0, 4).map((q) => ({
    question: String(q?.question ?? ''),
    header: String(q?.header ?? '').slice(0, 24),
    multiSelect: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : [])
      .slice(0, 8)
      .map((o) => ({
        label: String(o?.label ?? ''),
        description: String(o?.description ?? '').slice(0, 300),
      }))
      .filter((o) => o.label),
  })).filter((q) => q.question && q.options.length);
}

/** What the phone shows before it has the full payload. */
const questionDetail = (questions) => questions
  .map((q) => [
    q.question,
    ...q.options.map((o) => `  • ${o.label}${o.description ? ` — ${o.description}` : ''}`),
  ].join('\n'))
  .join('\n\n');

/**
 * Turn the phone's selection into the tool's own `answers` shape.
 *
 * Wire format is index-keyed (`{"0": ["Ship it"]}`) so the answer does not have to
 * carry the question text back over the network; we already hold it. Labels are
 * checked against the offered options — anything else is dropped, so a tampered
 * or stale answer cannot inject text into the tool result.
 */
function toolAnswers(questions, picked = {}) {
  const out = {};
  questions.forEach((q, i) => {
    const raw = picked[String(i)] ?? picked[i];
    const labels = (Array.isArray(raw) ? raw : raw ? [raw] : [])
      .map(String)
      .filter((l) => q.options.some((o) => o.label === l));
    if (!labels.length) return;
    out[q.question] = q.multiSelect ? labels.join(', ') : labels[0];
  });
  return out;
}

/** Human-readable one-liner + full detail for the phone. */
function describe(toolName, input = {}) {
  if (toolName === QUESTION_TOOL) {
    const questions = normaliseQuestions(input);
    if (questions.length) {
      return {
        questions,
        summary: questions[0].question,
        detail: questionDetail(questions).slice(0, 4000),
      };
    }
    // Malformed — fall through to the generic dump and plain allow/deny.
  }

  switch (toolName) {
    case 'Bash':
      // Body shows the command, not the description — you approve on what
      // actually runs. iOS may show only this line before the tap-through.
      return {
        summary: input.command || input.description || '',
        detail: input.description
          ? `${input.command}\n\n# ${input.description}`
          : (input.command || ''),
      };
    case 'Write':
      return { summary: `Write ${input.file_path ?? ''}`, detail: (input.content ?? '').slice(0, 2000) };
    case 'Edit':
      return {
        summary: `Edit ${input.file_path ?? ''}`,
        detail: `- ${input.old_string ?? ''}\n+ ${input.new_string ?? ''}`.slice(0, 2000),
      };
    default: {
      const detail = JSON.stringify(input, null, 2).slice(0, 2000);
      return { summary: toolName, detail };
    }
  }
}

/**
 * Writes the decision, waits for the pipe to actually drain, then exits.
 *
 * Two reasons this is not a bare `write`. A truncated write is a voided decision,
 * and `process.exit` does not wait for a pipe. And the Realtime client keeps
 * handles alive, so without an explicit exit the hook can outlive its answer —
 * which the agent resolves by killing it, losing the decision.
 */
function flushAndExit(text) {
  process.stdout.write(text, () => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

/**
 * Shape the reply the way the firing event expects.
 *
 * `updatedInput` is how an answered question comes back: allow the tool, but with
 * the user's selection already filled in, so AskUserQuestion returns the picks
 * instead of prompting again in the terminal.
 */
function emit(eventName, verdict, reason, updatedInput) {
  const out = eventName === 'PreToolUse'
    ? {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: verdict,                     // allow | deny | ask
          permissionDecisionReason: reason,
          ...(updatedInput ? { updatedInput } : {}),
        },
      }
    : {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          // PermissionRequest only understands allow/deny. Omitting the
          // decision entirely is how you fall back to the CLI prompt.
          ...(verdict === 'ask' ? {} : {
            decision: {
              behavior: verdict,
              ...(updatedInput ? { updatedInput } : {}),
            },
          }),
        },
        ...(verdict === 'ask' ? { systemMessage: `⏭  ${reason}` } : {}),
      };

  flushAndExit(JSON.stringify(out));
}

/* ------------------------------------------------------- withdrawing */

/**
 * The request we are currently waiting on, and how to reach it.
 *
 * Set as soon as /api/notify hands back an id, cleared the moment a verdict
 * arrives. While it is set, this process is the only thing listening — so if we
 * stop, the row has to stop being answerable too.
 */
let live = null;

/**
 * lib/local-trace.mjs, imported before the wait starts.
 *
 * `record` runs the moment the row exists and `drop` runs if the phone answers, so
 * both are needed while this process is alive rather than on the way out. Resolved
 * up front regardless: an import that has not finished when the process is killed
 * is a lost history entry.
 */
let traceStore = null;

/**
 * Leave the breadcrumb as soon as there is a row to point at.
 *
 * This used to happen on the withdrawal path, which was wrong in the way that
 * matters most: it assumed the hook always gets to run code before it dies. It
 * does not. Claude Code may kill it outright when the terminal takes the prompt,
 * and a SIGKILL runs no handler — so the one case the whole feature exists for
 * left nothing behind, and the row sat `pending` until it expired.
 *
 * Writing it up front inverts that. The trace exists from the moment the request
 * does, and the only thing that removes it is this process deciding it is not
 * needed: the phone answered. Every other ending — killed, crashed, timed out,
 * machine slept — leaves a trace the reconcile hook can pick up.
 *
 * The cost of being early is a trace for requests the phone did answer, and it is
 * paid for twice over: `drop` clears them on the way out, and /api/local-decide
 * refuses to write over `allow`/`deny`/`answer` regardless. A stale trace can
 * delay a history entry. It cannot change a verdict.
 */
function beginTrace(trace) {
  if (!traceStore) return;
  try { traceStore.record(trace); } catch (err) { log(`could not leave a trace: ${err.message}`); }
}

/** The phone answered: this row is settled, and no reconciliation is wanted. */
function endTrace(trace) {
  if (!traceStore || !trace) return;
  try { traceStore.drop(trace); } catch {}
}

/**
 * Tell the server nobody is listening any more.
 *
 * The case this exists for: the prompt reaches the terminal as well (the user
 * answered there, or pressed escape) and Claude Code kills this process. The row
 * would stay `pending` for the rest of its timeout, so the notification still
 * opens a working Approve/Deny screen for a question that is already settled —
 * and the tap silently decides nothing.
 *
 * Best-effort and conditional: the server only cancels a row that is still
 * pending, so a verdict that landed a moment earlier always wins. `keepalive`
 * matters on the signal path, where the process is about to go away.
 */
async function cancelLive(why) {
  const l = live;
  if (!l) return;
  live = null;
  log(`withdrawing ${l.requestId} (${why})`);

  // Leave a breadcrumb before anything else, including before the network call:
  // this is the last moment anything knows that request `l.requestId` was about
  // this tool call, and on the signal path the process may not get another one.
  //
  // The prompt is about to appear in the terminal, and whatever is decided there
  // is the real outcome of this request. The reconcile hook picks the trace up
  // afterwards — on PostToolUse if the tool runs, on Stop if it was refused — and
  // reports it, so the row ends up saying what was decided instead of only that
  // we stopped waiting. Best-effort: a failure costs a history entry and nothing
  // else, which is why it is not awaited and cannot throw into the decision path.
  // The trace was written when the row was created, not here — see `beginTrace`.
  // Rewriting it on this path would be harmless (same filename, same contents) but
  // it would also re-establish the wrong idea: that a withdrawal is what leaves the
  // breadcrumb. A SIGKILLed hook never reaches this line at all.

  try {
    await fetch(`${l.apiBase}/api/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(l.machineToken ? { authorization: `Bearer ${l.machineToken}` } : {}),
      },
      body: JSON.stringify({ id: l.requestId }),
      keepalive: true,
      signal: AbortSignal.timeout(3000),
    });
  } catch (err) {
    // A stale-pending row is a UI annoyance, not a safety problem — the sweeper
    // and expires_at still close it. Never let this failure change the decision.
    log(`withdraw failed: ${err.message}`);
  }
}

/**
 * Killed mid-wait is a normal way this ends — the user pressed escape, or
 * answered in the terminal — so it gets a handler rather than being left to the
 * OS. We give the cancel a moment to leave the machine, then exit 0 with an empty
 * stdout: no decision, which is the one thing a killed hook must never invent.
 * (0 rather than 128+n so a signal does not surface as a hook error.)
 */
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cancelLive(sig.toLowerCase()).finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 3500).unref();
  });
}

/* ------------------------------------------------------------ grace period */

/**
 * Hold the push back for a moment, in case you are already at the keyboard.
 *
 * The prompt appears in the terminal at the same time as this hook runs — they
 * race, and whoever answers first wins. When you are sitting at the machine you
 * win that race every time, several seconds before you could have picked up a
 * phone. The notification then arrives for something already decided: it buzzes,
 * you look, and there is nothing to do. Enough of those and the notification stops
 * meaning anything, which is the only way this tool really fails.
 *
 * So: wait `graceSec`, watching the transcript for this exact call being answered.
 * If it is, we never notify at all — no row, no push, nothing to dismiss. If the
 * grace passes in silence, you are not at the keyboard and the phone should ring.
 *
 * Two things make this cheap rather than clever. Nothing has been created yet, so
 * abandoning costs one file read per poll and no network at all. And being killed
 * during the grace — which is what happens when the terminal takes the prompt —
 * needs no handling: there is no row to withdraw and no trace to leave.
 *
 * The baseline matters. An identical command earlier in the session already has a
 * result sitting in the transcript, so only results appearing *after* we start
 * count; otherwise a loop would silence its own notifications.
 */
async function graceElapsed(cfg, trace, transcriptPath) {
  const graceMs = Math.max(0, cfg.graceSec) * 1000;
  if (!graceMs) return true;

  const { lineCount, answeredSince } = await import('../lib/transcript.mjs');
  const { fingerprint } = traceStore;
  const baseline = transcriptPath ? lineCount(transcriptPath) : 0;

  log(`holding the push for ${cfg.graceSec}s in case the terminal answers`);
  const until = Date.now() + graceMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, Math.min(500, until - Date.now())));
    if (!transcriptPath) continue;
    if (answeredSince(transcriptPath, trace, fingerprint, baseline)) {
      log('answered in the terminal during the grace period — not notifying');
      return false;
    }
  }
  return true;
}

/* ----------------------------------------------------------------- hosted */

/**
 * Encrypts the payload, posts it, then waits on the websocket.
 *
 * The server sees the tool name and nothing else about the call. Encryption
 * happens here, before the request leaves the machine — there is no code path
 * that sends `summary`, `detail` or `cwd` in the clear.
 */
async function hosted(cfg, { tool, summary, detail, cwd, questions, trace }) {
  const { encryptPayload, decryptPayload } = await import('../lib/crypto.mjs');
  const { waitForDecision } = await import('../lib/wait-hosted.mjs');

  // Questions and their options are user-facing content, so they travel inside the
  // same blob as the command — the server sees a tool name and a length.
  const payload_ciphertext = encryptPayload(cfg.payloadKey, {
    summary, detail, cwd,
    ...(questions ? { questions } : {}),
  });

  const res = await fetch(`${cfg.apiBase}/api/notify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // machineToken lives in the header, never in a URL, a QR, or a log line.
      authorization: `Bearer ${cfg.machineToken}`,
    },
    body: JSON.stringify({ tool, payload_ciphertext, timeout_sec: cfg.timeoutSec }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  if (body.warning) log(`onesignal: ${body.warning}`);
  log(`sent ${tool} → ${body.request_id}`);
  live = {
    apiBase: cfg.apiBase,
    machineToken: cfg.machineToken,
    requestId: body.request_id,
    trace: { ...trace, requestId: body.request_id },
  };
  // The row exists, so the breadcrumb does too — before the wait, because the wait
  // is what we might not come back from.
  beginTrace(live.trace);

  // Deadline is ours, and the server's expires_at mirrors it. Both must agree or
  // a late tap could report success after we have already given up.
  const out = await waitForDecision({
    apiBase: cfg.apiBase,
    machineToken: cfg.machineToken,
    supabaseUrl: cfg.supabaseUrl,
    anonKey: cfg.supabaseAnonKey,
    realtimeToken: body.realtime_token,
    requestId: body.request_id,
    deadline: Date.now() + cfg.timeoutSec * 1000,
    log,
  });

  // An answered question comes back as a second blob the server also cannot read.
  // Undecryptable means we do not know what was chosen, which is the one thing we
  // must not guess: drop to no-decision and let the terminal ask.
  if (out?.status === 'answer') {
    try {
      const { answers } = decryptPayload(cfg.payloadKey, out.answer_ciphertext);
      return { ...out, answers };
    } catch (err) {
      log(`could not read the answer: ${err.message}`);
      return null;
    }
  }
  return out;
}

/* ------------------------------------------------------------ self-hosted */

/** The original path: local server, 25-second long-poll chunks. Unchanged. */
async function selfHosted(cfg, { tool, summary, detail, cwd, questions, trace }) {
  const res = await fetch(`${cfg.url}/api/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      device_id: cfg.deviceId,
      tool, summary, detail, cwd,
      ...(questions ? { questions } : {}),
      // Server expires the request in step with our own wait, so a late tap on
      // the phone reports "timed out" instead of a false success.
      timeout_sec: cfg.timeoutSec,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
  const requestId = body.request_id;
  log(`sent ${tool} → ${requestId}`);
  live = {
    apiBase: cfg.url,
    machineToken: '',
    requestId,
    trace: { ...trace, requestId },
  };
  beginTrace(live.trace);

  const deadline = Date.now() + cfg.timeoutSec * 1000;
  while (Date.now() < deadline) {
    const budget = Math.max(1, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    try {
      const r = await fetch(`${cfg.url}/api/wait/${requestId}?timeout=${budget}`, {
        signal: AbortSignal.timeout((budget + 8) * 1000),
      });
      const b = await r.json().catch(() => ({}));
      if (b.status === 'allow' || b.status === 'deny') return { status: b.status, note: b.note };
      // Self-hosted keeps everything local, so the selection needs no envelope.
      if (b.status === 'answer') return { status: b.status, note: b.note, answers: b.answers ?? {} };
    } catch (err) {
      log(`poll error: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null;
}

/* -------------------------------------------------------------------- main */

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch { log('unparseable stdin'); }

  // AAP_DEBUG=1 dumps exactly what Claude Code sends, so you can see which
  // fields PermissionRequest actually populates.
  if (process.env.AAP_DEBUG === '1') {
    const { appendFileSync } = await import('node:fs');
    appendFileSync('/tmp/aap-hook-input.jsonl', raw.trim() + '\n');
    log(`raw event → /tmp/aap-hook-input.jsonl`);
  }

  const eventName = event.hook_event_name ?? 'PermissionRequest';
  const toolName = event.tool_name ?? 'unknown';
  const toolInput = event.tool_input ?? {};

  const { loadHookConfig, CONFIG_PATH: configPath } = await import('../lib/hook-config.mjs');
  CONFIG_PATH = configPath;
  const cfg = loadHookConfig();

  // Silence first: a muted or filtered prompt should not even complain about a
  // half-finished config, and it must not touch the network.
  const quiet = wantsNotify(cfg, toolName);
  if (quiet) {
    log(`not notifying — ${quiet}`);
    return emit(eventName, 'ask', `notifications off: ${quiet}`);
  }

  const missing = cfg.mode === 'hosted'
    ? ['apiBase', 'machineToken', 'payloadKey'].filter((k) => !cfg[k])
    : ['url', 'deviceId'].filter((k) => !cfg[k]);
  if (missing.length) {
    return emit(eventName, 'ask', `not configured: ${missing.join(', ')} (${CONFIG_PATH})`);
  }

  const { summary, detail, questions } = describe(toolName, toolInput);
  // What the reconcile hook needs to find this request again once the terminal has
  // answered it: which session, which tool, and a hash of the input to tell this
  // call apart from the next identical-looking one. No command, no cwd, no token —
  // a trace left behind by a crash is worth nothing to anyone who finds it.
  traceStore = await import('../lib/local-trace.mjs');
  const { fingerprint } = traceStore;
  const trace = {
    sessionId: event.session_id ?? '',
    tool: toolName,
    fp: fingerprint(toolName, toolInput),
  };

  const call = { tool: toolName, summary, detail, cwd: event.cwd ?? '', questions, trace };

  // Before anything is sent: if you answer at the keyboard in the next few seconds,
  // the phone is never told about this at all. Nothing exists to withdraw yet, so
  // this costs one file read per poll and no network.
  if (!await graceElapsed(cfg, trace, event.transcript_path ?? '')) {
    // No decision. Claude Code already has the terminal's answer; ours would be
    // answering a question nobody is asking any more.
    return emit(eventName, 'ask', 'answered in the terminal');
  }

  let decision;
  try {
    decision = cfg.mode === 'hosted' ? await hosted(cfg, call) : await selfHosted(cfg, call);
  } catch (err) {
    // The row may exist even when the wait blew up (push accepted, websocket
    // never came back). Withdraw it before handing the prompt to the terminal.
    await cancelLive('wait failed');
    return emit(eventName, 'ask', `notify failed: ${err.message}`);
  }

  if (!decision) {
    log('no answer in time, falling back to CLI prompt');
    // The prompt is about to appear in the terminal, so the phone must stop
    // offering to answer it. expires_at has usually settled the row already;
    // this also covers the paths that give up early.
    await cancelLive('timed out');
    return emit(eventName, 'ask', 'No response from phone');
  }

  // Grab the trace before releasing `live` — it is the only thing still holding the
  // request id, and the paths below need to either drop it or deliberately keep it.
  const answeredTrace = live?.trace;
  live = null;   // answered — nothing left to withdraw

  log(`decided: ${decision.status}`);

  // A selection: allow the tool, with the picks already in its input. Re-validated
  // against the options we sent, so only labels Claude actually offered get through.
  if (decision.status === 'answer') {
    const answers = toolAnswers(questions ?? [], decision.answers ?? {});
    if (!Object.keys(answers).length) {
      log('answer carried no recognisable option — falling back to CLI prompt');
      // The trace stays. The terminal is about to ask after all, and whatever is
      // decided there is this request's real outcome.
      return emit(eventName, 'ask', 'Answer from phone could not be applied');
    }
    log(`answers: ${JSON.stringify(answers)}`);
    // Settled by the phone: the row already says so, and the reconcile hook has
    // nothing to add.
    endTrace(answeredTrace);
    return emit(
      eventName,
      'allow',
      decision.note || 'Answered from phone',
      { ...toolInput, answers },
    );
  }

  endTrace(answeredTrace);
  return emit(
    eventName,
    decision.status,
    decision.note || (decision.status === 'allow' ? 'Approved from phone' : 'Denied from phone'),
  );
}

main().catch((err) => {
  log(`fatal: ${err.stack}`);
  // Last-resort fail-safe: emit NO decision. An empty hookSpecificOutput falls
  // through to the terminal prompt — the one behaviour that is always safe.
  flushAndExit(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PermissionRequest' },
    systemMessage: `approval hook crashed: ${err.message}`,
  }));
});
