# Development

[← back to the README](../README.md)

---

```bash
npm test                     # the invariants that don't need a phone
npm run dev:hosted           # static + /api proxy locally, no Vercel CLI needed
npm run dev                  # self-hosted DRY_RUN: prints allow/deny URLs
```

`npm test` needs both Node and [Deno](https://deno.com) on PATH: the hook and the
CLI are Node, the API is Deno, and each suite runs on the runtime that ships it.
The Supabase CLI is only needed to serve or deploy the functions.

### Running hosted mode locally

Two processes: `supabase functions serve` runs the real functions on the real
runtime, and `scripts/dev-hosted.mjs` is everything `vercel.json` does — static
files, the three HTML rewrites, and `/api/*` proxied to them — so the worker's
`fetch('/api/decide')` stays same-origin and a tunnel has one port to point at.

You do need a real Supabase project: Realtime is the return path and there is
nothing to stub it with. Create a free one, run both files in
`supabase/migrations/` through the SQL editor, then put the keys in `.env`:

```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_ANON_KEY=…
SUPABASE_SERVICE_ROLE_KEY=…
SUPABASE_JWT_SECRET=…
ONESIGNAL_APP_ID=…            # omit both with DRY_RUN=1
ONESIGNAL_API_KEY=…
PUBLIC_BASE_URL=http://localhost:3000    # or the ngrok URL, below
```

```bash
supabase functions serve --env-file .env                     # :54321
npm run dev:hosted                                          # :3000, or PORT=…
ngrok http 3000 --url=<your-static>.ngrok-free.app          # claim the free static domain
AAP_API_BASE=https://<your-static>.ngrok-free.app npx . setup
```

Set the OneSignal **Site URL** to the same ngrok URL.

On free ngrok the interstitial appears once per browser session — tap **Visit
Site** on the phone before enabling notifications, and the service worker
registers normally after that. If you install the PWA to the iOS Home Screen,
open the ngrok URL in Safari and clear the interstitial there first; a fresh
standalone context that hits the warning page has no worker.

`DRY_RUN=1` in `.env` (it is the functions that read it now) skips the push and
logs the review/allow/deny URLs instead — enough to exercise the whole flow
without a phone, though `/api/notify` still writes to Postgres.

```bash
# seed a self-hosted pending request so you can look at the UI without a phone
curl -s -X POST localhost:8787/api/notify -H 'content-type: application/json' \
  -d '{"device_id":"dev-secret","tool":"Bash","summary":"rm -rf build/",
       "detail":"rm -rf build/ && npm run deploy","timeout_sec":300}'
```

Then open `http://localhost:8787/p/dev-secret`.

### Layout

```
bin/cli.mjs                  setup / start / pair / doctor / uninstall
lib/config.mjs               ~/.tapproval/config.json + the npx-safe vendoring
lib/crypto.mjs               AES-256-GCM payload encryption (hosted)
lib/wait-hosted.mjs          Realtime subscription + bounded polling fallback
lib/hook-config.mjs          ~/.claude/tapproval.json — the config both hooks read
lib/local-trace.mjs          the breadcrumb linking a withdrawn row to its tool call
lib/transcript.mjs           reading what the terminal did — shared by both hooks
hook/permission-hook.mjs     the subprocess the agent spawns
hook/reconcile-hook.mjs      records what you decided in the terminal (no stdout)
supabase/functions/          the hosted API — one Edge Function per route
  _shared/                   http, db, auth, jwt, push, base, env
  devices/                   register a laptop
  pair-codes/                mint a short-lived code
  claim/                     code → phoneToken + payloadKey (single use)
  notify/                    insert + push + Realtime token, sub-second
  decide/                    the verdict, one conditional UPDATE
  cancel/                    withdraw a row nobody is listening to any more
  local-decide/              what the terminal decided, never over a phone verdict
  request/                   ciphertext for the phone, status for the hook
supabase/config.toml         verify_jwt = false — these routes carry their own auth
supabase/migrations/         schema, RLS, grants, Realtime, sweeper
vercel.json                  static hosting + /api/:path* → functions
server.mjs                   self-hosted HTTP + OneSignal + in-memory state
scripts/install-hook.mjs     merges the hook into settings.json, non-destructively
                             (--root points it at the copy that will still be there)
scripts/dev-hosted.mjs       static + /api proxy locally, mirrors vercel.json
scripts/verify.mjs           npm test — crypto, hook fail-safety, both modes
scripts/verify-api.ts        npm test (Deno) — every route vs an in-memory stub
scripts/make-action-icons.mjs the two notification button icons, generated
public/                      the PWA
  aap-crypto.js              key store (IndexedDB) + decrypt, shared
  OneSignalSDKWorker.js      ← the Android fix. don't touch.
```

`install-hook.mjs` reads → merges → verifies → writes, backs up first, and
aborts if any pre-existing key, hook, or permission entry would be lost. It's
idempotent and reversible with `--remove`. Settings files get large — 900+
permission entries is normal — so never hand-edit or regenerate them.
