# Self-hosting

[← back to the README](../README.md)

---

## Self-hosted mode

Still fully supported, and still the only mode with no third party in the path
at all.

```bash
tapproval setup --self-hosted   # OneSignal creds + tunnel URL
tapproval start                 # run the server (keep it running)
tapproval pair                  # QR to pair your phone
```

What you need to bring:

1. **A free [OneSignal](https://onesignal.com) app** with the Web platform
   enabled. Copy the App ID and REST API Key from Settings → Keys & IDs, set
   the **Site URL** to your public URL, and turn off *Welcome Notification*.
2. **A public HTTPS URL** for your machine:
   - `ngrok http 8787 --url=<your-static>.ngrok-free.app` — claim the one
     free static domain, or the URL changes on every restart and breaks both
     your config and OneSignal's Site URL
   - `cloudflared tunnel --url http://localhost:8787` — no interstitial page

Requests live in memory here, the long-poll replaces Realtime, and the payload is
served from your machine to your phone in the clear over the tunnel — there is no
third party to encrypt it from. The pairing QR carries the device secret, so
don't screenshot that one.

---

## Deploying your own hosted instance

The API is eight Supabase Edge Functions. Vercel runs no code — it serves
`public/` and proxies `/api/*` at the edge.

```bash
supabase link --project-ref <ref>
supabase db push                 # applies supabase/migrations/

# three secrets, and nothing else
supabase secrets set \
  AAP_JWT_SECRET="$JWT_SECRET" \
  ONESIGNAL_APP_ID=… \
  ONESIGNAL_API_KEY=… \
  PUBLIC_BASE_URL=https://your-app.vercel.app

supabase functions deploy        # all eight, from supabase/functions/
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are injected
into every Edge Function automatically — do not set them.

| Secret | |
|---|---|
| `AAP_JWT_SECRET` | your project's JWT secret (Settings → API → JWT Secret): signs the device-scoped Realtime token. The one Supabase value that is *not* injected, and it cannot be called `SUPABASE_JWT_SECRET` here because `supabase secrets set` reserves the `SUPABASE_` prefix. The functions read either name, so `.env` and `functions serve --env-file` can keep using the dashboard's. Without it `/api/notify` 500s and every approval degrades to the hook's polling fallback |
| `ONESIGNAL_APP_ID` / `ONESIGNAL_API_KEY` | one app, all tenants |
| `PUBLIC_BASE_URL` | **the Vercel domain**, not the functions domain — it builds the URLs inside a push, and `<ref>.supabase.co` serves no HTML |
| `DRY_RUN` | optional; `1` logs the decision URLs instead of pushing |

Then the static side:

```bash
# vercel.json — replace the placeholder with your project ref
"destination": "https://<ref>.supabase.co/functions/v1/:path*"
vercel deploy --prod
```

That rewrite is load-bearing, not cosmetic: `public/OneSignalSDKWorker.js` calls
`fetch('/api/decide')` from inside the service worker and has to stay
same-origin. Everything — the PWA, the hook, the worker — talks to
`https://your-app.vercel.app/api/*` and never to the functions host directly.

`supabase/config.toml` sets `verify_jwt = false` on all eight. These routes carry
their own credentials (a machineToken or phoneToken, matched against a sha256
hash), and `/api/devices` and `/api/claim` are unauthenticated by design; with the
gateway's default JWT check on, every route would 401 before the handler ran.

Then point the CLI at it: `AAP_API_BASE=https://your-app.vercel.app tapproval
setup`, or set `apiBase` in the config file.

Check the wiring by registering a device, which exercises the whole chain — the
Vercel rewrite, the function, the service-role key, and the schema:

```bash
curl -sX POST https://your-app.vercel.app/api/devices \
  -H 'content-type: application/json' -d '{"label":"probe"}'
```

A `device_id` and a `machine_token` back means everything but OneSignal is wired.
A 500 means a missing secret — `supabase functions logs notify` names it. There is
deliberately no unauthenticated status endpoint: it would report your
configuration to anyone who asked.

Set the OneSignal **Site URL** to your deployment and turn off *Welcome
Notification* — it's on by default and double-fires, once on subscribe and once
on `login()`.

The `pg_cron` sweeper flips expired requests and deletes rows older than 7 days.
If `pg_cron` isn't enabled the migration skips scheduling it; expiry still works,
because `/api/request` and `/api/decide` settle a stale row on read.

---

## Verifying hosted mode

`npm test` proves what can be proven without a phone or a deployment:

- the encryption round-trips through both Node **and** WebCrypto (the browser
  path), a tampered blob is rejected, and a different key cannot read it
- the hook never emits `allow` on any error path — unconfigured, API down, bad
  key, server down — and its stdout is always exactly one JSON object
- the request body contains no `summary`/`detail`/`cwd` at all, and the machine
  token travels in the header
- the polling fallback still delivers a decision with the websocket unavailable
- the vendored runtime survives what it exists for: vendor out of a fake npx cache,
  **delete the cache**, and the hook still starts and still resolves its
  dependencies from the copy
- self-hosted mode still works end to end against the real `server.mjs`
- every API route, on the Deno runtime they deploy to, driven end to end
  against an in-memory PostgREST stub behind the real supabase-js client: register →
  mint code → claim → notify → read → decide, plus a claimed code rejected on
  reuse, an expired code rejected, a late tap reported as `expired` rather than
  `allow`, and a second device unable to read or decide the first device's
  request

The rest needs a real device:

- Approve **and** deny from Android lock-screen buttons with Chrome fully closed
- Approve from an installed iOS PWA via tap-through
- Let one time out → terminal prompt appears; then tap late → phone says
  "Timed out"
- Turn off wifi mid-wait, back on → `[approval-hook] falling back to polling`
  on stderr, decision still lands
- Inspect the row directly and confirm there is no plaintext:
  ```sql
  select tool, status, payload_ciphertext from requests order by created_at desc limit 1;
  ```
- Register a second device and confirm its `machineToken` gets 404 for the
  first device's request id, and its phone cannot decide it
- Claim a pair code twice → second attempt 410; wait out a code → 410

`DRY_RUN=1` on the deployment prints the review and decision URLs instead of
pushing, which is how to find transport bugs without a phone at all.

---
