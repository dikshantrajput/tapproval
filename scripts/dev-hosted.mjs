#!/usr/bin/env node
/**
 * Runs hosted mode locally: the PWA and the Edge Functions behind one origin.
 *
 *   supabase functions serve --env-file .env      (terminal 1)
 *   node scripts/dev-hosted.mjs                   (terminal 2, or: npm run dev:hosted)
 *
 * This is now exactly what vercel.json is in production and nothing more: static
 * files out of public/, the three HTML rewrites, and /api/:path* proxied to the
 * functions runtime. Same-origin matters — public/OneSignalSDKWorker.js does
 * fetch('/api/decide') from a service worker and must not be made cross-origin.
 *
 * The functions read their own env (SUPABASE_URL, the keys, SUPABASE_JWT_SECRET,
 * ONESIGNAL_*, PUBLIC_BASE_URL) from whatever you pass to
 * `supabase functions serve --env-file`; this process needs none of it.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT ?? 3000);

// Where `supabase functions serve` listens. Point this at a deployed project
// (https://<ref>.supabase.co/functions/v1) to test against the real thing.
const FUNCTIONS_BASE = (process.env.FUNCTIONS_BASE ?? 'http://127.0.0.1:54321/functions/v1')
  .replace(/\/$/, '');

const ROUTES = ['devices', 'pair-codes', 'claim', 'notify', 'decide', 'request'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function serveStatic(res, name) {
  try {
    const buf = await readFile(join(PUBLIC, name));
    res.writeHead(200, {
      'content-type': MIME[extname(name)] ?? 'application/octet-stream',
      // Same two headers vercel.json sets: the worker must never be cached stale,
      // and it must be allowed to claim the root scope.
      'cache-control': /Worker|aap-crypto/.test(name) ? 'no-cache, no-store' : 'public, max-age=60',
      'service-worker-allowed': '/',
    });
    res.end(buf);
    return true;
  } catch {
    return false;
  }
}

/** vercel.json's `/api/:path*` rewrite, in about twenty lines. */
async function proxy(req, res, path, search) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;

  const upstream = await fetch(`${FUNCTIONS_BASE}${path.slice('/api'.length)}${search}`, {
    method: req.method,
    headers: {
      ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
      ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
      'user-agent': req.headers['user-agent'] ?? 'dev-hosted',
      // The function builds push URLs from PUBLIC_BASE_URL, falling back to these.
      'x-forwarded-host': req.headers.host ?? `localhost:${PORT}`,
      'x-forwarded-proto': 'http',
      'x-forwarded-for': req.socket.remoteAddress ?? '127.0.0.1',
    },
    body,
  }).catch((err) => {
    console.error(`[api] ${path} → ${FUNCTIONS_BASE} unreachable: ${err.message}`);
    return null;
  });

  if (!upstream) {
    res.writeHead(502, { 'content-type': 'application/json' });
    return res.end('{"error":"functions_unreachable"}');
  }

  const text = await upstream.text();
  console.log(`[api] ${req.method} ${path} → ${upstream.status}`);
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store',
  });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path.startsWith('/api/')) return proxy(req, res, path, url.search);

  // vercel.json's rewrites.
  if (path === '/' || /^\/[pr]\/[^/]+$/.test(path)) {
    if (await serveStatic(res, 'index.html')) return;
  }
  if (await serveStatic(res, path.replace(/^\//, ''))) return;

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

server.listen(PORT, () => {
  console.log(`\n  hosted mode (local) on http://localhost:${PORT}`);
  console.log(`  /api/* → ${FUNCTIONS_BASE}`);
  console.log(`  routes: ${ROUTES.map((r) => `/api/${r}`).join(' ')}`);
  console.log(`\n  Start the functions runtime first:`);
  console.log(`    supabase functions serve --env-file .env`);
  console.log(`\n  Then expose this and point the CLI at the tunnel:`);
  console.log(`    ngrok http ${PORT} --url=<your-static>.ngrok-free.app`);
  console.log(`    AAP_API_BASE=https://<your-static>.ngrok-free.app npx . setup\n`);
});
