/**
 * Tokens are stored only as sha256 hex. Lookup is by hash against a unique
 * index, so there is no comparison to leak timing and no way to read a token
 * back out of the database — including by us. Nothing here logs a raw token.
 *
 * node:crypto's createHash/randomBytes/randomInt became Web Crypto: the digest
 * is now async, which is the only shape change the callers see.
 */

import { selectOne, updateWhere, type Row } from './db.ts';

const enc = new TextEncoder();

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function sha256(s: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const newToken = (): string => b64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Uniform random index without modulo bias — the pair-code alphabet is 31
 * symbols, which does not divide 256, so the naive `byte % 31` would make eight
 * of the symbols measurably likelier.
 */
export function randomIndex(n: number): number {
  const limit = 256 - (256 % n);
  const buf = new Uint8Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** Resolves `Authorization: Bearer <machineToken>` to a live device row. */
export async function deviceFromMachineToken(token: string): Promise<Row | null> {
  if (!token || token.length < 20) return null;
  const d = await selectOne(
    'devices',
    { machine_token_hash: await sha256(token) },
    { select: 'id,label,revoked_at' },
  );
  if (!d || d.revoked_at) return null;
  return d;
}

/** Resolves `Authorization: Bearer <phoneToken>` to a live phone row. */
export async function phoneFromToken(token: string): Promise<Row | null> {
  if (!token || token.length < 20) return null;
  const p = await selectOne(
    'phones',
    { phone_token_hash: await sha256(token) },
    { select: 'id,device_id,revoked_at' },
  );
  if (!p || p.revoked_at) return null;
  return p;
}

/**
 * Reads a request and lazily settles a stale one.
 *
 * The cron sweeper does this too, but it runs at most once a minute and the
 * whole safety story depends on a late tap seeing `expired` rather than
 * flipping a row nobody is listening to any more. So we also do it on read,
 * conditionally, in one statement.
 */
export async function getRequest(id: unknown, deviceId: string): Promise<Row | null> {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await selectOne(
    'requests',
    { id, device_id: deviceId },
    {
      select:
        'id,device_id,tool,payload_ciphertext,answer_ciphertext,status,note,expires_at,created_at,decided_at',
    },
  );
  if (!r) return null;
  if (r.status === 'pending' && new Date(r.expires_at).getTime() <= Date.now()) {
    await updateWhere('requests', { id: r.id, status: 'pending' }, { status: 'expired' });
    r.status = 'expired';
  }
  return r;
}
