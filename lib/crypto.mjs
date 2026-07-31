import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * The end-to-end encryption used in hosted mode.
 *
 * One symmetric key per device, generated on the laptop, handed to each phone
 * once at claim time, and never held by the server after that. `summary`,
 * `detail` and `cwd` — the command, the diff, the working directory — travel and
 * rest as a single opaque blob.
 *
 * Wire format:  v1.<base64url iv>.<base64url ciphertext||tag>
 *
 * AES-256-GCM, 12-byte IV, 16-byte tag appended — byte-identical to what WebCrypto
 * produces and consumes, so the page and the service worker decrypt this with
 * `crypto.subtle` and no shim. The version prefix exists so a future format change
 * can be recognised rather than mis-parsed.
 */

const VERSION = 'v1';

/** 32 random bytes, base64url. This is the whole secret. */
export const newPayloadKey = () => randomBytes(32).toString('base64url');

const keyBytes = (keyB64) => {
  const buf = Buffer.from(keyB64, 'base64url');
  if (buf.length !== 32) throw new Error('payload key must be 32 bytes (base64url)');
  return buf;
};

export function encryptPayload(keyB64, payload) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(keyB64), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  // Tag last, exactly where WebCrypto expects to find it.
  const blob = Buffer.concat([body, cipher.getAuthTag()]);
  return `${VERSION}.${iv.toString('base64url')}.${blob.toString('base64url')}`;
}

/** Only used by the dry-run path and the tests — the phone does the real decrypting. */
export function decryptPayload(keyB64, blob) {
  const [version, ivB64, bodyB64] = String(blob).split('.');
  if (version !== VERSION || !ivB64 || !bodyB64) throw new Error('unrecognised payload format');

  const raw = Buffer.from(bodyB64, 'base64url');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyBytes(keyB64),
    Buffer.from(ivB64, 'base64url'),
  );
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const out = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(out.toString('utf8'));
}
