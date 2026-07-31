import { json, route, serve } from '../_shared/http.ts';
import { probe } from '../_shared/db.ts';
import { env, envNames, jwtSecret } from '../_shared/env.ts';

/**
 * GET /api/health — why is the deployment returning 500?
 *
 * Every other route answers `{"error":"internal"}` and logs the detail, which is
 * correct (a DB error message can describe your schema) but useless when you are
 * staring at a fresh deployment with no idea which secret is missing.
 *
 * This reports presence, never values: booleans for the env, and one probe per
 * table so a half-applied migration is obvious. No secret is echoed, and it needs
 * no token — there is nothing here an attacker learns beyond "this instance is
 * configured", which the existence of a working QR already tells them.
 */

// The first three are injected by the Edge Functions runtime; the rest come from
// `supabase secrets set`. PUBLIC_BASE_URL is listed because it is now load-bearing:
// the function host serves no HTML, so without it the URLs inside a push point at
// <project>.supabase.co and every notification tap 404s.
const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ONESIGNAL_APP_ID',
  'ONESIGNAL_API_KEY',
  'PUBLIC_BASE_URL',
];

export const handler = route(['GET'], async () => {
  const envReport: Record<string, boolean> = Object.fromEntries(
    REQUIRED.map((k) => [k, Boolean(env(k))]),
  );
  // Reported under the dashboard's name whichever of the two it was set as.
  envReport.SUPABASE_JWT_SECRET = Boolean(jwtSecret());

  // Names only, never values. A secret set with a stray space or a typo in its
  // *name* looks identical in `supabase secrets list` but is invisible to
  // Deno.env.get('X'), and this is the only way to see the difference.
  // JSON.stringify makes the whitespace visible.
  const visible = envNames()
    .filter((k) => /SUPABASE|ONESIGNAL|AAP|PUBLIC_BASE/i.test(k))
    .map((k) => JSON.stringify(k))
    .sort();

  const tables: Record<string, string> = {};
  for (const t of ['devices', 'phones', 'pair_codes', 'requests']) {
    try {
      await probe(t);
      tables[t] = 'ok';
    } catch (err) {
      // Trimmed hard: enough to tell "relation does not exist" (migration never
      // ran) from "invalid API key" (wrong service-role key) from a DNS failure.
      tables[t] = String(err instanceof Error ? err.message : err).slice(0, 160);
    }
  }

  const ready = Object.values(envReport).every(Boolean)
    && Object.values(tables).every((v) => v === 'ok');

  return json(ready ? 200 : 503, {
    ready,
    env: envReport,
    visible,
    tables,
    deno: Deno.version.deno,
    dry_run: env('DRY_RUN') === '1',
  });
});

serve(handler);
