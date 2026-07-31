/**
 * Database access with the service_role key, through @supabase/supabase-js.
 *
 * service_role bypasses RLS, so every query here spells out its own `device_id`
 * scope — RLS is the backstop, not the mechanism.
 *
 * The client is built once per isolate and reused across invocations, so its
 * construction cost lands on the first request only. Auth is switched off
 * entirely: these functions never act as a user, they act as the service role,
 * and persisted sessions / token refresh would be dead weight in an isolate.
 *
 * The query surface stays deliberately narrow — the callers do half a dozen
 * single-row reads and two conditional updates, and nothing else.
 */

// npm: rather than jsr: so the one version in package.json is what both the
// deployed function and `npm test` resolve — the jsr copy pins its own
// (older) realtime-js and collides with the installed tree.
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@^2.45.0';
import { requireEnv } from './env.ts';

export type Row = Record<string, any>;

/** A filter value: a bare value means `eq`, or use `gt()` / `gte()` / `inList()` / `isNull`. */
export type FilterValue =
  | string
  | number
  | { op: 'gt' | 'gte' | 'is'; value: unknown }
  | { op: 'in'; value: readonly (string | number)[] };
export type Filters = Record<string, FilterValue>;

export const gt = (value: string | number) => ({ op: 'gt' as const, value });
export const gte = (value: string | number) => ({ op: 'gte' as const, value });
/**
 * `column in (…)`. Exists for one caller: settling a request from the laptop has
 * to match several current statuses at once and must stay a single conditional
 * UPDATE, because that is what keeps a phone tap landing at the same moment from
 * being overwritten.
 */
export const inList = (value: readonly (string | number)[]) => ({ op: 'in' as const, value });
export const isNull = { op: 'is' as const, value: null };

/**
 * Kept under its original name and shape: callers branch on `.status` (409 for a
 * pair-code collision, 400 for a malformed uuid) and that contract is unchanged.
 * `code` is the Postgres SQLSTATE where there is one, which is the more precise
 * signal now that the client hands it to us.
 */
export class RestError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(
      requireEnv('SUPABASE_URL'),
      requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
      {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { 'x-client-info': 'tapproval' } },
      },
    );
  }
  return client;
}

/** supabase-js resolves rather than rejects; every caller here wants a throw. */
function unwrap<T>(res: { data: T; error: any; status: number }): T {
  if (res.error) {
    throw new RestError(
      res.status || 500,
      `postgrest ${res.status}: ${res.error.message}`.slice(0, 300),
      res.error.code,
    );
  }
  return res.data;
}

function applyFilters<T>(query: T, filters: Filters): T {
  let q: any = query;
  for (const [column, f] of Object.entries(filters)) {
    if (f !== null && typeof f === 'object') q = q[f.op](column, f.value);
    else q = q.eq(column, f);
  }
  return q as T;
}

export type SelectOpts = {
  select?: string;
  order?: [string, { ascending: boolean }];
  limit?: number;
};

export async function selectMany(
  table: string,
  filters: Filters,
  opts: SelectOpts = {},
): Promise<Row[]> {
  let q: any = applyFilters(db().from(table).select(opts.select ?? '*'), filters);
  if (opts.order) q = q.order(opts.order[0], opts.order[1]);
  if (opts.limit != null) q = q.limit(opts.limit);
  return (unwrap(await q) ?? []) as Row[];
}

export async function selectOne(
  table: string,
  filters: Filters,
  opts: Omit<SelectOpts, 'limit'> = {},
): Promise<Row | null> {
  const rows = await selectMany(table, filters, { ...opts, limit: 1 });
  return rows[0] ?? null;
}

export async function insertOne(table: string, row: Row): Promise<Row> {
  return unwrap(await db().from(table).insert(row).select().single()) as Row;
}

/**
 * Conditional update. The filters are evaluated inside the single UPDATE
 * statement — that is what makes "first tap wins" atomic instead of a
 * read-then-write race between two phones.
 * Returns the updated rows (empty when the condition didn't hold).
 */
export async function updateWhere(table: string, match: Filters, patch: Row): Promise<Row[]> {
  const q: any = applyFilters(db().from(table).update(patch), match);
  return (unwrap(await q.select()) ?? []) as Row[];
}

/**
 * Cheap "does this table exist and can we reach it" probe for /api/health.
 * `head: true` means no rows cross the wire — only the count header.
 */
export async function probe(table: string): Promise<void> {
  unwrap(await db().from(table).select('*', { count: 'exact', head: true }) as any);
}
