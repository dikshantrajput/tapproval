/**
 * Environment access, in one place.
 *
 * Edge Functions inject SUPABASE_URL, SUPABASE_ANON_KEY and
 * SUPABASE_SERVICE_ROLE_KEY automatically. ONESIGNAL_APP_ID, ONESIGNAL_API_KEY,
 * SUPABASE_JWT_SECRET and PUBLIC_BASE_URL come from `supabase secrets set` —
 * the JWT secret in particular is NOT auto-injected, and /api/notify cannot mint
 * the hook's Realtime token without it.
 *
 * Reads go through here rather than touching Deno.env inline so that a missing
 * variable is one legible throw, at the point of use, naming the variable.
 */

export function env(name: string): string | undefined {
  try {
    return Deno.env.get(name) || undefined;
  } catch {
    // No --allow-env. Treat as absent — requireEnv() then throws by name.
    return undefined;
  }
}

/**
 * The Realtime signing key.
 *
 * `supabase secrets set` refuses names beginning with `SUPABASE_` — that prefix is
 * reserved for the values the runtime injects, and the JWT secret is not one of
 * them. So the deployed name is AAP_JWT_SECRET. SUPABASE_JWT_SECRET is still
 * honoured because that is what it is called in the dashboard, in `.env`, and in
 * `supabase functions serve --env-file`, where no such restriction applies.
 */
export const jwtSecret = (): string | undefined =>
  env('AAP_JWT_SECRET') ?? env('SUPABASE_JWT_SECRET');

export function requireEnv(name: string): string {
  const v = env(name);
  if (!v) throw new Error(`${name} not set`);
  return v;
}
