#!/usr/bin/env node
/**
 * Appends our hooks to ~/.claude/settings.json.
 *
 * Two of them, and they are a pair:
 *
 *   PermissionRequest             asks the phone, and decides.
 *   PostToolUse / Stop /          records what the terminal decided when the
 *   SessionEnd                    phone did not answer. No decision, no stdout —
 *                                 it only fills in the history.
 *
 * Read → merge → verify → write. Backs up first, refuses to write if any
 * pre-existing key, hook, or permission entry would be lost. Idempotent.
 *
 *   node scripts/install-hook.mjs            # install
 *   node scripts/install-hook.mjs --remove   # uninstall
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

import { fileURLToPath } from 'node:url';

const SETTINGS = join(homedir(), '.claude', 'settings.json');

// Claude Code kills the hook at `timeout`. It must sit above the whole time the
// hook can legitimately take — the grace period it holds the push for, plus the
// wait for the phone — or we get killed mid-wait and the decision is lost.
let waitSec = 300;
let graceSec = 10;
try {
  const { load } = await import('../lib/config.mjs');
  ({ timeoutSec: waitSec, graceSec } = load());
} catch {}
const KILL_TIMEOUT = waitSec + graceSec + 60;

/**
 * Which copy of the package the hooks should be run from.
 *
 * Defaults to the one this script lives in, which is right for a global install.
 * `--root` overrides it, and the CLI passes the vendored copy under
 * ~/.tapproval/runtime/ when it was itself launched from a disposable npx cache —
 * the path written here is spawned on every permission prompt for months, so it
 * must not be a directory npm is free to delete.
 */
const rootFlag = process.argv.indexOf('--root');
const PKG_ROOT = rootFlag !== -1 && process.argv[rootFlag + 1]
  ? resolve(process.argv[rootFlag + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const hookPath = (name) => join(PKG_ROOT, 'hook', name);
const HOOK_CMD = `node ${hookPath('permission-hook.mjs')}`;
const RECONCILE_CMD = `node ${hookPath('reconcile-hook.mjs')}`;
const remove = process.argv.includes('--remove');

if (!remove && !existsSync(hookPath('permission-hook.mjs'))) {
  console.error(`ABORTED — no permission-hook.mjs under ${PKG_ROOT}`);
  console.error('The hook command would point at a file that does not exist.');
  process.exit(1);
}

/**
 * Every event we own, and what goes in it.
 *
 * The reconcile hook is registered three times on purpose. PostToolUse is the fast
 * path — the tool ran, so its prompt was approved, and for AskUserQuestion the
 * response carries the selection. Stop is where a refused call is picked up, since
 * a denied tool never reaches PostToolUse at all. SessionEnd is the last chance,
 * and the only place a trace nobody can explain gets cleaned up.
 *
 * It gets a short timeout: it makes at most one small HTTP call per unanswered
 * request and there is nothing waiting on its answer, so it must never be the
 * reason a session feels slow.
 */
const MANAGED = {
  PermissionRequest: [{
    // No matcher = every tool. "*" is NOT valid here — it's parsed as a
    // regex and throws "Nothing to repeat". Use ".*" or omit it.
    hooks: [{
      type: 'command',
      command: HOOK_CMD,
      timeout: KILL_TIMEOUT,
      statusMessage: 'Waiting for approval on your phone…',
    }],
  }],
  PostToolUse: [{ hooks: [{ type: 'command', command: RECONCILE_CMD, timeout: 15 }] }],
  Stop: [{ hooks: [{ type: 'command', command: RECONCILE_CMD, timeout: 20 }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: RECONCILE_CMD, timeout: 20 }] }],
};

/** Ours, by the only thing that identifies it: the script it runs. */
const isOurs = (group) => (group.hooks ?? []).some((h) =>
  h.command?.includes('permission-hook.mjs') || h.command?.includes('reconcile-hook.mjs'));

// A user who has never edited settings.json has no file — and on a truly fresh
// machine, no ~/.claude either. That is the common case for a first install, not
// an error, so start from an empty object rather than an ENOENT stack trace.
// `--remove` against a missing file is a no-op, which is the right answer too.
if (!existsSync(SETTINGS)) {
  if (remove) {
    console.log('no settings.json — nothing to remove');
    process.exit(0);
  }
  mkdirSync(dirname(SETTINGS), { recursive: true });
  writeFileSync(SETTINGS, '{}\n');
}

const before = readFileSync(SETTINGS, 'utf8');
let s;
try {
  s = JSON.parse(before);
} catch (err) {
  // Never overwrite a file we cannot parse — it is the user's, it has their
  // permissions in it, and a truncated write would cost them all of it.
  console.error(`ABORTED — ${SETTINGS} is not valid JSON (${err.message}).`);
  console.error('Fix or move it, then re-run.');
  process.exit(1);
}
if (s === null || typeof s !== 'object' || Array.isArray(s)) {
  console.error(`ABORTED — ${SETTINGS} does not contain a JSON object.`);
  process.exit(1);
}

/**
 * Everything in `hooks` that is not ours, flattened for comparison.
 *
 * The verify step at the bottom is the whole reason this script is careful, and
 * now that we write four event keys instead of one it has to be finer-grained than
 * "these keys are untouched": PostToolUse and Stop are popular, and a user who
 * already has hooks there must get them back byte-for-byte. So the snapshot is of
 * the individual groups we do not own, across every event.
 */
const foreignHooks = (settings) =>
  Object.entries(settings.hooks ?? {})
    .flatMap(([event, groups]) => (Array.isArray(groups) ? groups : [])
      .filter((g) => !isOurs(g))
      .map((g) => `${event}:${JSON.stringify(g)}`))
    .sort();

// Snapshot everything we must not lose.
const snapshot = {
  keys: Object.keys(s).sort(),
  allow: s.permissions?.allow?.length ?? 0,
  deny: s.permissions?.deny?.length ?? 0,
  ask: s.permissions?.ask?.length ?? 0,
  foreign: foreignHooks(s),
};

s.hooks ??= {};

// Strip ours from every event first, including events we no longer manage — an
// upgrade from a version that registered a hook somewhere else must not leave it
// behind, orphaned and still firing.
let existing = 0;
for (const event of Object.keys(s.hooks)) {
  if (!Array.isArray(s.hooks[event])) continue;
  const ours = s.hooks[event].filter(isOurs).length;
  existing += ours;
  s.hooks[event] = s.hooks[event].filter((g) => !isOurs(g));
}

if (!remove) {
  for (const [event, groups] of Object.entries(MANAGED)) {
    s.hooks[event] ??= [];
    s.hooks[event].push(...groups);
  }
}

// Drop any event we emptied, so we leave no debris.
for (const event of Object.keys(s.hooks)) {
  if (Array.isArray(s.hooks[event]) && s.hooks[event].length === 0) delete s.hooks[event];
}
// Deliberate, so the lost-keys check below has to know about it: on a machine
// that had no settings.json before we installed, `hooks` is the only top-level
// key, and removing our hooks empties it. Without this exemption `--remove`
// aborts with "lost top-level key: hooks" and the hooks can never be uninstalled.
let droppedHooks = false;
if (Object.keys(s.hooks).length === 0) {
  delete s.hooks;
  droppedHooks = true;
}

// --- verify nothing was lost before writing a single byte ------------------
const after = {
  keys: Object.keys(s).sort(),
  allow: s.permissions?.allow?.length ?? 0,
  deny: s.permissions?.deny?.length ?? 0,
  ask: s.permissions?.ask?.length ?? 0,
  foreign: foreignHooks(s),
};

const problems = [];
for (const k of snapshot.keys) {
  if (after.keys.includes(k)) continue;
  if (k === 'hooks' && droppedHooks) continue;   // emptied by our own removal
  problems.push(`lost top-level key: ${k}`);
}
for (const f of ['allow', 'deny', 'ask']) {
  if (after[f] < snapshot[f]) problems.push(`permissions.${f} shrank ${snapshot[f]} → ${after[f]}`);
}
for (const h of snapshot.foreign) {
  if (!after.foreign.includes(h)) problems.push(`lost hook: ${h.split(':')[0]}`);
}
if (problems.length) {
  console.error('ABORTED — refusing to write:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const backup = `${SETTINGS}.bak`;
copyFileSync(SETTINGS, backup);
writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + '\n');

// Re-read to prove valid JSON landed on disk.
JSON.parse(readFileSync(SETTINGS, 'utf8'));

const events = Object.keys(MANAGED).join(', ');
console.log(remove
  ? `removed our hooks (${existing} entr${existing === 1 ? 'y' : 'ies'})`
  : `${existing ? 'replaced' : 'added'} hooks on ${events}`);
console.log(`  backup:      ${backup}`);
console.log(`  top-level:   ${after.keys.join(', ')}`);
console.log(`  permissions: allow=${after.allow} deny=${after.deny} ask=${after.ask} (unchanged)`);
console.log(`  hooks:       ${Object.keys(s.hooks ?? {}).join(', ') || '(none)'}`);
