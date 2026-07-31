/**
 * The hosted-mode return path: wait for someone to answer.
 *
 * Primary transport is Supabase Realtime. The hook subscribes to its own
 * `requests` row over a websocket and Postgres pushes the verdict. This is not a
 * preference — Vercel functions cannot hold a long-poll open, and short-polling a
 * 120-second wait would cost ~40 invocations per approval.
 *
 * Fallback is bounded polling of /api/request every 3s. It engages when the
 * websocket cannot connect, drops, or is simply unavailable (Node without a global
 * WebSocket), and it always says so on stderr. A dead websocket must never mean a
 * missed approval.
 *
 * Every exit is one of: a real verdict, or null. Null means "no decision", which
 * the hook turns into the terminal prompt. There is no error path that returns
 * `allow`.
 */

const POLL_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `answer` is a settled status like the other two: AskUserQuestion came back with
// a selection rather than a verdict. The selection itself rides along encrypted —
// this layer never reads it.
const settled = (s) => s === 'allow' || s === 'deny' || s === 'answer';

export async function waitForDecision(opts) {
  const { deadline, log } = opts;
  const done = { value: null };

  // One immediate read closes the race where the phone answered before we
  // finished subscribing — entirely possible with a fast tap on Android.
  const early = await fetchStatus(opts).catch(() => null);
  if (early && settled(early.status)) return early;

  const realtime = subscribe(opts, done);
  const poll = pollUntil(opts, done, realtime.failed);

  const result = await Promise.race([
    realtime.decision,
    poll,
    sleep(Math.max(0, deadline - Date.now())).then(() => null),
  ]);

  await realtime.close().catch(() => {});
  return result && settled(result.status) ? result : null;
}

/* ------------------------------------------------------------------ realtime */

function subscribe(opts, done) {
  const { supabaseUrl, anonKey, realtimeToken, requestId, log } = opts;

  // Node 20 has no global WebSocket. Rather than pull in a websocket dependency
  // for a subprocess that lives 120 seconds, we say so and let polling carry it.
  if (typeof WebSocket === 'undefined') {
    log('no global WebSocket (Node < 22) — using polling fallback');
    return { decision: new Promise(() => {}), failed: Promise.resolve('unsupported'), close: async () => {} };
  }
  if (!supabaseUrl || !anonKey || !realtimeToken) {
    log('realtime not configured — using polling fallback');
    return { decision: new Promise(() => {}), failed: Promise.resolve('unconfigured'), close: async () => {} };
  }

  let failNow;
  const failed = new Promise((r) => { failNow = r; });
  let client;
  let channel;

  const decision = (async () => {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 10 } },
    });
    // The device-scoped JWT from /api/notify. RLS on `requests` keys off its
    // device_id claim, so this subscription cannot see another tenant's rows.
    client.realtime.setAuth(realtimeToken);

    return new Promise((resolve) => {
      channel = client
        .channel(`aap:${requestId}`, { config: { private: false } })
        .on(
          'postgres_changes',
          { event: 'UPDATE', schema: 'public', table: 'requests', filter: `id=eq.${requestId}` },
          (payload) => {
            const row = payload.new ?? {};
            if (settled(row.status)) {
              log(`realtime: ${row.status}`);
              done.value = row;
              resolve({
                status: row.status,
                note: row.note ?? null,
                answer_ciphertext: row.answer_ciphertext ?? null,
              });
            }
          },
        )
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') return log('realtime subscribed');
          // CHANNEL_ERROR / TIMED_OUT / CLOSED all mean the same thing to us:
          // stop trusting this transport and let polling take over. We do not
          // tear the channel down — if it recovers, the verdict still arrives.
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            log(`realtime ${status.toLowerCase()}${err ? `: ${err.message}` : ''}`);
            failNow(status);
          }
        });
    });
  })().catch((err) => {
    log(`realtime unavailable: ${err.message}`);
    failNow('error');
    return new Promise(() => {});   // never resolves; polling or the deadline wins
  });

  return {
    decision,
    failed,
    close: async () => {
      try { if (channel) await client.removeChannel(channel); } catch {}
      try { client?.realtime?.disconnect(); } catch {}
    },
  };
}

/* ------------------------------------------------------------------- polling */

/** Idle until the websocket reports trouble, then polls out the remaining wait. */
async function pollUntil(opts, done, failed) {
  const { deadline, log } = opts;
  await failed;
  if (done.value) return null;

  log(`falling back to polling every ${POLL_MS / 1000}s`);
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    if (done.value) return null;             // realtime recovered and won
    if (Date.now() >= deadline) break;
    try {
      const r = await fetchStatus(opts);
      if (r && settled(r.status)) {
        log(`polled: ${r.status}`);
        return r;
      }
      // `expired`/`cancelled` mean the server already settled it against us.
      // Nothing will change after this; stop burning requests.
      if (r && (r.status === 'expired' || r.status === 'cancelled')) return null;
    } catch (err) {
      log(`poll error: ${err.message}`);
    }
  }
  return null;
}

async function fetchStatus({ apiBase, machineToken, requestId }) {
  const res = await fetch(`${apiBase}/api/request?id=${encodeURIComponent(requestId)}`, {
    headers: { authorization: `Bearer ${machineToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const b = await res.json();
  return {
    status: b.status,
    note: b.note ?? null,
    answer_ciphertext: b.answer_ciphertext ?? null,
  };
}
