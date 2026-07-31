/**
 * Tiny HTTP helpers shared by every function.
 *
 * The Vercel handlers were `(req, res)`; an Edge Function is
 * `(Request) => Response`. Everything else about the wire contract is unchanged,
 * and deliberately so: the hook and the PWA are already written against it.
 */

import { env } from './env.ts';

/**
 * The phone and the service worker call these routes through the Vercel proxy
 * (same-origin) in the normal install, and cross-origin in some shapes. Allowing
 * the header is what lets the Bearer token survive the preflight.
 */
const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,authorization,apikey,x-client-info',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

export const json = (code: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/** Bodies are small JSON objects. A malformed one is an empty one, as before. */
export async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export const bearer = (req: Request): string =>
  (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();

export type Handler = (req: Request) => Promise<Response>;

/** Wraps a handler so an unexpected throw is a 500, never a hung function. */
export const route = (methods: string[], handler: Handler): Handler => async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!methods.includes(req.method)) return json(405, { error: 'method_not_allowed' });
  try {
    return await handler(req);
  } catch (err) {
    // Never echo the message back — it can carry DB detail. The hook treats any
    // non-2xx as "no decision", which falls through to the terminal prompt.
    console.error('[route] unhandled:', err instanceof Error ? err.message : err);
    return json(500, { error: 'internal' });
  }
};

/**
 * Starts the listener, except under the test suite, which imports the same
 * `handler` and calls it directly. Production never sets AAP_NO_SERVE, so a
 * deployed function always serves.
 */
export function serve(handler: Handler): void {
  if (env('AAP_NO_SERVE') === '1') return;
  Deno.serve(handler);
}
