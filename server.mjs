import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(ROOT, 'public');

const {
  ONESIGNAL_APP_ID,
  ONESIGNAL_API_KEY,
  PUBLIC_URL,
  DEVICE_ID,
  PORT = 8787,
} = process.env;

const required = process.env.DRY_RUN === '1'
  ? { PUBLIC_URL, DEVICE_ID }
  : { ONESIGNAL_APP_ID, ONESIGNAL_API_KEY, PUBLIC_URL, DEVICE_ID };

for (const [k, v] of Object.entries(required)) {
  if (!v) { console.error(`Missing env var: ${k} (copy .env.example to .env)`); process.exit(1); }
}

// POC store. Swap for Supabase by replacing these three helpers — the rest
// of the file only touches getReq/putReq/decide.
const requests = new Map();
const putReq = (r) => requests.set(r.id, r);

/** Lazily flips pending → expired once the hook has stopped listening. */
const getReq = (id) => {
  const r = requests.get(id);
  if (r && r.status === 'pending' && Date.now() > r.expiresAt) r.status = 'expired';
  return r;
};

/**
 * Returns the row. Caller compares `r.status` to the requested verdict to
 * learn whether it was applied — an expired or already-decided request is
 * returned untouched.
 */
const decide = (id, status, note, answers) => {
  const r = getReq(id);
  if (!r || r.status !== 'pending') return r ?? null;
  r.status = status;
  r.note = note ?? null;
  // Only ever set for `answer` (AskUserQuestion): which options were picked.
  if (answers) r.answers = answers;
  r.decidedAt = Date.now();
  return r;
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
};
const html = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};
const readBody = async (req) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { return {}; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendPush(reqRow) {
  if (process.env.DRY_RUN === '1') {
    console.log(`\n[dry-run] ── notification preview ──────────────────────`);
    console.log(`[dry-run]   title: Approve ${reqRow.tool}?`);
    console.log(`[dry-run]   body:  ${reqRow.summary || '(empty!)'}`);
    console.log(`[dry-run]   detail:`);
    console.log((reqRow.detail || '(empty!)').split('\n').map((l) => `[dry-run]     ${l}`).join('\n'));
    if (reqRow.cwd) console.log(`[dry-run]   cwd:   ${reqRow.cwd}`);
    console.log(`[dry-run] ── answer here ───────────────────────────────`);
    console.log(`[dry-run]   page:  ${PUBLIC_URL}/r/${reqRow.id}`);
    if (reqRow.questions?.length) {
      // No verdict links: a question is answered by picking an option on the page.
      console.log(`[dry-run]   (question — pick an option on the page)\n`);
    } else {
      console.log(`[dry-run]   allow: ${PUBLIC_URL}/d/${reqRow.id}/allow`);
      console.log(`[dry-run]   deny:  ${PUBLIC_URL}/d/${reqRow.id}/deny\n`);
    }
    return { dryRun: true };
  }

  // A question has no allow/deny answer, so it gets neither the wording nor the
  // inline buttons — the only way to answer it is the option list on the page.
  const asking = Boolean(reqRow.questions?.length);

  const body = {
    app_id: ONESIGNAL_APP_ID,
    target_channel: 'push',
    include_aliases: { external_id: [reqRow.deviceId] },
    headings: { en: asking ? 'Claude needs your answer' : `Approve ${reqRow.tool}?` },
    contents: { en: reqRow.summary.slice(0, 180) },
    // Tapping the notification body (the only option on iOS) opens the
    // full-detail page with Approve / Deny buttons.
    url: `${PUBLIC_URL}/r/${reqRow.id}`,
    // Carried to the service worker so it can answer without opening a
    // window. web_push_topic becomes the notification tag — a fallback in
    // case OneSignal reshapes `data`.
    data: { request_id: reqRow.id },
    web_push_topic: reqRow.id,
    chrome_web_icon: `${PUBLIC_URL}/icon-192.png`,
    chrome_web_badge: `${PUBLIC_URL}/favicon-32.png`,
    // Chrome/Android render these inline. Max 2. iOS ignores them.
    // Icons rather than emoji in the label: Chrome draws the icon at full colour
    // beside the text, where an emoji has to compete with it for the same width.
    ...(asking ? {} : {
      web_buttons: [
        {
          id: 'allow',
          text: 'Approve',
          icon: `${PUBLIC_URL}/action-allow.png`,
          url: `${PUBLIC_URL}/d/${reqRow.id}/allow`,
        },
        {
          id: 'deny',
          text: 'Deny',
          icon: `${PUBLIC_URL}/action-deny.png`,
          url: `${PUBLIC_URL}/d/${reqRow.id}/deny`,
        },
      ],
    }),
    // Mirrors the hook's own wait: a notification that outlives it is a button
    // that decides nothing.
    ttl: Math.max(30, Math.min(Math.round((reqRow.expiresAt - Date.now()) / 1000), 600)),
    priority: 10,
  };

  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Key ${ONESIGNAL_API_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OneSignal ${res.status}: ${JSON.stringify(out)}`);
  if (out.errors) console.warn('[onesignal] errors:', out.errors);
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res, name) {
  try {
    const buf = await readFile(join(PUBLIC, name));
    res.writeHead(200, {
      'content-type': MIME[extname(name)] ?? 'application/octet-stream',
      // The OneSignal service worker must never be cached stale.
      'cache-control': name.includes('Worker') ? 'no-cache' : 'public, max-age=60',
      'service-worker-allowed': '/',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

// Glyphs match the PWA's inline icon set.
const GLYPH = {
  check: '<path d="M4.5 12.5l5 5 10-11" stroke-width="2.4"/>',
  x: '<path d="M6 6l12 12M18 6L6 18" stroke-width="2.4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3.2 2"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7.8a4 4 0 018 0v2.7"/>',
};

const decidedPage = (verdict) => verdict === 'allow'
  ? html_page('Approved', {
      tone: 'ok', glyph: 'check', autoClose: true,
      sub: 'Your machine has been told to go ahead.',
    })
  : html_page('Denied', {
      tone: 'no', glyph: 'x', autoClose: true,
      sub: 'Your machine has been told to stop.',
    });

/**
 * Standalone result page for notification action buttons — same visual
 * language as the PWA (inline CSS, light + dark, safe-area aware).
 */
const html_page = (title, opts = {}) => {
  const { tone = '', glyph = 'lock', sub = '', hint = '', autoClose = false } = opts;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title} / tapproval</title>
<link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<meta name="theme-color" content="#f6f7f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111318" media="(prefers-color-scheme: dark)">
<style>
:root{--bg:#f4f5f8;--surface:#fff;--inset:#f0f2f6;--line:#d8dbe3;--fg:#14161c;--fg-dim:#565c6b;
--ok:#0d6b3d;--ok-soft:#e6f5ec;--danger:#b02121;--danger-soft:#fdeaea;--warn:#8a5000;--warn-soft:#fdf1de}
@media (prefers-color-scheme:dark){:root{--bg:#111318;--surface:#191c23;--inset:#0c0e13;--line:#282d38;
--fg:#eceef3;--fg-dim:#9aa2b2;--ok:#4ade9a;--ok-soft:#10291d;--danger:#ff8b8b;--danger-soft:#2b1517;
--warn:#f5c26b;--warn-soft:#2a2013}}
*{box-sizing:border-box}
body{margin:0;min-height:100dvh;display:flex;flex-direction:column;align-items:center;
justify-content:center;gap:12px;text-align:center;
padding:max(24px,env(safe-area-inset-top)) max(24px,env(safe-area-inset-right)) max(24px,env(safe-area-inset-bottom)) max(24px,env(safe-area-inset-left));
background:var(--bg);color:var(--fg);
font:16px/1.5 -apple-system,BlinkMacSystemFont,system-ui,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
.mark{width:60px;height:60px;border-radius:999px;display:grid;place-items:center;
background:var(--inset);color:var(--fg-dim);border:1px solid var(--line)}
.mark svg{width:30px;height:30px}
.ok .mark{background:var(--ok-soft);color:var(--ok)}
.no .mark{background:var(--danger-soft);color:var(--danger)}
.warn .mark{background:var(--warn-soft);color:var(--warn)}
h1{font:600 22px/1.3 inherit;margin:0;letter-spacing:-.01em}
p{margin:0;max-width:30ch;color:var(--fg-dim);font-size:14.5px}
.terminal{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--inset);
border:1px solid var(--line);border-radius:10px;padding:9px 12px}
</style></head>
<body class="${tone}">
<span class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
stroke-linecap="round" stroke-linejoin="round">${GLYPH[glyph] ?? GLYPH.lock}</svg></span>
<h1>${title}</h1>
${sub ? `<p>${sub}</p>` : ''}
${hint ? `<p class="terminal">${hint}</p>` : ''}
${autoClose ? '<script>setTimeout(()=>window.close(),1400)</script>' : ''}
</body></html>`;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  // Access log — the fastest way to tell "notification button never fired"
  // apart from "server rejected the decision".
  if (!path.startsWith('/api/wait/')) {
    console.log(`[http] ${req.method} ${path}`);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // --- hook → server: create a pending request and push it ------------------
  if (path === '/api/notify' && req.method === 'POST') {
    const b = await readBody(req);
    if (b.device_id !== DEVICE_ID) return json(res, 403, { error: 'bad device_id' });

    const row = {
      id: randomBytes(16).toString('hex'),
      deviceId: DEVICE_ID,
      tool: b.tool ?? 'unknown',
      summary: b.summary ?? '',
      detail: b.detail ?? '',
      cwd: b.cwd ?? '',
      // Present only for AskUserQuestion: the questions and the options to
      // choose between. Its presence is what makes this a choice, not a verdict.
      questions: Array.isArray(b.questions) && b.questions.length ? b.questions : null,
      status: 'pending',
      note: null,
      answers: null,
      createdAt: Date.now(),
      // Mirrors the hook's own wait. Once past this, nobody is listening,
      // so a late tap must not claim success.
      expiresAt: Date.now() + (Number(b.timeout_sec) || 300) * 1000,
      decidedAt: null,
    };
    putReq(row);

    try {
      await sendPush(row);
    } catch (err) {
      console.error('[notify] push failed:', err.message);
      return json(res, 502, { error: 'push_failed', detail: err.message, request_id: row.id });
    }
    console.log(`[notify] ${row.tool}: ${row.summary.slice(0, 80)} → ${row.id}`);
    return json(res, 200, { request_id: row.id });
  }

  // --- hook → server: long-poll for the decision ----------------------------
  if (path.startsWith('/api/wait/') && req.method === 'GET') {
    const id = path.slice('/api/wait/'.length);
    const deadline = Date.now() + Math.min(Number(url.searchParams.get('timeout') ?? 25), 55) * 1000;
    while (Date.now() < deadline) {
      const r = getReq(id);
      if (!r) return json(res, 404, { error: 'unknown request' });
      if (r.status !== 'pending') {
        return json(res, 200, {
          status: r.status,
          note: r.note,
          ...(r.status === 'answer' ? { answers: r.answers ?? {} } : {}),
        });
      }
      await sleep(400);
    }
    return json(res, 200, { status: 'pending' });
  }

  // --- phone → server: the decision ----------------------------------------
  if (path === '/api/decide' && req.method === 'POST') {
    const b = await readBody(req);
    // `answer` carries a selection instead of a verdict, and only for a request
    // that actually asked something — otherwise it degrades to a deny.
    const asking = Boolean(getReq(b.id)?.questions?.length);
    const verdict = b.verdict === 'allow' ? 'allow'
      : (b.verdict === 'answer' && asking) ? 'answer'
      : 'deny';
    const answers = verdict === 'answer' && b.answers && typeof b.answers === 'object'
      ? b.answers
      : null;
    const r = decide(b.id, verdict, b.note, answers);
    if (!r) return json(res, 404, { error: 'unknown request' });
    // Same verdict twice is a success, not a conflict — the service worker
    // and the tapped-through page can both land on the same answer.
    const applied = r.status === verdict;
    console.log(applied
      ? `[decide${b.source === 'sw' ? ':sw' : ''}] ${r.id} → ${r.status}`
      : `[decide] ${r.id} rejected (already ${r.status})`);
    return json(res, 200, { status: r.status, applied });
  }

  // --- hook → server: what the terminal decided ----------------------------
  // The other half of the history. When the phone does not answer, the prompt
  // falls through to the terminal and the row is left saying only that we stopped
  // waiting. The reconcile hook watches what the terminal actually did — the tool
  // ran, or the transcript shows it was refused — and reports it here.
  //
  // Conditional on the row not already carrying a phone verdict, so a tap that
  // landed a moment earlier always wins.
  if (path === '/api/local-decide' && req.method === 'POST') {
    const b = await readBody(req);
    const status = { allow: 'local_allow', deny: 'local_deny', answer: 'local_answer' }[b.outcome];
    if (!status) return json(res, 400, { error: 'bad_outcome' });

    const r = getReq(b.id);
    if (!r) return json(res, 404, { error: 'unknown request' });
    // pending / cancelled / expired all mean "no phone has decided this".
    if (!['pending', 'cancelled', 'expired'].includes(r.status)) {
      console.log(`[local-decide] ${r.id} not applied (already ${r.status})`);
      return json(res, 200, { status: r.status, applied: r.status === status });
    }
    r.status = status;
    r.note = typeof b.note === 'string' ? b.note.slice(0, 500) : null;
    r.decidedOn = 'terminal';
    if (status === 'local_answer') r.answers = b.answers ?? {};
    r.decidedAt = Date.now();
    console.log(`[local-decide] ${r.id} → ${status}`);
    return json(res, 200, { status, applied: true });
  }

  // --- hook → server: withdraw a request nobody is listening to any more ----
  // Fires when the terminal took the prompt instead (answered there, escaped,
  // or the wait ran out). Conditional on still-pending, so a verdict that
  // landed a moment earlier wins and is reported back.
  if (path === '/api/cancel' && req.method === 'POST') {
    const b = await readBody(req);
    const r = getReq(b.id);
    if (!r) return json(res, 404, { error: 'unknown request' });
    if (r.status !== 'pending') {
      console.log(`[cancel] ${r.id} not cancelled (already ${r.status})`);
      return json(res, 200, { status: r.status, cancelled: false });
    }
    r.status = 'cancelled';
    r.decidedAt = Date.now();
    console.log(`[cancel] ${r.id} → cancelled`);
    return json(res, 200, { status: 'cancelled', cancelled: true });
  }

  // Notification action buttons are plain GET links.
  const btn = path.match(/^\/d\/([a-f0-9]{32})\/(allow|deny)$/);
  if (btn) {
    // A question cannot be answered with a verdict. We never attach these buttons
    // to one, but a stale notification could still carry the link — send it to the
    // page that can actually answer rather than recording a meaningless "allow".
    if (getReq(btn[1])?.questions?.length) {
      res.writeHead(302, { location: `/r/${btn[1]}` });
      return res.end();
    }
    const r = decide(btn[1], btn[2]);
    if (!r) return html(res, 404, html_page('Request not found', {
      glyph: 'lock',
      sub: 'It has already been cleared, or it expired some time ago.',
    }));
    if (r.status !== btn[2]) {
      console.log(`[decide:button] ${r.id} rejected (already ${r.status})`);
      return html(res, 409, r.status === 'expired'
        ? html_page('Timed out', {
            tone: 'warn', glyph: 'clock',
            sub: 'This request expired before your answer reached your machine — it was <b>not</b> delivered.',
            hint: 'Answer the prompt in your terminal instead.',
          })
        : r.status === 'cancelled'
        ? html_page('No longer waiting', {
            tone: 'warn', glyph: 'clock',
            sub: 'Your machine stopped waiting for this — it was answered in the terminal, or the prompt was dismissed.',
            hint: 'Nothing was approved or denied from here.',
          })
        : html_page('Already answered', {
            glyph: 'lock',
            sub: 'Something else answered this request first — another device, or your terminal.',
            hint: `Recorded answer: ${{
              allow: 'approved',
              deny: 'denied',
              answer: 'an option was chosen',
              // Settled at the keyboard. Naming the place is the point — without
              // it this page reads as though another phone got there first.
              local_allow: 'approved in the terminal',
              local_deny: 'denied in the terminal',
              local_answer: 'answered in the terminal',
            }[r.status] ?? r.status}`,
          }));
    }
    console.log(`[decide:button] ${r.id} → ${r.status}`);
    return html(res, 200, decidedPage(r.status));
  }

  if (path === '/api/request' && req.method === 'GET') {
    const r = getReq(url.searchParams.get('id'));
    if (!r) return json(res, 404, { error: 'unknown request' });
    return json(res, 200, {
      id: r.id, tool: r.tool, summary: r.summary, detail: r.detail,
      cwd: r.cwd, status: r.status, createdAt: r.createdAt,
      questions: r.questions ?? null,
      // The client renders a countdown from this.
      expiresAt: r.expiresAt,
    });
  }

  // ---- authenticated endpoints -------------------------------------------
  // These enumerate state rather than acting on a single unguessable request
  // id, so they must not be open. Without this, anyone who finds the tunnel
  // can poll /api/pending and approve everything.
  if (path === '/api/pending' || path === '/api/config' || path === '/api/history') {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /i, '');
    if (token !== DEVICE_ID) {
      console.log(`[auth] rejected ${req.method} ${path}`);
      return json(res, 401, { error: 'unauthorized' });
    }
  }

  // Newest still-pending request. Lets the PWA recover when the platform
  // opens it at "/" instead of the notification's target URL (iOS does).
  if (path === '/api/pending' && req.method === 'GET') {
    const pending = [...requests.keys()]
      .map(getReq)                       // side effect: flips stale → expired
      .filter((r) => r.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    return json(res, 200, pending ? { id: pending.id } : { id: null });
  }

  // What this device has been asked recently — the phone's home screen list.
  if (path === '/api/history' && req.method === 'GET') {
    const rows = [...requests.keys()]
      .map(getReq)                       // side effect: flips stale → expired
      .filter(Boolean)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
      .map((r) => ({
        id: r.id, tool: r.tool, summary: r.summary, detail: r.detail,
        cwd: r.cwd, note: r.note ?? null,
        questions: r.questions ?? null, answers: r.answers ?? null,
        status: r.status, createdAt: r.createdAt,
      }));
    return json(res, 200, { requests: rows });
  }

  // Config the PWA needs at runtime. Authenticated above — the device id is
  // echoed back only to a caller that already proved it has it.
  if (path === '/api/config') {
    return json(res, 200, { appId: ONESIGNAL_APP_ID, deviceId: DEVICE_ID });
  }

  // --- static ---------------------------------------------------------------
  // /p/<deviceId> is the QR target: the page lifts the token out of the URL
  // into localStorage, then rewrites to "/app".
  //
  // Self-hosted has no use for the landing page — this server exists to talk to
  // one phone that is already sold on the idea — so "/" is the app here, and
  // /app is served too because that is where the shell rewrites itself to.
  if (path === '/' || path === '/app' || path.startsWith('/r/') || path.startsWith('/p/')) {
    if (await serveStatic(res, 'app.html')) return;
  }
  if (await serveStatic(res, path.replace(/^\//, ''))) return;

  return json(res, 404, { error: 'not found' });
});

server.listen(Number(PORT), () => {
  console.log(`\n  tapproval listening on http://localhost:${PORT}`);
  console.log(`  public url: ${PUBLIC_URL}`);
  console.log(`  pair this phone: ${PUBLIC_URL}/\n`);
});
