#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';

import {
  load, save, writeHookConfig, toolList, ephemeralInstallReason, resolveConfigPath,
  vendorRuntime, pruneRuntimes, runtimeRoot, RUNTIME_DIR,
  CONFIG_PATH, HOOK_CONFIG_PATH, SETTINGS_PATH, DEFAULT_API_BASE, DEFAULTS,
} from '../lib/config.mjs';
import { newPayloadKey } from '../lib/crypto.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const c = {
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
};
const ok = (s) => console.log(`  ${c.g('✓')} ${s}`);
const warn = (s) => console.log(`  ${c.y('!')} ${s}`);
const bad = (s) => console.log(`  ${c.r('✗')} ${s}`);

const argv = process.argv.slice(3);
const has = (flag) => argv.includes(flag);

/* ------------------------------------------------------------------ setup */

async function setup() {
  return has('--self-hosted') ? setupSelfHosted() : setupHosted();
}

/** Name and version of the running package, read once. */
function pkg() {
  const { name, version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return { name, version };
}

/**
 * The directory the hook should be spawned from, which is not always this one.
 *
 * Run from a global install, that is simply here. Run through `npx`, this package
 * is sitting in a cache npm prunes on its own schedule — so copy it somewhere
 * permanent and point the hook there instead. The copy is per-version and
 * idempotent, so only the first `npx … setup` pays for it and every later command
 * finds it already in place.
 *
 * This is what makes `npx tapproval setup` a supported way in rather than an error:
 * what has to be stable is the path the *agent* runs, not the path *you* ran.
 */
function stableHookRoot({ quiet = false } = {}) {
  const reason = ephemeralInstallReason(ROOT);
  if (!reason) return ROOT;

  const { name, version } = pkg();
  const already = existsSync(join(runtimeRoot(version), 'node_modules', name));
  const dest = vendorRuntime(ROOT, { name, version });
  if (!quiet && !already) {
    ok(`copied the runtime out of the ${reason} → ${runtimeRoot(version)}`);
    console.log(c.dim(`    the agent runs the hook from there, so an npm prune cannot break it`));
  }
  return dest;
}

/**
 * Install the hooks, pointed at whichever copy will still be there next month.
 *
 * Old versions are pruned only after the write succeeds — they are what the
 * settings file points at until that moment, and deleting them first would leave
 * a machine with no working hook if the merge aborted.
 */
async function installHook() {
  const root = stableHookRoot();
  await run(process.execPath, [join(ROOT, 'scripts', 'install-hook.mjs'), '--root', root]);
  if (root !== ROOT) {
    const gone = pruneRuntimes(pkg().version);
    if (gone.length) ok(`removed the old runtime${gone.length > 1 ? 's' : ''}: ${gone.join(', ')}`);
  }
}

/**
 * Every hosted request is built as `${apiBase}/api/...`, so an empty or malformed
 * base produces a relative URL and `fetch` fails with "Failed to parse URL from
 * /api/devices" — which says nothing about the actual problem. Fail here instead,
 * naming the variable to set.
 */
function resolveApiBase(candidate) {
  const base = (candidate || DEFAULT_API_BASE).replace(/\/$/, '');
  try {
    const u = new URL(base);
    if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      warn(`${base} is not https — pairing and web push will not work on a real phone.`);
    }
    return base;
  } catch {
    throw new Error(
      `"${base}" is not a valid URL.\n`
      + `    Set the deployment to use with:  AAP_API_BASE=https://… tapproval setup\n`
      + `    (note the spelling: AAP_API_BASE, not APP_API_BASE)`,
    );
  }
}

/**
 * Hosted setup: no questions asked.
 *
 * Register a device, mint a payload key locally, install the hook, print a QR.
 * The key is generated here and never sent anywhere except into one pair code —
 * which is why the server cannot read your commands even in principle.
 */
async function setupHosted() {
  console.log(`\n${c.b('tapproval')} — approve your agent's permission prompts from your phone\n`);

  const cur = load();
  // `||`, not `??` — an unset key in the config file is the empty string, and `??`
  // would happily keep it and then fetch a relative URL.
  const apiBase = resolveApiBase(process.env.AAP_API_BASE || cur.apiBase);

  let cfg;
  // Reusing the registration is only right if the server still recognises it.
  //
  // The guard used to be "are the three fields present", which trusts local state
  // to describe a remote row. When it does not — the project was reset, the device
  // revoked, the config carried over from self-hosted — every path fails with
  // "this device was revoked — run setup again", and setup then declines to do
  // anything because the fields are still there. A dead end that names itself as
  // the cure.
  //
  // Nothing is lost by re-registering in that case: a token the server rejects
  // cannot mint a pair code or notify anybody, so the phones it belongs to are
  // already unreachable. They have to re-pair either way.
  const reusable = cur.mode === 'hosted' && cur.machineToken && cur.deviceId && cur.payloadKey
    && await deviceStillLive(apiBase, cur.machineToken);

  if (reusable) {
    // Re-running setup must not orphan the phones already paired to this key.
    ok('reusing the existing device registration');
    cfg = save({ mode: 'hosted', apiBase });
  } else {
    if (cur.machineToken) {
      warn('this machine\'s registration is gone from the server — registering again');
      warn('any phone paired before now must re-pair (the payload key changes)');
    }
    const res = await fetch(`${apiBase}/api/devices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: hostname() }),
      signal: AbortSignal.timeout(15_000),
    });
    // A 429 here is the one registration failure with a real explanation, and
    // re-running setup is exactly what someone hits it by doing. Say so, rather
    // than reporting a bare status code they cannot act on.
    if (res.status === 429) {
      throw new Error(
        'too many registrations from this network today.\n'
        + '  Each setup registers a new device. If you were re-running it to fix\n'
        + '  something, try `tapproval doctor` first — it usually finds the problem\n'
        + '  without a fresh device. Otherwise wait an hour, or self-host:\n'
        + '  tapproval setup --self-hosted',
      );
    }
    if (!res.ok) throw new Error(`could not register with ${apiBase} (HTTP ${res.status})`);
    const d = await res.json();

    cfg = save({
      mode: 'hosted',
      apiBase,
      deviceId: d.device_id,
      machineToken: d.machine_token,
      // Generated on this machine. The server sees it once, inside a pair code,
      // and deletes it the moment a phone claims it.
      payloadKey: newPayloadKey(),
      supabaseUrl: d.supabase_url ?? '',
      supabaseAnonKey: d.supabase_anon_key ?? '',
      timeoutSec: cur.timeoutSec || DEFAULTS.timeoutSec,
    });
    ok('device registered');
  }

  ok(`config written to ${CONFIG_PATH} ${c.dim('(0600)')}`);
  writeHookConfig(cfg);
  ok(`hook config written to ${HOOK_CONFIG_PATH}`);

  await installHook();

  console.log('');
  await pairHosted(cfg, await choosePlatform());

  console.log(`  ${c.b('Then restart your agent')} — a running session rewrites its settings`);
  console.log(`  file from a startup snapshot and will delete the hook.\n`);
}

/** The original interactive flow: your own OneSignal app and your own tunnel. */
async function setupSelfHosted() {
  console.log(`\n${c.b('tapproval')} — self-hosted setup\n`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q, fallback = '') => {
    const a = (await rl.question(`  ${q}${fallback ? c.dim(` [${fallback}]`) : ''} `)).trim();
    return a || fallback;
  };

  const cur = load();

  console.log(c.dim('  You need a free OneSignal app (onesignal.com) with the Web platform'));
  console.log(c.dim('  enabled. Settings → Keys & IDs has both values below.\n'));

  const publicUrl = (await ask('Public HTTPS URL (ngrok/cloudflared):', cur.publicUrl))
    .replace(/\/$/, '');
  if (!/^https:\/\//.test(publicUrl) && !publicUrl.startsWith('http://localhost')) {
    warn('Not an https URL — web push will not work on a real phone.');
  }
  const onesignalAppId = await ask('OneSignal App ID:', cur.onesignalAppId);
  const onesignalApiKey = await ask('OneSignal REST API Key:', cur.onesignalApiKey);
  const port = Number(await ask('Local port:', String(cur.port)));
  const timeoutSec = Number(await ask('Seconds to wait for your phone:', String(cur.timeoutSec)));

  rl.close();

  const deviceId = cur.deviceId || randomBytes(16).toString('hex');
  const cfg = save({
    mode: 'self-hosted',
    publicUrl, onesignalAppId, onesignalApiKey, port, deviceId, timeoutSec,
  });

  console.log('');
  ok(`config written to ${CONFIG_PATH}`);

  writeHookConfig(cfg);
  ok(`hook config written to ${HOOK_CONFIG_PATH}`);

  await installHook();

  console.log(`\n  ${c.b('Next:')}`);
  console.log(`    1. ${c.b('Restart your agent')} — a running session will overwrite the hook.`);
  console.log(`    2. Set the OneSignal ${c.b('Site URL')} to ${publicUrl}`);
  console.log(`    3. ${c.b('tapproval start')}   (keep it running)`);
  console.log(`    4. ${c.b('tapproval pair')}    (scan the QR)\n`);
}

/* ------------------------------------------------------------------- pair */

async function pair() {
  const cfg = load();
  writeHookConfig(cfg);

  if (cfg.mode === 'hosted') {
    if (!cfg.machineToken) {
      bad('Not configured. Run: tapproval setup');
      process.exit(1);
    }
    const withBase = { ...cfg, apiBase: resolveApiBase(process.env.AAP_API_BASE || cfg.apiBase) };
    await pairHosted(withBase, await choosePlatform());
    return;
  }

  if (!cfg.publicUrl || !cfg.deviceId) {
    bad('Not configured. Run: tapproval setup');
    process.exit(1);
  }

  const url = `${cfg.publicUrl}/p/${cfg.deviceId}`;
  console.log(`\n  Scan on ${c.b('Android or desktop Chrome')}, then tap ${c.b('Enable notifications')}:\n`);
  qrcode.generate(url, { small: true });
  console.log(`\n  ${url}\n`);
  console.log(c.y('  ⚠ This link contains your device secret. Anyone with it can approve'));
  console.log(c.y('    tool calls on your machine. Do not share or screenshot it.\n'));
  // Self-hosted pairing is a permanent secret in a URL, and the installed app's
  // pair box only accepts 6-character codes — which only the hosted API mints. So
  // there is currently no way to pair an installed iOS app in this mode. Say so
  // rather than printing iPhone steps that cannot work.
  console.log(c.dim('  iPhone: not supported in self-hosted mode yet. An installed iOS app gets'));
  console.log(c.dim('  its own storage, so pairing in Safari does not reach it, and self-hosted'));
  console.log(c.dim('  mode mints no typeable code. Use hosted mode (tapproval setup) for iOS.\n'));
}

/**
 * Trades the machine token for a short-lived code.
 *
 * The code is 6 characters, dies in 2 minutes, and works once. Screenshot it into
 * a demo video if you like — that was not true of the old QR, which carried a
 * permanent full-access secret.
 */
async function mintPairCode(cfg) {
  const res = await fetch(`${cfg.apiBase}/api/pair-codes`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${cfg.machineToken}`,
    },
    body: JSON.stringify({ payload_key: cfg.payloadKey }),
    signal: AbortSignal.timeout(15_000),
  });
  // Says what to actually type. `setup` now re-registers when the server has
  // forgotten this machine, so this is a real cure rather than a loop — but it is
  // worth naming the consequence, because a new registration means a new payload
  // key and every already-paired phone has to pair again.
  if (res.status === 401) {
    throw new Error(
      'the server does not recognise this machine (revoked, or the project was reset).\n'
      + '      Run: tapproval setup   — it will register again. Every phone must then re-pair.',
    );
  }
  if (!res.ok) throw new Error(`could not get a pair code (HTTP ${res.status})`);
  return res.json();
}

/**
 * Which phone are we pairing? The answer changes the *order* of the steps, not
 * just the wording, which is why it is worth asking.
 *
 * Android and desktop share one browser storage container, so the browser that
 * scans the QR is the browser that keeps the credentials: scan, claim, install,
 * done. iOS gives a Home Screen web app its own container and opens scanned links
 * in Safari, and `start_url` drops the `/p/<code>` path — so on iOS a scan pairs
 * Safari, not the app, and costs a single-use code to learn it. There the install
 * has to come first and the code has to be typed.
 *
 * A flag skips the question; so does a non-TTY stdin, which keeps `setup`
 * scriptable in CI.
 */
async function choosePlatform() {
  if (has('--ios') || has('--iphone') || has('--ipad')) return 'ios';
  if (has('--android')) return 'android';
  if (has('--desktop') || has('--mac') || has('--windows')) return 'desktop';
  if (!process.stdin.isTTY) return 'unknown';

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`  ${c.b('Which phone are you pairing?')}`);
    console.log('    1  iPhone / iPad');
    console.log('    2  Android');
    console.log(`    3  Desktop Chrome or Edge ${c.dim('(this machine, or another computer)')}`);
    for (let i = 0; i < 3; i++) {
      const a = (await rl.question('  1, 2 or 3: ')).trim();
      if (a === '1') return 'ios';
      if (a === '2') return 'android';
      if (a === '3') return 'desktop';
      warn('type 1, 2 or 3');
    }
    return 'unknown';
  } finally {
    rl.close();
  }
}

/** Pair a phone, in whichever order that platform actually supports. */
async function pairHosted(cfg, platform) {
  // `--code` is for a phone that is already installed and sitting on the "Pair
  // this phone" screen — the state the app's own hints link back to. It wants one
  // fresh code and none of the install walkthrough.
  if (has('--code')) return printTypedCode(cfg);
  return platform === 'ios' ? pairIos(cfg) : pairScan(cfg, platform);
}

/** A code, spaced for reading aloud or typing off a second screen. */
async function printTypedCode(cfg) {
  const { code, ttl } = await mintPairCode(cfg);
  console.log(`\n  Type this into the app:\n`);
  console.log(`      ${c.b(code.split('').join(' '))}\n`);
  console.log(`  ${c.dim(`${ttl}s, single use — another: tapproval pair --code`)}\n`);
}

/**
 * iOS: install first, pair second, and deliberately no QR of a pair code.
 *
 * The QR here encodes the bare site root, which is safe to scan at any time and
 * carries no code to waste. The code is minted only after the app is open, so its
 * two-minute life starts when the user is ready to type it rather than being spent
 * on the Add to Home Screen detour — which was the whole problem.
 */
async function pairIos(cfg) {
  console.log(`\n  ${c.b('iPhone — install first, then pair.')}`);
  console.log(c.dim('  A Home Screen app has its own storage, so pairing in Safari does not'));
  console.log(c.dim('  reach it. Scanning a code would only pair Safari, and spend the code.\n'));
  console.log(`  ${c.b('1.')} Open this in ${c.b('Safari')} on your iPhone:\n`);
  qrcode.generate(cfg.apiBase, { small: true });
  console.log(`\n     ${cfg.apiBase}\n`);
  console.log(`  ${c.b('2.')} Share → ${c.b('Add to Home Screen')}`);
  console.log(`  ${c.b('3.')} Close Safari and open the app ${c.b('from the Home Screen icon')}`);
  console.log(`     ${c.dim('It will show "Pair this phone" with a box for six characters.')}\n`);

  if (!process.stdin.isTTY) {
    console.log(`  ${c.b('4.')} Then run ${c.b('tapproval pair --code')} here for a code to type in.\n`);
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`  ${c.b('Press Enter once the app is open on your phone')} `);
  } finally {
    rl.close();
  }

  const { code, ttl } = await mintPairCode(cfg);
  console.log(`\n  ${c.b('4.')} Type this into the app:\n`);
  console.log(`        ${c.b(code.split('').join(' '))}\n`);
  console.log(`     ${c.dim(`${ttl}s, single use — need another? tapproval pair --ios`)}\n`);
  console.log(`  ${c.b('5.')} Tap ${c.b('Enable notifications')}.`);
  console.log(`     ${c.dim('From the installed app, not a Safari tab — a tab silently fails.')}\n`);
}

/** Android and desktop: the scan carries the code, because storage is shared. */
async function pairScan(cfg, platform) {
  const { code, ttl } = await mintPairCode(cfg);
  const url = `${cfg.apiBase}/p/${code}`;

  const label = platform === 'desktop' ? 'Open this in Chrome or Edge' : 'Scan this on your phone';
  console.log(`\n  ${c.b(label)} — good for ${ttl} seconds:\n`);
  qrcode.generate(url, { small: true });
  console.log(`\n  ${url}`);
  console.log(`  code: ${c.b(code)}   ${c.dim(`expires in ${ttl}s, single use`)}\n`);
  console.log(`  Then tap ${c.b('Enable notifications')}, and ${c.b('Install')} when the browser offers it.\n`);

  if (platform === 'unknown') {
    console.log(c.y('  On an iPhone this QR pairs Safari, not the installed app — and spends'));
    console.log(c.y('  the code. Use: tapproval pair --ios\n'));
  }
}

/* ------------------------------------------------------------------ start */

function start() {
  const cfg = load();

  if (cfg.mode === 'hosted') {
    console.log(`\n  Nothing to start — hosted mode has no local server.`);
    console.log(c.dim(`  The hook talks straight to ${cfg.apiBase || DEFAULT_API_BASE}.`));
    console.log(c.dim(`  Pair a phone with: tapproval pair\n`));
    return;
  }

  const missing = ['publicUrl', 'deviceId', ...(process.env.DRY_RUN === '1' ? [] : ['onesignalAppId', 'onesignalApiKey'])]
    .filter((k) => !cfg[k]);
  if (missing.length) {
    bad(`Missing config: ${missing.join(', ')}. Run: tapproval setup --self-hosted`);
    process.exit(1);
  }
  return run(process.execPath, [join(ROOT, 'server.mjs')], {
    ONESIGNAL_APP_ID: cfg.onesignalAppId,
    ONESIGNAL_API_KEY: cfg.onesignalApiKey,
    PUBLIC_URL: cfg.publicUrl,
    DEVICE_ID: cfg.deviceId,
    PORT: String(cfg.port),
  });
}

/* -------------------------------------------------------------- uninstall */

/**
 * Take the hooks out, and take the vendored copy with them.
 *
 * A global install is npm's to remove; ~/.tapproval/runtime is ours, and leaving it
 * behind means `uninstall` quietly keeps a few megabytes of node_modules in the home
 * directory of someone who just said they were done. The config file stays — it
 * holds the payload key, and re-running setup with it intact is what lets already
 * paired phones keep working.
 */
async function uninstall() {
  await run(process.execPath, [join(ROOT, 'scripts', 'install-hook.mjs'), '--remove']);
  // Keep nothing: pruning against a version that cannot exist clears the lot.
  const gone = pruneRuntimes(null);
  if (gone.length) ok(`removed the vendored runtime from ${RUNTIME_DIR}`);
  console.log(c.dim(`  config kept at ${CONFIG_PATH} — delete it to unpair every phone\n`));
}

/* ------------------------------------------------------------------ quiet */

/**
 * Turn the buzzing down without uninstalling anything.
 *
 *   mute                      nothing reaches the phone
 *   unmute                    everything does again
 *   notify Bash Edit Write    only these tools
 *   notify --skip Read Glob   everything except these
 *   notify --all              back to every prompt
 *   notify --grace=10         hold the push 10s so a keyboard answer pre-empts it
 *
 * All of it is a config write plus a hook-config rewrite; the hook enforces it
 * before it sends anything, so a filtered prompt costs no push and no request.
 * Nothing is dropped — a prompt that stays quiet is a prompt you answer in the
 * terminal, which is where every other non-answer here ends up too.
 */
function applyQuiet(patch, headline) {
  const cfg = save(patch);
  writeHookConfig(cfg);
  console.log(`\n  ${headline}`);
  if (cfg.muted) {
    ok('muted — every prompt goes to the terminal');
  } else if (cfg.onlyTools.length) {
    ok(`notifying for: ${cfg.onlyTools.join(', ')}`);
  } else if (cfg.skipTools.length) {
    ok(`notifying for everything except: ${cfg.skipTools.join(', ')}`);
  } else {
    ok('notifying for every prompt');
  }
  console.log(c.dim(`  config: ${CONFIG_PATH}\n`));
}

const mute = async () => applyQuiet({ muted: true }, 'Notifications off');
const unmute = async () => applyQuiet({ muted: false }, 'Notifications on');

async function notify() {
  const names = toolList(argv.filter((a) => !a.startsWith('--')).join(','));

  // How long to hold the push back. Its own flag rather than a config edit,
  // because it is the one setting people will actually want to tune — the right
  // pause depends on how fast you answer, which nobody can guess for you.
  const graceArg = argv.find((a) => a.startsWith('--grace='));
  if (graceArg) {
    const secs = Number(graceArg.slice('--grace='.length));
    if (!Number.isFinite(secs) || secs < 0 || secs > 300) {
      bad('--grace= needs a number of seconds between 0 and 300');
      return;
    }
    const cfg = save({ graceSec: secs });
    writeHookConfig(cfg);
    console.log(`\n  ${secs ? `Holding the push ${secs}s` : 'Notifying immediately'}`);
    secs
      ? ok('answer in the terminal within that window and your phone stays quiet')
      : ok('every prompt goes to the phone straight away');
    // The kill timeout is derived from grace + wait, so it has to move with this.
    await installHook();
    console.log(c.dim(`  config: ${CONFIG_PATH}\n`));
    return;
  }

  if (has('--all')) return applyQuiet({ muted: false, onlyTools: [], skipTools: [] }, 'Notifying for every prompt');
  if (!names.length) {
    console.log(`\n  ${c.b('Usage')}`);
    console.log('    notify Bash Edit Write      only these tools');
    console.log('    notify --skip Read Glob     everything except these');
    console.log('    notify --all                every prompt');
    console.log('    notify --grace=10           hold the push 10s (default 30, 0 = at once)\n');
    return;
  }
  // The two lists are exclusive on purpose: an allowlist and a blocklist together
  // read as "these, except…" but resolve to an empty intersection often enough
  // that setting one has to clear the other.
  return has('--skip')
    ? applyQuiet({ muted: false, skipTools: names, onlyTools: [] }, 'Skipping these tools')
    : applyQuiet({ muted: false, onlyTools: names, skipTools: [] }, 'Notifying for these tools only');
}

/* ----------------------------------------------------------------- doctor */

async function doctor() {
  console.log(`\n${c.b('tapproval — diagnostics')}\n`);
  const cfg = load();

  const found = resolveConfigPath();
  if (!found) bad('no config — run setup');
  else if (found !== CONFIG_PATH) warn(`config ${found} (old location — the next write moves it to ${CONFIG_PATH})`);
  else ok(`config ${found}`);
  ok(`mode: ${cfg.mode}`);
  cfg.deviceId ? ok('device id set') : bad('no device id');

  if (cfg.mode === 'hosted') {
    cfg.machineToken ? ok('machine token set') : bad('machine token missing — run setup');
    cfg.payloadKey ? ok('payload key set') : bad('payload key missing — run setup (phones cannot decrypt without it)');
  } else {
    cfg.onesignalAppId ? ok('OneSignal app id set') : bad('OneSignal app id missing');
    cfg.onesignalApiKey ? ok('OneSignal API key set') : bad('OneSignal API key missing');
  }

  existsSync(HOOK_CONFIG_PATH) ? ok(`hook config ${HOOK_CONFIG_PATH}`) : bad('hook config missing');

  // Worth stating plainly, because it is the answer to "why didn't my phone buzz?"
  // when the answer is "because you were at the keyboard, which is the point".
  cfg.graceSec > 0
    ? ok(`holding the push ${cfg.graceSec}s — answering in the terminal first means no notification`)
    : ok('notifying immediately (no grace period)');

  // The first thing to check when "the phone stopped buzzing": it may be on purpose.
  if (cfg.muted) {
    warn('muted — no prompt reaches the phone (tapproval unmute)');
  } else if (cfg.onlyTools.length) {
    warn(`notifying for ${cfg.onlyTools.join(', ')} only — everything else goes to the terminal`);
  } else if (cfg.skipTools.length) {
    ok(`notifying for everything except ${cfg.skipTools.join(', ')}`);
  } else {
    ok('notifying for every prompt');
  }

  // Is the hook actually registered, and did the agent eat it?
  try {
    const s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    const cmd = s.hooks?.PermissionRequest?.[0]?.hooks?.[0]?.command;
    if (cmd?.includes('permission-hook')) {
      ok('PermissionRequest hook registered');

      // The command is an absolute path, so it can rot: an npx-cache install that
      // got pruned, or a global package removed without running `uninstall`. The
      // hook then fails safe and every prompt goes to the terminal — correct, but
      // indistinguishable from "nothing is wrong" unless we check the path.
      const hookPath = cmd.replace(/^node\s+/, '').replace(/^["']|["']$/g, '');
      if (!hookPath.startsWith('npx ') && !existsSync(hookPath)) {
        bad(`hook command points at a file that does not exist:\n      ${hookPath}`);
        bad('re-run setup: npx tapproval setup');
      } else if (ephemeralInstallReason(hookPath)) {
        // Written by a version that pointed the hook straight into the cache. It
        // works right now, which is the trap — re-running setup vendors it.
        bad(`hook runs from the ${ephemeralInstallReason(hookPath)} — npm will delete it, and approvals will go quiet with no error`);
        bad('run: npx tapproval setup   (it will copy the runtime somewhere permanent)');
      } else if (hookPath.startsWith(RUNTIME_DIR)) {
        // Vendored. Worth naming the version, because a stale one is invisible
        // otherwise: `npx tapproval@latest` upgrades the CLI you just ran and
        // nothing else until setup repoints the hook.
        const running = pkg().version;
        const installed = hookPath.slice(RUNTIME_DIR.length + 1).split(/[/\\]/)[0];
        installed === running
          ? ok(`hook runs from the vendored runtime (${installed})`)
          : warn(`hook runs vendored runtime ${installed}, but this CLI is ${running} — run setup to repoint it`);
      }

      // The hook can legitimately be busy for the grace period *and* the wait, so
      // the kill timeout has to clear both. Comparing against the wait alone let a
      // grace period silently push the total past the kill.
      const needed = cfg.timeoutSec + cfg.graceSec;
      const t = s.hooks.PermissionRequest[0].hooks[0].timeout ?? 60;
      t > needed
        ? ok(`hook timeout ${t}s > grace ${cfg.graceSec}s + wait ${cfg.timeoutSec}s`)
        : bad(`hook timeout ${t}s must exceed grace ${cfg.graceSec}s + wait ${cfg.timeoutSec}s — it will be killed mid-wait. Re-run setup.`);
    } else {
      bad('PermissionRequest hook NOT registered — run setup, then restart your agent');
    }

    // The reconcile hook is what records the prompts you answer at the keyboard.
    // Missing it costs no safety and no approvals — only history — so it is a
    // warning, and it names the fix. It has to be on all three events: PostToolUse
    // sees an approval, Stop sees a refusal, SessionEnd cleans up.
    const events = ['PostToolUse', 'Stop', 'SessionEnd'];
    const missing = events.filter((e) => !(s.hooks?.[e] ?? []).some((g) =>
      (g.hooks ?? []).some((h) => h.command?.includes('reconcile-hook'))));
    if (!missing.length) {
      ok('reconcile hook registered (records what you decide in the terminal)');
    } else {
      warn(`reconcile hook missing on ${missing.join(', ')} — prompts you answer in the terminal will not reach your history. Run: tapproval setup`);
    }
  } catch {
    bad(`cannot read ${SETTINGS_PATH}`);
  }

  if (cfg.mode === 'hosted') {
    await probeHosted(cfg);
    await probeRealtime(cfg);
  } else {
    await probe(`http://localhost:${cfg.port}/api/pending`, cfg.deviceId, 'local server');
    if (cfg.publicUrl) await probe(`${cfg.publicUrl}/api/pending`, cfg.deviceId, 'public tunnel');
  }

  console.log('');
}

/**
 * One request proves three things: the API is up, the machine token is accepted,
 * and the device has not been revoked. A 404 for a request id that cannot exist is
 * the success case — it means we got past auth.
 */
/**
 * Does the server still hold a live device for this machine token?
 *
 * Asks for a request id that cannot exist: 404 means the token authenticated and
 * the lookup simply found nothing, 401 means the device is gone or revoked. Any
 * other answer — network down, deployment broken — is treated as "still live", so
 * a flaky connection cannot talk `setup` into discarding a working registration
 * and orphaning the phones paired to it.
 */
async function deviceStillLive(apiBase, machineToken) {
  try {
    const res = await fetch(`${apiBase}/api/request?id=00000000-0000-0000-0000-000000000000`, {
      headers: { authorization: `Bearer ${machineToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status !== 401;
  } catch {
    return true;
  }
}

async function probeHosted(cfg) {
  const url = `${cfg.apiBase}/api/request?id=00000000-0000-0000-0000-000000000000`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.machineToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return ok(`API reachable, device active (${cfg.apiBase})`);
    if (res.status === 401) return bad('API rejected the machine token — device revoked, or stale config. Run setup.');
    bad(`API returned HTTP ${res.status} — ${cfg.apiBase}`);
  } catch (e) {
    bad(`API unreachable (${cfg.apiBase}) — ${e.message}`);
  }
}

/** Realtime is the return path. If it cannot connect, every approval falls back to polling. */
async function probeRealtime(cfg) {
  if (typeof WebSocket === 'undefined') {
    return warn(`Node ${process.versions.node} has no global WebSocket — approvals will use the polling fallback. Node 22+ removes the extra latency.`);
  }
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
    return bad('no Realtime credentials in config — run setup (approvals would fall back to polling)');
  }
  const wsUrl = `${cfg.supabaseUrl.replace(/^http/, 'ws')}/realtime/v1/websocket`
    + `?apikey=${encodeURIComponent(cfg.supabaseAnonKey)}&vsn=1.0.0`;
  const outcome = await new Promise((resolve) => {
    let ws;
    const timer = setTimeout(() => { try { ws?.close(); } catch {} resolve('timed out'); }, 8000);
    try {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(null); };
      ws.onerror = () => { clearTimeout(timer); resolve('handshake failed'); };
    } catch (e) {
      clearTimeout(timer);
      resolve(e.message);
    }
  });
  outcome
    ? bad(`Realtime not connectable (${outcome}) — approvals will use the polling fallback`)
    : ok('Realtime connectable');
}

async function probe(url, token, label) {
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return ok(`${label} reachable (${url})`);
    if (res.status === 401) return bad(`${label} rejected the device id — stale config?`);
    bad(`${label} returned HTTP ${res.status} — ${url}`);
  } catch (e) {
    bad(`${label} unreachable (${url}) — ${e.message}`);
  }
}

/* ------------------------------------------------------------------ utils */

function run(cmd, args, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, ...env } });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
  });
}

const HELP = `
${c.b('tapproval')} — approve your agent's permission prompts from your phone

  ${c.b('npx tapproval setup')}   no install needed — setup copies its own runtime
  ${c.b('npm i -g tapproval')}    or install it properly, if you prefer

  ${c.b('tapproval setup')}      register + install the hook + pair a phone
  ${c.b('tapproval pair')}       pair another phone (asks iPhone / Android / desktop)
  ${c.b('tapproval doctor')}     diagnose a setup that isn't working
  ${c.b('tapproval uninstall')}  remove the hook

  ${c.b('mute')} / ${c.b('unmute')}                  stop / resume phone notifications
  ${c.b('notify Bash Edit')}                buzz for these tools only
  ${c.b('notify --skip Read Glob')}         buzz for everything except these
  ${c.b('notify --all')}                    buzz for every prompt (the default)
  ${c.b('notify --grace=10')}               hold the push 10s (default 30, 0 = at once)

  ${c.b('pair --ios')} / ${c.b('--android')} / ${c.b('--desktop')}   skip the question
  ${c.b('pair --code')}                     just a code, for an already-installed app

  ${c.b('setup --self-hosted')}            your own OneSignal app + tunnel
  ${c.b('start')}                          run the local server (self-hosted only)

Config: ${CONFIG_PATH}
`;

/** Read from package.json rather than duplicated here, so it cannot drift. */
function version() {
  const { version } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  console.log(version);
}

const [, , cmd] = process.argv;
const commands = {
  setup,
  pair,
  start,
  doctor,
  mute,
  unmute,
  notify,
  uninstall,
  version,
  '--version': version,
  '-v': version,
};

if (!commands[cmd]) {
  console.log(HELP);
  process.exit(cmd ? 1 : 0);
}
// Promise.resolve, because not every command is async: `version` is synchronous,
// and `start` returns undefined on the hosted path where there is nothing to run.
await Promise.resolve(commands[cmd]()).catch((e) => { bad(e.message); process.exit(1); });
