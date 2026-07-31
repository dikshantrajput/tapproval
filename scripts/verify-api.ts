#!/usr/bin/env -S deno run -A
/**
 * Drives all seven hosted API routes end to end against an in-memory PostgREST
 * shim, so the whole flow — register, mint a code, claim it, notify, decide — is
 * exercised without a Supabase project.
 *
 *   deno run -A scripts/verify-api.ts        (or: npm test)
 *
 * This runs under Deno on purpose. The routes are Edge Functions now, so the
 * suite exercises the real runtime: Web Crypto HMAC for the Realtime JWT, Web
 * Crypto SHA-256 for the token hashes, `Request`/`Response` for the wire. Each
 * function exports its `handler` and only calls `Deno.serve` when AAP_NO_SERVE is
 * unset, which is how the same file can be both a deployed function and an
 * importable unit under test.
 *
 * The shim implements only what _shared/db.ts actually sends through
 * @supabase/supabase-js: eq / is.null / gt / gte filters, order, limit, select,
 * PATCH-with-filter returning the updated rows, HEAD for the health probe's
 * count, and the `vnd.pgrst.object+json` Accept that `.single()` sets. It is a
 * test double, not a Postgres — but the filters it enforces are exactly the ones
 * the security properties rest on, so a handler that forgets to scope a query
 * fails here.
 */

let failures = 0;
const check = (name: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '  ✓' : '  ✗'} ${name}${detail && !pass ? ` — ${detail}` : ''}`);
  if (!pass) failures++;
};

/* ------------------------------------------------------------ PostgREST shim */

type Row = Record<string, any>;
const tables: Record<string, Row[]> = { devices: [], phones: [], pair_codes: [], requests: [] };

const matches = (row: Row, params: [string, string][]) => {
  for (const [col, expr] of params) {
    if (['select', 'order', 'limit', 'offset', 'columns', 'on_conflict'].includes(col)) continue;
    const [op, ...rest] = expr.split('.');
    const val = rest.join('.');
    const cell = row[col];
    if (op === 'eq' && String(cell) !== val) return false;
    if (op === 'is' && val === 'null' && cell != null) return false;
    if (op === 'gt' && !(new Date(cell) > new Date(val))) return false;
    if (op === 'gte' && !(new Date(cell) >= new Date(val))) return false;
    // `in.(a,b,c)` — /api/local-decide is conditional on several current statuses
    // at once, and the whole point of that condition is that it cannot overwrite a
    // verdict. An unenforced filter here would make the test double weaker than
    // Postgres and hide exactly that bug.
    if (op === 'in') {
      const list = val.replace(/^\(|\)$/g, '').split(',').map((v) => v.replace(/^"|"$/g, ''));
      if (!list.includes(String(cell))) return false;
    }
  }
  return true;
};

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const pg = Deno.serve({ port: 0, hostname: '127.0.0.1', onListen: () => {} }, async (req) => {
  const url = new URL(req.url);
  const table = url.pathname.replace('/rest/v1/', '');
  const params = [...url.searchParams.entries()] as [string, string][];
  const rows = tables[table];
  if (!rows) {
    return jsonRes(
      { code: '42P01', message: `relation "public.${table}" does not exist` },
      404,
    );
  }

  // What `.single()` sets. PostgREST answers with a bare object, not an array.
  const wantsObject = (req.headers.get('accept') ?? '').includes('vnd.pgrst.object+json');
  const one = (out: Row[], status = 200) =>
    wantsObject
      ? (out.length === 1
        ? jsonRes(out[0], status)
        : jsonRes({ code: 'PGRST116', message: `${out.length} rows returned` }, 406))
      : jsonRes(out, status);

  // The health probe: `select('*', { count: 'exact', head: true })`. Body-less,
  // the count rides in Content-Range.
  if (req.method === 'HEAD') {
    const n = rows.filter((r) => matches(r, params)).length;
    return new Response(null, {
      status: 200,
      headers: { 'content-range': `0-${Math.max(n - 1, 0)}/${n}` },
    });
  }

  if (req.method === 'GET') {
    let out = rows.filter((r) => matches(r, params));
    const order = url.searchParams.get('order');
    if (order) {
      const [col, dir] = order.split('.');
      out = [...out].sort((a, b) =>
        (dir === 'desc' ? -1 : 1) * String(a[col]).localeCompare(String(b[col])));
    }
    const limit = Number(url.searchParams.get('limit'));
    if (limit) out = out.slice(0, limit);
    return one(out);
  }

  if (req.method === 'POST') {
    const row = await req.json();
    // Unique constraints the handlers rely on.
    const uniq = ({
      devices: 'machine_token_hash',
      phones: 'phone_token_hash',
      pair_codes: 'code',
    } as Record<string, string>)[table];
    if (uniq && rows.some((r) => r[uniq] === row[uniq])) {
      return jsonRes(
        { code: '23505', message: `duplicate key value violates unique constraint on ${uniq}` },
        409,
      );
    }
    const full = {
      id: crypto.randomUUID(),
      created_at: new Date().toISOString(),
      status: 'pending',
      ...row,
    };
    rows.push(full);
    return one([full], 201);
  }

  if (req.method === 'PATCH') {
    const patch = await req.json();
    const hit = rows.filter((r) => matches(r, params));
    for (const r of hit) Object.assign(r, patch);
    return one(hit);
  }

  return jsonRes({ code: '42883', message: 'method not allowed' }, 405);
});

const PG_PORT = (pg.addr as Deno.NetAddr).port;

Deno.env.set('AAP_NO_SERVE', '1');          // import the handlers, don't bind a port
Deno.env.set('SUPABASE_URL', `http://127.0.0.1:${PG_PORT}`);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test');
Deno.env.set('SUPABASE_ANON_KEY', 'anon-test');
Deno.env.set('SUPABASE_JWT_SECRET', 'jwt-secret-test');
Deno.env.set('ONESIGNAL_APP_ID', 'app-test');
Deno.env.set('DRY_RUN', '1');               // no real push
Deno.env.set('PUBLIC_BASE_URL', 'https://example.test');

/* ------------------------------------------------------- call a route directly */

const F = '../supabase/functions';
const routes: Record<string, (req: Request) => Promise<Response>> = {
  devices: (await import(`${F}/devices/index.ts`)).handler,
  'pair-codes': (await import(`${F}/pair-codes/index.ts`)).handler,
  claim: (await import(`${F}/claim/index.ts`)).handler,
  notify: (await import(`${F}/notify/index.ts`)).handler,
  decide: (await import(`${F}/decide/index.ts`)).handler,
  cancel: (await import(`${F}/cancel/index.ts`)).handler,
  'local-decide': (await import(`${F}/local-decide/index.ts`)).handler,
  request: (await import(`${F}/request/index.ts`)).handler,
  health: (await import(`${F}/health/index.ts`)).handler,
};

interface CallOpts {
  method?: string;
  body?: unknown;
  token?: string;
  query?: string;
}

/** Builds the same Request the Vercel proxy would forward to the function. */
async function call(
  name: string,
  { method = 'POST', body, token, query = '' }: CallOpts = {},
): Promise<{ status: number; body: any }> {
  const req = new Request(`https://example.test/api/${name}${query}`, {
    method,
    headers: {
      'user-agent': 'verify/1.0',
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined || method === 'GET' ? {} : { body: JSON.stringify(body) }),
  });
  const res = await routes[name](req);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// lib/crypto.mjs is Node code that leans on the global Buffer, which Deno does not
// define for a plain ES module. Hand it the real one rather than forking the file:
// the whole point is that the CLI's encryption and the phone's decryption are the
// same bytes.
(globalThis as any).Buffer ??= (await import('node:buffer')).Buffer;
const { newPayloadKey, encryptPayload, decryptPayload } = await import('../lib/crypto.mjs');

const b64urlJson = (s: string) =>
  JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));

/* ------------------------------------------------------------------ the flow */

console.log('\nregister');

const reg = await call('devices', { body: { label: 'laptop-a' } });
check('POST /api/devices → 200', reg.status === 200, JSON.stringify(reg));
const machineToken = reg.body?.machine_token;
const deviceId = reg.body?.device_id;
check('returns a machine token and device id', !!machineToken && !!deviceId);
check(
  'the token is not stored, only its hash',
  !JSON.stringify(tables.devices).includes(machineToken ?? 'x'),
);
check('anon key is handed over for Realtime', reg.body?.supabase_anon_key === 'anon-test');

console.log('\npair codes');

const key = newPayloadKey();
const noAuth = await call('pair-codes', { body: { payload_key: key } });
check('unauthenticated → 401', noAuth.status === 401);

const noKey = await call('pair-codes', { token: machineToken, body: {} });
check('missing payload key → 400', noKey.status === 400);

const codeRes = await call('pair-codes', { token: machineToken, body: { payload_key: key } });
check('authenticated → 200', codeRes.status === 200, JSON.stringify(codeRes));
const code = codeRes.body?.code;
check(
  'code is 6 chars from the safe alphabet',
  /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/.test(code ?? ''),
);
check('ttl is 120s', codeRes.body?.ttl === 120);

console.log('\nclaim');

const claim1 = await call('claim', { body: { code } });
check('first claim → 200', claim1.status === 200, JSON.stringify(claim1));
const phoneToken = claim1.body?.phone_token;
check('hands over the payload key', claim1.body?.payload_key === key);
check('and this phone’s own token', !!phoneToken && phoneToken !== machineToken);
check(
  'the key is deleted from the server immediately',
  tables.pair_codes[0].payload_key === null,
  String(tables.pair_codes[0].payload_key),
);

const claim2 = await call('claim', { body: { code } });
check('a claimed code cannot be reused → 410', claim2.status === 410, JSON.stringify(claim2));

// An expired code, aged by hand.
const expiredRes = await call('pair-codes', { token: machineToken, body: { payload_key: key } });
const expired = tables.pair_codes.find((c) => c.code === expiredRes.body.code)!;
expired.expires_at = new Date(Date.now() - 1000).toISOString();
check(
  'an expired code is rejected → 410',
  (await call('claim', { body: { code: expired.code } })).status === 410,
);

console.log('\nnotify');

const ciphertext = encryptPayload(key, { summary: 'rm -rf /', detail: 'rm -rf /', cwd: '/tmp' });

check(
  'unauthenticated notify → 401',
  (await call('notify', { body: { tool: 'Bash', payload_ciphertext: ciphertext } })).status === 401,
);
check(
  'notify without ciphertext → 400',
  (await call('notify', { token: machineToken, body: { tool: 'Bash' } })).status === 400,
);

const notified = await call('notify', {
  token: machineToken,
  body: { tool: 'Bash', payload_ciphertext: ciphertext, timeout_sec: 60 },
});
check('notify → 200', notified.status === 200, JSON.stringify(notified));
const requestId = notified.body?.request_id;
check('returns a realtime token', typeof notified.body?.realtime_token === 'string');
check('the realtime token is device-scoped', (() => {
  const claims = b64urlJson(notified.body.realtime_token.split('.')[1]);
  return claims.device_id === deviceId && claims.role === 'authenticated' && claims.exp > claims.iat;
})());
check('and its ttl is clamped to the wait', (() => {
  const claims = b64urlJson(notified.body.realtime_token.split('.')[1]);
  return claims.exp - claims.iat === 120;      // 60s wait + 60s margin, inside [60,900]
})());
check(
  'the stored row holds no plaintext',
  !JSON.stringify(tables.requests).includes('rm -rf'),
);

console.log('\nread');

const asPhone = await call('request', { method: 'GET', token: phoneToken, query: `?id=${requestId}` });
check(
  'phone can read its own request',
  asPhone.status === 200 && asPhone.body.id === requestId,
  JSON.stringify(asPhone),
);
check('and gets the ciphertext to decrypt', asPhone.body?.payload_ciphertext === ciphertext);

const asMachine = await call('request', { method: 'GET', token: machineToken, query: `?id=${requestId}` });
check(
  'hook can poll the same row (fallback path)',
  asMachine.status === 200 && asMachine.body.status === 'pending',
);

const pending = await call('request', { method: 'GET', token: phoneToken, query: '?pending=1' });
check('pending=1 finds it (the iOS recovery path)', pending.body?.id === requestId, JSON.stringify(pending));
check(
  'pending=1 refuses a machine token',
  (await call('request', { method: 'GET', token: machineToken, query: '?pending=1' })).status === 403,
);

console.log('\ncross-tenant isolation');

const regB = await call('devices', { body: { label: 'laptop-b' } });
const tokenB = regB.body.machine_token;
const codeB = (await call('pair-codes', { token: tokenB, body: { payload_key: newPayloadKey() } })).body.code;
const phoneB = (await call('claim', { body: { code: codeB } })).body.phone_token;

check(
  "device B's machine token cannot read A's request",
  (await call('request', { method: 'GET', token: tokenB, query: `?id=${requestId}` })).status === 404,
);
check(
  "phone B cannot read A's request",
  (await call('request', { method: 'GET', token: phoneB, query: `?id=${requestId}` })).status === 404,
);
const stolen = await call('decide', { token: phoneB, body: { id: requestId, verdict: 'allow' } });
check("phone B cannot decide A's request", stolen.status === 404, JSON.stringify(stolen));
check(
  'and A’s request is untouched',
  tables.requests.find((r) => r.id === requestId)!.status === 'pending',
);

console.log('\ndecide');

check(
  'unauthenticated decide → 401',
  (await call('decide', { body: { id: requestId, verdict: 'allow' } })).status === 401,
);

const decided = await call('decide', { token: phoneToken, body: { id: requestId, verdict: 'allow', note: 'ok' } });
check('phone A decides → applied', decided.status === 200 && decided.body.applied === true, JSON.stringify(decided));
check(
  'the row records which phone answered',
  tables.requests.find((r) => r.id === requestId)!.decided_by === claim1.body.phone_id,
);

const again = await call('decide', { token: phoneToken, body: { id: requestId, verdict: 'allow' } });
check('the same verdict twice is still applied (sw + page race)', again.body?.applied === true);

const flip = await call('decide', { token: phoneToken, body: { id: requestId, verdict: 'deny' } });
check(
  'a different verdict afterwards is not applied',
  flip.body?.applied === false && flip.body?.status === 'allow',
  JSON.stringify(flip),
);

console.log('\nanswers (AskUserQuestion)');

// A question travels as the same opaque blob; what comes back is a second one. The
// server stores and forwards both and can read neither.
{
  const questionBlob = encryptPayload(key, {
    summary: 'Which database?',
    detail: 'Which database?\n  • Postgres\n  • SQLite',
    cwd: '/tmp',
    questions: [{
      question: 'Which database?',
      header: 'Database',
      multiSelect: false,
      options: [{ label: 'Postgres', description: '' }, { label: 'SQLite', description: '' }],
    }],
  });

  const asked = await call('notify', {
    token: machineToken,
    body: { tool: 'AskUserQuestion', payload_ciphertext: questionBlob, timeout_sec: 60 },
  });
  const askId = asked.body?.request_id;
  check('a question notifies like anything else', asked.status === 200, JSON.stringify(asked));
  check(
    'the stored row holds no option labels',
    !JSON.stringify(tables.requests).includes('SQLite'),
  );

  check(
    'answer without a ciphertext → 400',
    (await call('decide', { token: phoneToken, body: { id: askId, verdict: 'answer' } })).status === 400,
  );

  const answerBlob = encryptPayload(key, { answers: { 0: ['SQLite'] } });
  const answered = await call('decide', {
    token: phoneToken,
    body: { id: askId, verdict: 'answer', answer_ciphertext: answerBlob },
  });
  check(
    'answer → applied, status answer',
    answered.status === 200 && answered.body.applied === true && answered.body.status === 'answer',
    JSON.stringify(answered),
  );
  check(
    'the selection is stored sealed, not in the clear',
    !JSON.stringify(tables.requests).includes('SQLite'),
  );

  // The hook's polling fallback reads the answer from here, so this route has to
  // hand it back or a dead websocket loses the selection entirely.
  const polled = await call('request', { method: 'GET', token: machineToken, query: `?id=${askId}` });
  check(
    'the hook can poll the answer back',
    polled.body?.status === 'answer' && polled.body?.answer_ciphertext === answerBlob,
    JSON.stringify(polled.body).slice(0, 160),
  );
  check(
    'and only the payload key opens it',
    decryptPayload(key, polled.body.answer_ciphertext).answers['0'][0] === 'SQLite',
  );
  check('a wrong key cannot', (() => {
    try { decryptPayload(newPayloadKey(), polled.body.answer_ciphertext); return false; } catch { return true; }
  })());

  const flipAnswer = await call('decide', {
    token: phoneToken,
    body: { id: askId, verdict: 'allow' },
  });
  check(
    'a verdict afterwards cannot overwrite the answer',
    flipAnswer.body?.applied === false && flipAnswer.body?.status === 'answer',
    JSON.stringify(flipAnswer),
  );
}

console.log('\nexpiry');

const late = await call('notify', {
  token: machineToken,
  body: { tool: 'Bash', payload_ciphertext: ciphertext, timeout_sec: 30 },
});
const lateRow = tables.requests.find((r) => r.id === late.body.request_id)!;
lateRow.expires_at = new Date(Date.now() - 1000).toISOString();

const lateTap = await call('decide', { token: phoneToken, body: { id: lateRow.id, verdict: 'allow' } });
check('a late tap is not applied', lateTap.body?.applied === false, JSON.stringify(lateTap));
check('and the phone is told "expired", not "allow"', lateTap.body?.status === 'expired');
check('the row is settled as expired', lateRow.status === 'expired');

console.log('\ncancel');

// The laptop withdrawing a question it has stopped listening to — the terminal
// took the prompt instead. Without it the row stays pending and the phone shows
// live Approve/Deny buttons for something already answered elsewhere.
const open = await call('notify', {
  token: machineToken,
  body: { tool: 'Bash', payload_ciphertext: ciphertext, timeout_sec: 120 },
});
const openId = open.body.request_id;

check(
  'unauthenticated cancel → 401',
  (await call('cancel', { body: { id: openId } })).status === 401,
);
check(
  'the phone cannot withdraw a request (machineToken only)',
  (await call('cancel', { token: phoneToken, body: { id: openId } })).status === 401,
);
check(
  "another device's machineToken cannot withdraw it",
  (await call('cancel', { token: tokenB, body: { id: openId } })).status === 404,
);
check('and it is still pending', tables.requests.find((r) => r.id === openId)!.status === 'pending');

const cancelled = await call('cancel', { token: machineToken, body: { id: openId } });
check(
  'the owning machine withdraws it',
  cancelled.status === 200 && cancelled.body.cancelled === true
    && cancelled.body.status === 'cancelled',
  JSON.stringify(cancelled),
);

const tapAfter = await call('decide', { token: phoneToken, body: { id: openId, verdict: 'allow' } });
check(
  'a tap afterwards is not applied',
  tapAfter.body?.applied === false && tapAfter.body?.status === 'cancelled',
  JSON.stringify(tapAfter),
);
check(
  'so the phone can render "no longer waiting" instead of Approve/Deny',
  (await call('request', { method: 'GET', token: phoneToken, query: `?id=${openId}` }))
    .body?.status === 'cancelled',
);

// The other order: the phone won. A verdict must never be overwritten by the
// hook's own cleanup, or an approval the agent already acted on would vanish.
const raced = await call('notify', {
  token: machineToken,
  body: { tool: 'Bash', payload_ciphertext: ciphertext, timeout_sec: 120 },
});
await call('decide', { token: phoneToken, body: { id: raced.body.request_id, verdict: 'allow' } });
const lostRace = await call('cancel', { token: machineToken, body: { id: raced.body.request_id } });
check(
  'cancel never overwrites a verdict that already landed',
  lostRace.body?.cancelled === false && lostRace.body?.status === 'allow',
  JSON.stringify(lostRace),
);

check(
  'a malformed id is a 404, not a 500',
  (await call('cancel', { token: machineToken, body: { id: 'not-a-uuid' } })).status === 404,
);

console.log('\nlocal-decide');

// The other half of the history: the prompt fell through to the terminal, and the
// laptop reports what was decided there. Without it every terminal-answered prompt
// — which is most of them — stays `cancelled` and carries no verdict at all.
{
  const openRow = async (tool = 'Bash') => (await call('notify', {
    token: machineToken,
    body: { tool, payload_ciphertext: ciphertext, timeout_sec: 120 },
  })).body.request_id;

  const withdrawn = await openRow();
  await call('cancel', { token: machineToken, body: { id: withdrawn } });

  check(
    'unauthenticated local-decide → 401',
    (await call('local-decide', { body: { id: withdrawn, outcome: 'allow' } })).status === 401,
  );
  check(
    'a phone cannot report a terminal decision (machineToken only)',
    (await call('local-decide', { token: phoneToken, body: { id: withdrawn, outcome: 'allow' } })).status === 401,
  );
  check(
    "another device's machineToken cannot touch it",
    (await call('local-decide', { token: tokenB, body: { id: withdrawn, outcome: 'allow' } })).status === 404,
  );
  check(
    'an unknown outcome is a 400, not a stored status',
    (await call('local-decide', { token: machineToken, body: { id: withdrawn, outcome: 'maybe' } })).status === 400,
  );

  const settled = await call('local-decide', {
    token: machineToken,
    body: { id: withdrawn, outcome: 'allow', note: 'Approved in the terminal' },
  });
  check(
    'a withdrawn request can be settled as approved-in-the-terminal',
    settled.status === 200 && settled.body.applied === true && settled.body.status === 'local_allow',
    JSON.stringify(settled),
  );
  const row = tables.requests.find((r) => r.id === withdrawn)!;
  check('the row says where it was decided', row.decided_on === 'terminal');
  check('and no phone is credited for it', row.decided_by == null);

  // Reporting twice is normal — PostToolUse and Stop can both see the same call.
  const twice = await call('local-decide', { token: machineToken, body: { id: withdrawn, outcome: 'allow' } });
  check('reporting the same outcome twice is a no-op success',
    twice.body?.applied === true && twice.body?.status === 'local_allow', JSON.stringify(twice));

  // And it must never be able to rewrite itself into something else.
  const flipLocal = await call('local-decide', { token: machineToken, body: { id: withdrawn, outcome: 'deny' } });
  check('a settled row cannot be flipped',
    flipLocal.body?.applied === false && flipLocal.body?.status === 'local_allow',
    JSON.stringify(flipLocal));

  // The race that matters: the phone tapped Approve a moment before the prompt
  // fell through. The agent has already acted on that; it cannot be overwritten.
  const tapped = await openRow();
  await call('decide', { token: phoneToken, body: { id: tapped, verdict: 'allow' } });
  const loses = await call('local-decide', { token: machineToken, body: { id: tapped, outcome: 'deny' } });
  check(
    'a phone verdict always wins over a terminal report',
    loses.body?.applied === false && loses.body?.status === 'allow',
    JSON.stringify(loses),
  );

  // A question answered at the keyboard: the selection travels sealed, exactly as
  // it does coming back from the phone.
  const asked = await openRow('AskUserQuestion');
  await call('cancel', { token: machineToken, body: { id: asked } });
  check(
    'an answer with no selection attached is refused',
    (await call('local-decide', { token: machineToken, body: { id: asked, outcome: 'answer' } })).status === 400,
  );
  const sealed = encryptPayload(key, { answers: { 'Which database?': 'Postgres' } });
  const answered = await call('local-decide', {
    token: machineToken,
    body: { id: asked, outcome: 'answer', answer_ciphertext: sealed },
  });
  check('a question answered in the terminal is recorded',
    answered.body?.status === 'local_answer', JSON.stringify(answered));
  const askedRow = tables.requests.find((r) => r.id === asked)!;
  check('the selection is stored as ciphertext the server cannot read',
    !JSON.stringify(askedRow).includes('Postgres'));
  check('and it decrypts on this machine to what was chosen',
    decryptPayload(key, askedRow.answer_ciphertext).answers['Which database?'] === 'Postgres');

  check(
    'a malformed id is a 404, not a 500',
    (await call('local-decide', { token: machineToken, body: { id: 'not-a-uuid', outcome: 'allow' } })).status === 404,
  );
}

console.log('\nhealth');

const health = await call('health', { method: 'GET' });
check('GET /api/health probes every table', Object.values(health.body.tables).every((v) => v === 'ok'),
  JSON.stringify(health.body.tables));
check('reports env presence as booleans only',
  Object.values(health.body.env).every((v) => typeof v === 'boolean'));
check('and echoes no secret value',
  !JSON.stringify(health.body).includes('service-role-test'));
check('missing secrets keep it not-ready',
  health.body.ready === false && health.body.env.ONESIGNAL_API_KEY === false);

console.log('\nmethod + preflight');

check('GET on a POST route → 405',
  (await call('notify', { method: 'GET', token: machineToken })).status === 405);
check('OPTIONS preflight allows the Authorization header', await (async () => {
  const res = await routes.decide(new Request('https://example.test/api/decide', { method: 'OPTIONS' }));
  return res.status === 204
    && /authorization/i.test(res.headers.get('access-control-allow-headers') ?? '');
})());

/* ---------------------------------------------------------------------------- */

await pg.shutdown();
console.log(failures ? `\n${failures} check(s) failed\n` : '\nall API checks passed\n');
Deno.exit(failures ? 1 : 0);
