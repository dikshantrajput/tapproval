#!/usr/bin/env node
/**
 * The invariants that can be proven without a phone.
 *
 *   node scripts/verify.mjs
 *
 * The rest of the verification list in HOSTED_BRIEF.md needs a real device and a
 * real deployment; those steps are in the README under "Verifying hosted mode".
 * Everything here is mechanical and should stay green.
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newPayloadKey, encryptPayload, decryptPayload } from '../lib/crypto.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(ROOT, 'hook', 'permission-hook.mjs');

let failures = 0;
const check = (name, pass, detail = '') => {
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
};

/* ------------------------------------------------------- payload encryption */

console.log('\nencryption');

const key = newPayloadKey();
const secret = {
  summary: 'rm -rf build/',
  detail: 'rm -rf build/ && npm run deploy',
  cwd: '/Users/someone/work',
};
const blob = encryptPayload(key, secret);

check('round-trips through node', JSON.stringify(decryptPayload(key, blob)) === JSON.stringify(secret));
check('ciphertext contains no plaintext', !blob.includes('rm -rf') && !/build/.test(blob));
check('format is v1.iv.body', /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(blob));

check('a different key cannot read it', await (async () => {
  try { decryptPayload(newPayloadKey(), blob); return false; } catch { return true; }
})());

check('a tampered blob is rejected (GCM tag)', await (async () => {
  const bad = blob.slice(0, -2) + (blob.endsWith('A') ? 'BB' : 'AA');
  try { decryptPayload(key, bad); return false; } catch { return true; }
})());

// The phone and the service worker decrypt with crypto.subtle, not with node's
// crypto. Node exposes the same WebCrypto implementation the browser does, so
// this proves the browser path parses what lib/crypto.mjs writes.
check('WebCrypto (the browser path) decrypts it', await (async () => {
  const b64urlToBytes = (s) => Buffer.from(s, 'base64url');
  const [, iv, body] = blob.split('.');
  const ck = await crypto.subtle.importKey(
    'raw', b64urlToBytes(key), { name: 'AES-GCM' }, false, ['decrypt'],
  );
  const out = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(iv) }, ck, b64urlToBytes(body),
  );
  return JSON.parse(Buffer.from(out).toString('utf8')).summary === secret.summary;
})());

/* --------------------------------------------------------- hook, fail-safe */

console.log('\nhook fails safe');

/** Runs the hook with a scratch config and returns { stdout, stderr }. */
const DEFAULT_EVENT = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'echo hi' },
};

async function runHook(hookConfig, event = DEFAULT_EVENT) {
  const home = mkdtempSync(join(tmpdir(), 'aap-verify-'));
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(home, '.claude'), { recursive: true });
  // No grace period unless a case asks for one. It is 0 in real config too, and
  // every case here is about what happens *after* the push goes out — paying
  // that pause in each of them would add minutes to the suite and prove nothing.
  // The grace period has its own group, which sets it deliberately.
  writeFileSync(
    join(home, '.claude', 'tapproval.json'),
    JSON.stringify({ graceSec: 0, ...hookConfig }),
  );

  try {
    return await new Promise((resolve) => {
      const p = spawn(process.execPath, [HOOK], {
        // The wait comes from the config under test, so a case can be as short as
        // "fail immediately" or as long as "let the fallback poll twice".
        env: { ...process.env, HOME: home, USERPROFILE: home },
      });
      let stdout = '', stderr = '';
      p.stdout.on('data', (d) => (stdout += d));
      p.stderr.on('data', (d) => (stderr += d));
      p.on('close', () => resolve({ stdout, stderr }));
      p.stdin.end(JSON.stringify(event));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const grantsPermission = (stdout) => {
  try {
    return JSON.parse(stdout).hookSpecificOutput?.decision?.behavior === 'allow';
  } catch {
    return false;
  }
};

for (const [label, cfg] of [
  ['unconfigured', {}],
  ['hosted, API unreachable', {
    mode: 'hosted',
    apiBase: 'http://127.0.0.1:9',      // discard port: connection refused
    machineToken: 'x'.repeat(43),
    payloadKey: newPayloadKey(),
    timeoutSec: 2,
  }],
  ['hosted, bad payload key', {
    mode: 'hosted',
    apiBase: 'http://127.0.0.1:9',
    machineToken: 'x'.repeat(43),
    payloadKey: 'not-a-key',
    timeoutSec: 2,
  }],
  ['self-hosted, server down', {
    mode: 'self-hosted',
    url: 'http://127.0.0.1:9',
    deviceId: 'abc123',
    timeoutSec: 2,
  }],
]) {
  const { stdout } = await runHook(cfg);
  check(`${label} → no allow`, !grantsPermission(stdout), stdout.slice(0, 160));
  check(`${label} → stdout is exactly one JSON object`, (() => {
    try { JSON.parse(stdout); return true; } catch { return false; }
  })(), JSON.stringify(stdout.slice(0, 160)));
}

/* ------------------------------------------------ mute and the tool filters */

console.log('\nnotifications can be turned down');

{
  // Every case points at a port that refuses connections. If a filter leaks, the
  // hook tries to notify and the stderr says so — so "no attempt" is checkable.
  const base = {
    mode: 'hosted',
    apiBase: 'http://127.0.0.1:9',
    machineToken: 'x'.repeat(43),
    payloadKey: newPayloadKey(),
    timeoutSec: 2,
  };
  const reason = (out) => {
    try { return JSON.parse(out.stdout).systemMessage ?? ''; } catch { return ''; }
  };
  const quiet = (out) => !JSON.parse(out.stdout).hookSpecificOutput?.decision
    && /notifications off/.test(reason(out));
  // The refused connection is the tell: only a hook that actually tried says this.
  const triedToSend = (out) => /notify failed/.test(reason(out));

  const muted = await runHook({ ...base, muted: true });
  check('muted → no decision, and it says why', quiet(muted), muted.stdout.slice(0, 200));
  check('muted → nothing is sent at all', !triedToSend(muted), muted.stderr.slice(0, 200));

  const skipped = await runHook({ ...base, skipTools: ['Bash'] });
  check('a skipped tool is not sent', quiet(skipped) && !triedToSend(skipped), skipped.stdout.slice(0, 200));

  const kept = await runHook({ ...base, skipTools: ['Read'] });
  check('a tool that is not skipped still goes out', triedToSend(kept), kept.stderr.slice(0, 200));

  const shortlist = await runHook({ ...base, onlyTools: ['AskUserQuestion'] });
  check('onlyTools excludes everything else', quiet(shortlist) && !triedToSend(shortlist), shortlist.stdout.slice(0, 200));

  const listed = await runHook({ ...base, onlyTools: ['Bash', 'AskUserQuestion'] });
  check('and lets its own list through', triedToSend(listed), listed.stderr.slice(0, 200));

  // A shortlist is the stronger statement; honouring both would let an empty
  // intersection mute everything by accident.
  const both = await runHook({ ...base, onlyTools: ['Bash'], skipTools: ['Bash'] });
  check('onlyTools wins over skipTools', triedToSend(both), both.stderr.slice(0, 200));
}

/* --------------------------------------------- no plaintext leaves the hook */

console.log('\nhosted mode sends ciphertext only');

// Stand up a listener that captures exactly what the hook POSTs.
const { createServer } = await import('node:http');
const captured = [];
const spy = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    captured.push({ path: req.url, auth: req.headers.authorization ?? '', body });
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"stop here"}');
  });
});
await new Promise((r) => spy.listen(0, '127.0.0.1', r));
const spyPort = spy.address().port;

const spyKey = newPayloadKey();
await runHook({
  mode: 'hosted',
  apiBase: `http://127.0.0.1:${spyPort}`,
  machineToken: 'm'.repeat(43),
  payloadKey: spyKey,
  timeoutSec: 2,
}, {
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'cat ~/.ssh/id_rsa' },
  cwd: '/Users/someone/secret-project',
});
spy.close();

const post = captured.find((c) => c.path === '/api/notify');
check('posted to /api/notify', !!post);
if (post) {
  const sent = JSON.parse(post.body);
  check('no command in the request body', !post.body.includes('id_rsa'));
  check('no cwd in the request body', !post.body.includes('secret-project'));
  check('no summary/detail/cwd fields at all',
    !('summary' in sent) && !('detail' in sent) && !('cwd' in sent),
    Object.keys(sent).join(','));
  check('tool name is sent in the clear (by design)', sent.tool === 'Bash');
  check('machine token is in the header, not the body',
    post.auth.startsWith('Bearer ') && !post.body.includes('mmmm'));
  check('the blob decrypts to the real command',
    decryptPayload(spyKey, sent.payload_ciphertext).summary === 'cat ~/.ssh/id_rsa');
}

/* ------------------------------------------- hosted: the polling fallback works */

console.log('\nhosted polling fallback delivers the decision');

// No Realtime credentials, so the websocket path is skipped and the bounded
// polling fallback has to carry the decision on its own. This is the same code
// path a dropped websocket takes.
{
  let polls = 0;
  const api = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/notify') {
      return res.end(JSON.stringify({ request_id: 'r-1', expires_at: new Date(Date.now() + 20_000).toISOString() }));
    }
    if (url.pathname === '/api/request') {
      polls++;
      // Answered between the first and second poll.
      return res.end(JSON.stringify(polls > 1
        ? { status: 'allow', note: 'from the fallback' }
        : { status: 'pending' }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((r) => api.listen(0, '127.0.0.1', r));

  const { stdout, stderr } = await runHook({
    mode: 'hosted',
    apiBase: `http://127.0.0.1:${api.address().port}`,
    machineToken: 'm'.repeat(43),
    payloadKey: newPayloadKey(),
    timeoutSec: 12,
  });
  api.close();

  const decision = (() => { try { return JSON.parse(stdout); } catch { return {}; } })();
  check('fallback produced allow', decision.hookSpecificOutput?.decision?.behavior === 'allow', stdout.slice(0, 200));
  check('and said so on stderr', /falling back to polling/.test(stderr), stderr.slice(0, 300));
  check('stderr carries the logs, stdout only the decision',
    stdout.trim().startsWith('{') && !stdout.includes('[approval-hook]'));
}

/* ------------------------------------------- self-hosted: still works end to end */

console.log('\nself-hosted mode, end to end');

{
  const port = 8791;
  const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      DRY_RUN: '1',
      PUBLIC_URL: `http://localhost:${port}`,
      DEVICE_ID: 'verify-device',
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  // Wait for the port rather than guessing at a sleep.
  const up = await (async () => {
    for (let i = 0; i < 40; i++) {
      try {
        await fetch(`http://localhost:${port}/api/config`);
        return true;
      } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return false;
  })();
  check('local server started', up);

  if (up) {
    const hookRun = runHook({
      mode: 'self-hosted',
      url: `http://localhost:${port}`,
      deviceId: 'verify-device',
      timeoutSec: 12,
    });

    // Play the phone: find the pending request, approve it.
    let id = null;
    for (let i = 0; i < 60 && !id; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const res = await fetch(`http://localhost:${port}/api/pending`, {
        headers: { authorization: 'Bearer verify-device' },
      });
      ({ id } = await res.json());
    }
    check('request reached the server', !!id);

    if (id) {
      const res = await fetch(`http://localhost:${port}/api/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, verdict: 'allow' }),
      });
      const out = await res.json();
      check('server applied the verdict', out.applied === true, JSON.stringify(out));
    }

    const { stdout } = await hookRun;
    const decision = (() => { try { return JSON.parse(stdout); } catch { return {}; } })();
    check('hook emitted allow', decision.hookSpecificOutput?.decision?.behavior === 'allow', stdout.slice(0, 200));
  }

  server.kill('SIGKILL');
}

/* -------------------------------------------- AskUserQuestion, end to end */

console.log('\nquestions (AskUserQuestion)');

const QUESTION_EVENT = {
  hook_event_name: 'PermissionRequest',
  tool_name: 'AskUserQuestion',
  cwd: '/Users/someone/secret-project',
  tool_input: {
    questions: [{
      question: 'Which database should we use?',
      header: 'Database',
      multiSelect: false,
      options: [
        { label: 'Postgres', description: 'relational, boring, correct' },
        { label: 'SQLite', description: 'one file, no server' },
      ],
    }],
  },
};

// The options are content like any other: they must not reach the server in the
// clear in hosted mode, and neither must the answer coming back.
{
  const captured2 = [];
  const spy2 = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      captured2.push({ path: req.url, body });
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"stop here"}');
    });
  });
  await new Promise((r) => spy2.listen(0, '127.0.0.1', r));

  const qKey = newPayloadKey();
  await runHook({
    mode: 'hosted',
    apiBase: `http://127.0.0.1:${spy2.address().port}`,
    machineToken: 'm'.repeat(43),
    payloadKey: qKey,
    timeoutSec: 2,
  }, QUESTION_EVENT);
  spy2.close();

  const post2 = captured2.find((c) => c.path === '/api/notify');
  check('question posted to /api/notify', !!post2);
  if (post2) {
    check('no question text in the request body', !post2.body.includes('database'));
    check('no option labels in the request body', !/Postgres|SQLite/.test(post2.body));
    const sent = JSON.parse(post2.body);
    check('tool name is sent in the clear (by design)', sent.tool === 'AskUserQuestion');
    const payload = decryptPayload(qKey, sent.payload_ciphertext);
    check('the blob carries the questions and their options',
      payload.questions?.[0]?.options?.[1]?.label === 'SQLite');
  }
}

// Self-hosted: the phone answers with a selection, and the hook has to turn that
// into tool input Claude can use — allow, with `answers` filled in.
{
  const port = 8792;
  const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      DRY_RUN: '1',
      PUBLIC_URL: `http://localhost:${port}`,
      DEVICE_ID: 'verify-device',
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const up = await (async () => {
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://localhost:${port}/api/config`); return true; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return false;
  })();
  check('local server started', up);

  /** Plays the phone: waits for the request, then sends `picked` as the answer. */
  const answerWith = async (picked) => {
    const hookRun = runHook({
      mode: 'self-hosted',
      url: `http://localhost:${port}`,
      deviceId: 'verify-device',
      timeoutSec: 12,
    }, QUESTION_EVENT);

    let id = null;
    for (let i = 0; i < 60 && !id; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const res = await fetch(`http://localhost:${port}/api/pending`, {
        headers: { authorization: 'Bearer verify-device' },
      });
      ({ id } = await res.json());
    }
    if (!id) return { applied: null, decision: {} };

    const detail = await (await fetch(`http://localhost:${port}/api/request?id=${id}`)).json();
    const res = await fetch(`http://localhost:${port}/api/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id, verdict: 'answer', answers: picked }),
    });
    const out = await res.json();
    const { stdout } = await hookRun;
    let decision = {};
    try { decision = JSON.parse(stdout); } catch {}
    return { applied: out.applied, status: out.status, decision, detail, stdout };
  };

  if (up) {
    const good = await answerWith({ 0: ['SQLite'] });
    check('server carried the questions through to the phone',
      good.detail?.questions?.[0]?.header === 'Database');
    check('server applied the answer', good.applied === true, JSON.stringify(good.status));
    const d = good.decision.hookSpecificOutput?.decision;
    check('hook allowed the tool', d?.behavior === 'allow', good.stdout?.slice(0, 200));
    check('hook filled in the selection, keyed by question text',
      d?.updatedInput?.answers?.['Which database should we use?'] === 'SQLite',
      JSON.stringify(d?.updatedInput));
    check('and left the questions in the input untouched',
      d?.updatedInput?.questions?.[0]?.options?.length === 2);

    // A label Claude never offered must not reach the tool. Nothing to apply means
    // no decision at all — the terminal asks instead.
    const bogus = await answerWith({ 0: ['Oracle'] });
    const bd = bogus.decision.hookSpecificOutput;
    check('an option that was never offered is dropped',
      !bd?.decision, JSON.stringify(bd).slice(0, 200));
    check('and that falls through to the terminal prompt',
      /could not be applied/.test(bogus.decision.systemMessage ?? ''),
      bogus.decision.systemMessage);
  }

  server.kill('SIGKILL');
}

/* ------------------------------------------------- the grace period */

/**
 * The push is held back for a few seconds so a keyboard answer can pre-empt it.
 *
 * Two properties, and the second is the one that would be easy to get wrong: an
 * identical command earlier in the session already has a result in the transcript,
 * and treating that as an answer to *this* prompt would silence a loop's
 * notifications entirely.
 */
console.log('\nthe grace period');

{
  const { mkdirSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'aap-grace-'));
  mkdirSync(join(home, '.claude'), { recursive: true });

  // Points at a port that refuses connections: if the hook notifies, stderr says
  // so, which is how "did not notify" becomes checkable rather than assumed.
  writeFileSync(join(home, '.claude', 'tapproval.json'), JSON.stringify({
    mode: 'hosted',
    apiBase: 'http://127.0.0.1:9',
    machineToken: 'x'.repeat(43),
    payloadKey: newPayloadKey(),
    timeoutSec: 2,
    graceSec: 6,
  }));

  const transcript = join(home, 'transcript.jsonl');
  const toolUse = (id, input) => JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] },
  });
  const toolResult = (id, content) => JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content }] },
  });

  /** Runs the hook against `home`, optionally appending to the transcript midway. */
  const runGrace = async (afterMs, append) => {
    const p = spawn(process.execPath, [HOOK], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stderr = '', stdout = '';
    p.stderr.on('data', (d) => (stderr += d));
    p.stdout.on('data', (d) => (stdout += d));
    p.stdin.end(JSON.stringify({ ...DEFAULT_EVENT, transcript_path: transcript }));

    if (append) {
      await new Promise((r) => setTimeout(r, afterMs));
      const { appendFileSync } = await import('node:fs');
      appendFileSync(transcript, append + '\n');
    }
    await new Promise((r) => p.on('close', r));
    return { stderr, stdout };
  };

  // The tool_use for the live call, plus an older identical call that already
  // completed — the trap.
  writeFileSync(transcript, [
    toolUse('toolu_old', { command: 'echo hi' }),
    toolResult('toolu_old', 'hi'),
  ].join('\n') + '\n');

  const answered = await runGrace(1200, toolResult('toolu_old', 'hi'));
  check('the grace period is announced', /holding the push for 6s/.test(answered.stderr), answered.stderr.slice(0, 200));
  check('a terminal answer during the grace stops the notification',
    /not notifying/.test(answered.stderr) && !/notify failed|sent Bash/.test(answered.stderr),
    answered.stderr.slice(0, 300));
  check('and the prompt falls through to the terminal', (() => {
    try {
      const o = JSON.parse(answered.stdout);
      return !o.hookSpecificOutput?.decision && /answered in the terminal/.test(o.systemMessage ?? '');
    } catch { return false; }
  })(), answered.stdout.slice(0, 200));

  // Now the trap: only the stale result is present, and nothing new arrives. The
  // hook must NOT read the old result as an answer to this prompt.
  writeFileSync(transcript, [
    toolUse('toolu_old', { command: 'echo hi' }),
    toolResult('toolu_old', 'hi'),
  ].join('\n') + '\n');

  const stale = await runGrace(0, null);
  check('a stale result for the same command does not suppress the push',
    /notify failed/.test(stale.stdout) || /sent Bash|ECONNREFUSED|fetch failed/.test(stale.stderr),
    stale.stderr.slice(-300));

  // And with the grace turned off, nothing is held back at all.
  writeFileSync(join(home, '.claude', 'tapproval.json'), JSON.stringify({
    mode: 'hosted',
    apiBase: 'http://127.0.0.1:9',
    machineToken: 'x'.repeat(43),
    payloadKey: newPayloadKey(),
    timeoutSec: 2,
    graceSec: 0,
  }));
  const off = await runGrace(0, null);
  check('graceSec 0 notifies immediately', !/holding the push/.test(off.stderr), off.stderr.slice(0, 200));

  rmSync(home, { recursive: true, force: true });
}

/* ------------------------------------ decisions taken in the terminal */

/**
 * The reconcile path: a prompt the phone never answered still has to end up in the
 * history saying what was decided at the keyboard.
 *
 * Driven through the real server and both real hooks. What is faked is only the
 * parts Claude Code owns — the PostToolUse / Stop events, and the transcript file —
 * because those are the inputs, not the behaviour under test.
 */
console.log('\ndecisions taken in the terminal');

{
  const { mkdirSync, existsSync, readdirSync, readFileSync } = await import('node:fs');
  const port = 8793;
  const server = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    env: {
      ...process.env,
      DRY_RUN: '1',
      PUBLIC_URL: `http://localhost:${port}`,
      DEVICE_ID: 'verify-device',
      PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });

  const up = await (async () => {
    for (let i = 0; i < 40; i++) {
      try { await fetch(`http://localhost:${port}/api/config`); return true; }
      catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    return false;
  })();
  check('local server started', up);

  const RECONCILE = join(ROOT, 'hook', 'reconcile-hook.mjs');
  const SESSION = 'verify-session';
  const hookCfg = {
    mode: 'self-hosted',
    url: `http://localhost:${port}`,
    deviceId: 'verify-device',
    // Short: the point of every case here is that the phone does NOT answer.
    timeoutSec: 1,
    // Straight to the push — the grace period is covered in its own group.
    graceSec: 0,
  };

  // One HOME for the whole group, so a trace written by the permission hook is
  // still there when the reconcile hook runs — which is the handover being tested.
  const home = mkdtempSync(join(tmpdir(), 'aap-reconcile-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', 'tapproval.json'), JSON.stringify(hookCfg));
  const traceDir = join(home, '.tapproval', 'pending');

  const run = (script, event) => new Promise((resolve) => {
    const p = spawn(process.execPath, [script], {
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', () => resolve({ stdout, stderr }));
    p.stdin.end(JSON.stringify(event));
  });

  /**
   * "Nobody has decided this."
   *
   * Which of the two it is depends on a race the hook cannot win and does not need
   * to: its own deadline and the server's `expires_at` are the same instant by
   * design, so giving up at the deadline usually finds the row already `expired`,
   * while being killed early (escape, or answered in the terminal) leaves time for
   * the withdrawal to land as `cancelled`. Both mean the same thing here, and both
   * are what /api/local-decide is allowed to overwrite.
   */
  const undecided = (s) => s === 'cancelled' || s === 'expired';

  const traces = () => (existsSync(traceDir) ? readdirSync(traceDir).filter((f) => f.endsWith('.json')) : []);
  const statusOf = async (id) =>
    (await (await fetch(`http://localhost:${port}/api/request?id=${id}`)).json()).status;

  /** Fire a prompt nobody answers, and hand back the row it left behind. */
  const unanswered = async (event) => {
    await run(HOOK, { ...event, session_id: SESSION });
    const [file] = traces();
    if (!file) return null;
    const trace = JSON.parse(readFileSync(join(traceDir, file), 'utf8'));
    return { ...trace, status: await statusOf(trace.requestId) };
  };

  if (up) {
    /* ---- the breadcrumb must not depend on a clean exit ---- */

    // The case the whole feature exists for: Claude Code takes the prompt back and
    // kills the hook. A SIGKILL runs no handler, so anything written "on the way
    // out" is never written at all — which is why the trace goes down when the row
    // is created, not when the wait ends.
    {
      const p = spawn(process.execPath, [HOOK], {
        env: { ...process.env, HOME: home, USERPROFILE: home, AAP_TIMEOUT: '30' },
      });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.stdin.end(JSON.stringify({ ...DEFAULT_EVENT, session_id: SESSION }));

      // Wait until the row exists, then kill the way no handler can catch.
      for (let i = 0; i < 60 && !/sent Bash/.test(err); i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      p.kill('SIGKILL');
      await new Promise((r) => p.on('close', r));

      check('a SIGKILLed hook still leaves its trace', traces().length === 1, err.slice(-200));
      const killed = traces()[0]
        ? JSON.parse(readFileSync(join(traceDir, traces()[0]), 'utf8'))
        : null;
      check('and the trace names the row it belongs to', !!killed?.requestId);

      // Which means the decision made in the terminal can still be recorded.
      if (killed) {
        await run(RECONCILE, {
          ...DEFAULT_EVENT,
          hook_event_name: 'PostToolUse',
          session_id: SESSION,
        });
        check('so the terminal decision is recorded anyway',
          await statusOf(killed.requestId) === 'local_allow');
      }
      // Leave nothing for the cases below.
      for (const f of traces()) rmSync(join(traceDir, f), { force: true });
    }

    /* ---- a request the phone answers leaves nothing behind ---- */
    {
      const hookRun = new Promise((resolve) => {
        const p = spawn(process.execPath, [HOOK], {
          env: { ...process.env, HOME: home, USERPROFILE: home, AAP_TIMEOUT: '30' },
        });
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => resolve(out));
        p.stdin.end(JSON.stringify({ ...DEFAULT_EVENT, session_id: SESSION }));
      });

      let id = null;
      for (let i = 0; i < 60 && !id; i++) {
        await new Promise((r) => setTimeout(r, 150));
        ({ id } = await (await fetch(`http://localhost:${port}/api/pending`, {
          headers: { authorization: 'Bearer verify-device' },
        })).json());
      }
      if (id) {
        await fetch(`http://localhost:${port}/api/decide`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, verdict: 'allow' }),
        });
        await hookRun;
        check('a request the phone answered leaves no trace', traces().length === 0);
        check('and the phone verdict is what the row holds', await statusOf(id) === 'allow');
      }
    }

    /* ---- the tool ran, so the terminal approved it ---- */
    const approved = await unanswered(DEFAULT_EVENT);
    check('an unanswered prompt leaves a trace', !!approved);
    check('and the row carries no decision yet', undecided(approved?.status), approved?.status);
    check('the trace carries no command', !JSON.stringify(approved ?? {}).includes('echo hi'));

    if (approved) {
      // A different tool call in the same session must not settle this one.
      await run(RECONCILE, {
        hook_event_name: 'PostToolUse',
        session_id: SESSION,
        tool_name: 'Bash',
        tool_input: { command: 'echo something else' },
      });
      check('a different tool call does not settle it',
        undecided(await statusOf(approved.requestId)));
      check('and the trace is still waiting', traces().length === 1);

      await run(RECONCILE, {
        hook_event_name: 'PostToolUse',
        ...DEFAULT_EVENT,
        hook_event_name: 'PostToolUse',
        session_id: SESSION,
      });
      check('PostToolUse records it as approved in the terminal',
        await statusOf(approved.requestId) === 'local_allow');
      check('and the trace is cleared', traces().length === 0);
    }

    /* ---- refused in the terminal: only the transcript knows ---- */
    const denied = await unanswered({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
    });
    check('a second unanswered prompt leaves its own trace', !!denied);

    if (denied) {
      // Exactly what Claude Code writes: the tool_use, then the refusal in the
      // user turn that follows it.
      const transcript = join(home, 'transcript.jsonl');
      writeFileSync(transcript, [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'toolu_01', name: 'Bash', input: { command: 'rm -rf /' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{
              type: 'tool_result',
              tool_use_id: 'toolu_01',
              content: "The user doesn't want to proceed with this tool use. The tool use was rejected.",
            }],
          },
        }),
      ].join('\n') + '\n');

      await run(RECONCILE, {
        hook_event_name: 'Stop',
        session_id: SESSION,
        transcript_path: transcript,
      });
      check('Stop reads the refusal out of the transcript',
        await statusOf(denied.requestId) === 'local_deny');
      check('and clears that trace too', traces().length === 0);
    }

    /* ---- an interruption is not a verdict ---- */
    const escaped = await unanswered({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 1' },
    });
    if (escaped) {
      const transcript = join(home, 'interrupted.jsonl');
      writeFileSync(transcript, [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'tool_use', id: 'toolu_02', name: 'Bash', input: { command: 'sleep 1' } }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_02', content: '[Request interrupted by user]' }],
          },
        }),
      ].join('\n') + '\n');

      await run(RECONCILE, { hook_event_name: 'Stop', session_id: SESSION, transcript_path: transcript });
      check('an interrupted prompt is left undecided, not denied',
        undecided(await statusOf(escaped.requestId)));
      // SessionEnd is the last word: nothing else will ever explain this row.
      await run(RECONCILE, { hook_event_name: 'SessionEnd', session_id: SESSION, transcript_path: transcript });
      check('and SessionEnd stops carrying its trace', traces().length === 0);
    }

    /* ---- a question answered at the keyboard ---- */
    const asked = await unanswered(QUESTION_EVENT);
    if (asked) {
      await run(RECONCILE, {
        hook_event_name: 'PostToolUse',
        session_id: SESSION,
        tool_name: 'AskUserQuestion',
        tool_input: QUESTION_EVENT.tool_input,
        tool_response: {
          answers: [{ question: 'Which database should we use?', answer: 'Postgres' }],
        },
      });
      check('a question answered in the terminal is recorded as an answer',
        await statusOf(asked.requestId) === 'local_answer');
      // The selection lives on the history row — that is where the phone reads it.
      const { requests } = await (await fetch(`http://localhost:${port}/api/history`, {
        headers: { authorization: 'Bearer verify-device' },
      })).json();
      const row = requests.find((x) => x.id === asked.requestId);
      check('with the selection that was actually made',
        row?.answers?.['Which database should we use?'] === 'Postgres',
        JSON.stringify(row?.answers));
    }

    /* ---- a question picked up by Stop is answered, never approved ---- */
    const lateQuestion = await unanswered(QUESTION_EVENT);
    if (lateQuestion) {
      const transcript = join(home, 'question.jsonl');
      writeFileSync(transcript, [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{
              type: 'tool_use',
              id: 'toolu_03',
              name: 'AskUserQuestion',
              input: QUESTION_EVENT.tool_input,
            }],
          },
        }),
        JSON.stringify({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', tool_use_id: 'toolu_03', content: 'Postgres' }],
          },
        }),
      ].join('\n') + '\n');

      await run(RECONCILE, { hook_event_name: 'Stop', session_id: SESSION, transcript_path: transcript });
      // The transcript can only say the call completed. Filing that as `local_allow`
      // would put a verdict against a prompt that never asked for one.
      check('a completed question is recorded as answered, not approved',
        await statusOf(lateQuestion.requestId) === 'local_answer');
    }

    /* ---- another session's traces are not ours to settle ---- */
    const other = await unanswered(DEFAULT_EVENT);
    if (other) {
      await run(RECONCILE, {
        hook_event_name: 'PostToolUse',
        ...DEFAULT_EVENT,
        hook_event_name: 'PostToolUse',
        session_id: 'a-different-session',
      });
      check('another session cannot settle this one',
        undecided(await statusOf(other.requestId)));
    }
  }

  rmSync(home, { recursive: true, force: true });
  server.kill('SIGKILL');
}

/* ------------------------------------------------------------------ pair codes */

console.log('\npair codes');

// The route is a Deno Edge Function now, so this suite (Node) reads it rather than
// importing it — scripts/verify-api.ts drives the real handler under Deno.
const pairCodeFn = await readFile(
  new URL('../supabase/functions/pair-codes/index.ts', import.meta.url),
  'utf8',
);
check('pair-code route exports a handler', /export const handler = route\(/.test(pairCodeFn));

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
check('alphabet excludes 0/O/1/I/L', !/[0O1IL]/.test(ALPHABET));

/* ------------------------------------------------------- npx-safe vendoring */

// The point of `vendorRuntime` is that the hook keeps working after npm deletes
// the directory setup ran from. So the test does exactly that: vendor out of a
// fake npx cache, delete the cache, and then run the hook from the copy. If
// dependency resolution did not come along, the hook cannot even start.
console.log('\nnpx vendoring');
{
  const { ephemeralInstallReason } = await import('../lib/config.mjs');

  check('an npx cache path is recognised as disposable',
    ephemeralInstallReason('/Users/x/.npm/_npx/abc123/node_modules/tapproval') === 'npx cache');
  check('a global install is not',
    ephemeralInstallReason('/usr/local/lib/node_modules/tapproval') === null);

  const home = mkdtempSync(join(tmpdir(), 'aap-vendor-'));
  const cache = join(home, '.npm', '_npx', 'abc123', 'node_modules');
  const src = join(cache, 'tapproval');
  const prevHome = process.env.HOME;
  try {
    // A miniature npx sandbox: the package, plus one flat sibling dependency.
    mkdirSync(join(src, 'hook'), { recursive: true });
    mkdirSync(join(cache, 'fake-dep'), { recursive: true });
    writeFileSync(join(cache, 'fake-dep', 'package.json'),
      '{"name":"fake-dep","version":"1.0.0","main":"index.js"}');
    writeFileSync(join(cache, 'fake-dep', 'index.js'), 'module.exports = 42;\n');
    writeFileSync(join(src, 'package.json'), '{"name":"tapproval","version":"9.9.9"}');
    // Stands in for permission-hook.mjs: proves it ran, and that it can still
    // resolve a sibling dependency from wherever it ended up.
    writeFileSync(join(src, 'hook', 'permission-hook.mjs'),
      "import { createRequire } from 'node:module';\n"
      + "console.log(createRequire(import.meta.url)('fake-dep'));\n");

    // lib/config.mjs reads homedir() at import time, so the vendor destination has
    // to be computed in a child that was started with HOME already pointing here.
    const vendored = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { vendorRuntime } = await import(${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)});
      process.stdout.write(vendorRuntime(${JSON.stringify(src)}, { name: 'tapproval', version: '9.9.9' }));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf8' });

    check('vendored out of the cache and into HOME',
      vendored.startsWith(join(home, '.tapproval', 'runtime', '9.9.9')), vendored);

    const entry = join(vendored, 'hook', 'permission-hook.mjs');
    check('the hook entry point came along', existsSync(entry));

    // The whole reason this exists.
    rmSync(join(home, '.npm'), { recursive: true, force: true });
    check('the cache it was installed from is gone', !existsSync(src));

    let out = '';
    try {
      out = execFileSync(process.execPath, [entry], { encoding: 'utf8' });
    } catch (e) {
      out = `failed: ${e.message}`;
    }
    check('the hook still runs, and still resolves its dependencies', out.trim() === '42', out.trim());

    // Idempotent: a second call must reuse the copy rather than fail on a source
    // directory that no longer exists.
    const again = execFileSync(process.execPath, ['--input-type=module', '-e', `
      const { vendorRuntime } = await import(${JSON.stringify(new URL('../lib/config.mjs', import.meta.url).href)});
      process.stdout.write(vendorRuntime(${JSON.stringify(src)}, { name: 'tapproval', version: '9.9.9' }));
    `], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    check('vendoring again is a no-op, not a re-copy', again === vendored);
  } finally {
    process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  }
}

/* ------------------------------------------------- settings.json is not ours */

/**
 * Uninstall touches the one file the user cannot afford to lose, so the invariant
 * is narrow: remove our hook entries, and nothing else — not their events, not
 * their groups, not their matchers, and not a hook of theirs that happens to sit
 * in the same group as one of ours.
 */
console.log('\nuninstall leaves foreign hooks alone');
{
  const home = mkdtempSync(join(tmpdir(), 'aap-settings-'));
  try {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const file = join(home, '.claude', 'settings.json');
    const original = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)', 'Read'], deny: ['Bash(rm:*)'] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node /me/prompt.mjs' }] }],
        Notification: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node /me/notify.mjs', timeout: 5 }] }],
        // Second group shares an event with ours; the third case below plants one
        // of our commands *inside* one of their groups.
        Stop: [{ hooks: [{ type: 'command', command: 'node /me/stop.mjs' }] }],
      },
    };
    const settings = () => JSON.parse(execFileSync('cat', [file], { encoding: 'utf8' }));
    const run = (...args) => execFileSync(
      process.execPath, [join(ROOT, 'scripts', 'install-hook.mjs'), ...args],
      { env: { ...process.env, HOME: home }, encoding: 'utf8' },
    );

    writeFileSync(file, JSON.stringify(original, null, 2));
    run();
    run();                       // twice: installing must not stack duplicates
    const installed = settings();
    check('install does not disturb their hooks',
      JSON.stringify(installed.hooks.UserPromptSubmit) === JSON.stringify(original.hooks.UserPromptSubmit)
      && JSON.stringify(installed.hooks.Notification) === JSON.stringify(original.hooks.Notification));
    check('installing twice does not duplicate ours',
      installed.hooks.PermissionRequest.length === 1);

    run('--remove');
    const removed = settings();
    check('remove restores the file exactly', JSON.stringify(removed) === JSON.stringify(original),
      JSON.stringify(removed.hooks));

    // A group holding both their command and ours. Dropping the group whole would
    // take `also-mine.mjs` with it — and would look like a clean uninstall.
    const shared = JSON.parse(JSON.stringify(original));
    shared.hooks.Stop.push({
      matcher: 'shared',
      hooks: [
        { type: 'command', command: 'node /me/also-mine.mjs' },
        { type: 'command', command: 'node /wherever/hook/reconcile-hook.mjs', timeout: 20 },
      ],
    });
    writeFileSync(file, JSON.stringify(shared, null, 2));
    run('--remove');
    const mixed = settings();
    const sharedGroup = (mixed.hooks?.Stop ?? []).find((g) => g.matcher === 'shared');
    check('a hook sharing a group with ours survives',
      !!sharedGroup && JSON.stringify(sharedGroup.hooks) ===
        JSON.stringify([{ type: 'command', command: 'node /me/also-mine.mjs' }]),
      JSON.stringify(mixed.hooks?.Stop));
    check('and ours is gone from it',
      !JSON.stringify(mixed).includes('reconcile-hook.mjs'));

    // Nothing of ours anywhere: a no-op, not an edit.
    writeFileSync(file, JSON.stringify(original, null, 2));
    run('--remove');
    check('remove with nothing installed changes nothing',
      JSON.stringify(settings()) === JSON.stringify(original));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/* ---------------------------------------------------------------------------- */

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
