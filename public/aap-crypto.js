/*
 * Shared by the page and the service worker: the key store and the decrypt.
 *
 * Both need the payload key, and a service worker cannot read localStorage — so
 * IndexedDB is the only place both can reach. The key is written there once, at
 * claim time, and never leaves the device.
 *
 * Wire format is whatever lib/crypto.mjs produced:
 *   v1.<base64url iv>.<base64url ciphertext||tag>
 * AES-256-GCM with the tag appended is exactly what crypto.subtle expects, so
 * there is no shim here — just a parse.
 */

const DB_NAME = 'aap';
const STORE = 'kv';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbTx(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

const idbGet = (k) => idbTx('readonly', (s) => s.get(k));
const idbSet = (k, v) => idbTx('readwrite', (s) => s.put(v, k));

/** Everything the worker needs to render a real notification body. */
async function loadSecrets() {
  const [payloadKey, phoneToken, deviceId] = await Promise.all([
    idbGet('payloadKey'), idbGet('phoneToken'), idbGet('deviceId'),
  ]);
  return { payloadKey, phoneToken, deviceId };
}

async function saveSecrets({ payloadKey, phoneToken, deviceId }) {
  await Promise.all([
    idbSet('payloadKey', payloadKey),
    idbSet('phoneToken', phoneToken),
    idbSet('deviceId', deviceId),
  ]);
}

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const bytesToB64url = (bytes) => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function importPayloadKey(keyB64, usages = ['decrypt']) {
  return crypto.subtle.importKey(
    'raw', b64urlToBytes(keyB64), { name: 'AES-GCM' }, false, usages,
  );
}

/** Returns { summary, detail, cwd }. Throws if the key is wrong or absent. */
async function decryptPayload(keyB64, blob) {
  const [version, ivB64, bodyB64] = String(blob).split('.');
  if (version !== 'v1' || !ivB64 || !bodyB64) throw new Error('unrecognised payload format');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64urlToBytes(ivB64) },
    await importPayloadKey(keyB64),
    b64urlToBytes(bodyB64),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

/**
 * The return direction, added for AskUserQuestion: seal what the user picked.
 *
 * Same key, same wire format, same 12-byte IV with the tag appended — so the hook
 * decrypts this with lib/crypto.mjs and no special case. Which option someone chose
 * is their content, so it gets the same envelope the command travelled in rather
 * than going back to the server in the clear.
 */
async function encryptPayload(keyB64, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await importPayloadKey(keyB64, ['encrypt']),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `v1.${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(sealed))}`;
}

// Reachable both as a classic script (page) and via importScripts (worker).
self.AAP = { loadSecrets, saveSecrets, decryptPayload, encryptPayload, idbGet, idbSet };
