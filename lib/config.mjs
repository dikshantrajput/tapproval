import {
  readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, readdirSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';

export const DIR = join(homedir(), '.tapproval');
export const CONFIG_PATH = join(DIR, 'config.json');
export const HOOK_CONFIG_PATH = join(homedir(), '.claude', 'tapproval.json');

// Pre-rename locations. Read-only: `load()` falls back to them so an existing
// install keeps working, and the next `save()` writes the new path. Nothing ever
// writes here again, and nothing deletes them either — leaving them costs a few
// hundred bytes and means a downgrade still finds its config.
const LEGACY_CONFIG_PATH = join(homedir(), '.agent-approvals', 'config.json');

/**
 * Which config file we are actually reading, or null if there is none.
 *
 * `doctor` has to ask this rather than testing CONFIG_PATH itself, or it reports
 * "no config — run setup" on a legacy install whose settings `load()` just read
 * perfectly well.
 */
export function resolveConfigPath() {
  if (existsSync(CONFIG_PATH)) return CONFIG_PATH;
  if (existsSync(LEGACY_CONFIG_PATH)) return LEGACY_CONFIG_PATH;
  return null;
}
export const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

/** Where `setup` points when nobody says otherwise. */
export const DEFAULT_API_BASE = 'https://tapproval.vercel.app';

/**
 * Is this copy of the package living somewhere npm will delete?
 *
 * `setup` writes an absolute path to hook/permission-hook.mjs into
 * ~/.claude/settings.json, because Claude Code runs that command on every prompt
 * and an `npx -y` per prompt would add a few hundred milliseconds to the one path
 * that has to feel instant.
 *
 * The cost of that choice is that the path has to outlive setup. Run via
 * `npx tapproval setup`, this package lives in ~/.npm/_npx/<hash>/ — a cache npm
 * prunes freely, and whose hash changes with every version. The hook would work
 * today and be gone next week, failing the way that is hardest to notice: no
 * error, just prompts that quietly stop reaching the phone.
 *
 * So `setup` does not point the hook at a cache. It copies itself somewhere
 * permanent first — see `vendorRuntime`. Detection is by path because there is no
 * reliable env var for it: npm sets npm_command=exec for both `npx foo` and
 * `npm exec foo`, and nothing at all when the binary is invoked directly from a
 * cache dir.
 */
export function ephemeralInstallReason(root) {
  const p = root.replaceAll('\\', '/');
  if (/\/_npx\//.test(p)) return 'npx cache';
  if (/\/\.npm\/_cacache\//.test(p)) return 'npm cache';
  if (/\/Caches\/(pnpm|yarn)\//.test(p) || /\/\.cache\/(pnpm|yarn)\//.test(p)) return 'package manager cache';
  return null;
}

/** Where a vendored copy of version X lives. One directory per version. */
export const RUNTIME_DIR = join(DIR, 'runtime');
export const runtimeRoot = (version) => join(RUNTIME_DIR, version);

/**
 * Copy this package out of a disposable cache into ~/.tapproval/runtime/<version>/,
 * and return the path the hook should be run from.
 *
 * What gets copied is the whole `node_modules` directory *containing* us, not just
 * our own files. `npx tapproval` builds a sandbox whose node_modules holds exactly
 * this package plus its dependencies, flat — so lifting that one directory brings
 * `@supabase/supabase-js` and its transitive tree along without this code having to
 * know the dependency graph, and Node's own resolution finds them from the copy
 * exactly as it did from the cache. Walking `require.resolve` instead would have to
 * re-derive that graph, and would silently miss anything loaded dynamically.
 *
 * Idempotent: a copy that already has our entry point in it is reused as-is, so
 * only the first `npx … setup` pays for the copy.
 */
export function vendorRuntime(srcRoot, { name, version }) {
  const dest = runtimeRoot(version);
  const pkgDir = join(dest, 'node_modules', name);
  const entry = join(pkgDir, 'hook', 'permission-hook.mjs');
  if (existsSync(entry)) return pkgDir;

  const parent = dirname(srcRoot);
  if (basename(parent) !== 'node_modules') {
    throw new Error(
      `cannot vendor from ${srcRoot} — expected it to sit inside a node_modules directory.\n`
      + '    Install globally instead:  npm i -g tapproval && tapproval setup',
    );
  }

  mkdirSync(RUNTIME_DIR, { recursive: true });
  // Into a scratch name first, then rename. A copy interrupted halfway leaves
  // debris rather than a runtime directory that looks complete and is not — and
  // the check above would then happily reuse it forever.
  const staging = `${dest}.partial`;
  rmSync(staging, { recursive: true, force: true });
  // `dereference`, because pnpm and yarn stores are largely symlinks into a
  // content-addressed directory that is itself prunable. Following them costs disk
  // and buys a copy that stands alone, which is the entire point.
  cpSync(parent, join(staging, 'node_modules'), { recursive: true, dereference: true });
  rmSync(dest, { recursive: true, force: true });
  // Node has no atomic dir swap; this is the closest thing, and the window between
  // the two calls is the only moment a concurrent hook could miss the directory.
  renameOrCopy(staging, dest);
  return pkgDir;
}

/**
 * Both paths are under ~/.tapproval by construction, so the rename is same-device
 * and atomic. A home directory that spans mounts is not unheard of though, and
 * there the rename throws EXDEV — so fall back to a plain copy rather than
 * failing setup over a filesystem layout.
 */
function renameOrCopy(from, to) {
  try {
    renameSync(from, to);
  } catch {
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

/**
 * Delete every vendored runtime except the one named.
 *
 * Safe only immediately before or after the hook is repointed, which is the only
 * place it is called from: the directories being removed are referenced by nothing
 * else on the machine.
 */
export function pruneRuntimes(keepVersion) {
  if (!existsSync(RUNTIME_DIR)) return [];
  const gone = [];
  for (const name of readdirSync(RUNTIME_DIR)) {
    if (name === keepVersion) continue;
    rmSync(join(RUNTIME_DIR, name), { recursive: true, force: true });
    gone.push(name);
  }
  // Keeping nothing means keeping no directory either — `uninstall` passes null,
  // and an empty runtime/ left in the home directory is just litter.
  if (keepVersion == null) rmSync(RUNTIME_DIR, { recursive: true, force: true });
  return gone;
}

export const DEFAULTS = {
  // 'hosted'      — our deployment: no OneSignal account, no tunnel, no server.
  // 'self-hosted' — your machine, your OneSignal app, your tunnel.
  mode: 'hosted',

  // hosted
  apiBase: '',
  machineToken: '',
  payloadKey: '',
  supabaseUrl: '',
  supabaseAnonKey: '',

  // self-hosted
  onesignalAppId: '',
  onesignalApiKey: '',
  publicUrl: '',
  port: 8787,

  // both
  deviceId: '',
  // Five minutes. The wait has to cover the whole physical path — the push lands,
  // the phone is picked up and unlocked, the PWA cold-starts, the command is read
  // and thought about — and on iOS that routinely ran past two minutes, which is
  // the worst possible outcome: the notification is answerable right up to the
  // moment the tap arrives too late. Nothing is spent while waiting (the hook is
  // parked on a websocket, not polling), so the cost of a longer wait is only that
  // an unanswered prompt takes longer to fall through to the terminal.
  timeoutSec: 300,

  // Hold the push back this long, in case you are already at the keyboard.
  //
  // The terminal prompt and this hook race each other, and when you are sitting at
  // the machine you win in a couple of seconds — long before you could have picked
  // up a phone. Without a pause the notification still arrives, for something
  // already decided, and a notification that is usually pointless is one you stop
  // reading. That pause is off by default so a prompt reaches the phone at once;
  // set a few seconds (e.g. `notify --grace=10`) if the duplicate pushes bother you.
  graceSec: 0,

  // Which prompts are worth a buzz.
  //
  // Left alone, every prompt the agent stops on reaches the phone — which is
  // right when you are away from the machine and spam when you are sitting at
  // it. All three are enforced in the hook, before anything is sent: a filtered
  // prompt produces no row, no push, and no network call at all, and falls
  // through to the terminal exactly like a timeout does.
  muted: false,
  // Notify for these tools only. Non-empty wins over skipTools.
  onlyTools: [],
  // Notify for everything except these.
  skipTools: [],
};

/** Accepts an array or a comma-separated string (the env form). */
export const toolList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((s) => String(s).trim())
  .filter(Boolean);

export function load() {
  let file = {};
  const path = resolveConfigPath();
  if (path) {
    try { file = JSON.parse(readFileSync(path, 'utf8')); } catch {}
  }
  // Env always wins, so CI and one-off overrides keep working.
  return {
    ...DEFAULTS,
    ...file,
    ...(process.env.AAP_MODE && { mode: process.env.AAP_MODE }),
    ...(process.env.AAP_API_BASE && { apiBase: process.env.AAP_API_BASE.replace(/\/$/, '') }),
    ...(process.env.ONESIGNAL_APP_ID && { onesignalAppId: process.env.ONESIGNAL_APP_ID }),
    ...(process.env.ONESIGNAL_API_KEY && { onesignalApiKey: process.env.ONESIGNAL_API_KEY }),
    ...(process.env.PUBLIC_URL && { publicUrl: process.env.PUBLIC_URL.replace(/\/$/, '') }),
    ...(process.env.DEVICE_ID && { deviceId: process.env.DEVICE_ID }),
    ...(process.env.PORT && { port: Number(process.env.PORT) }),
    ...(process.env.AAP_TIMEOUT && { timeoutSec: Number(process.env.AAP_TIMEOUT) }),
    ...(process.env.AAP_GRACE && { graceSec: Number(process.env.AAP_GRACE) }),
    ...(process.env.AAP_MUTE && { muted: process.env.AAP_MUTE === '1' }),
    ...(process.env.AAP_ONLY_TOOLS && { onlyTools: toolList(process.env.AAP_ONLY_TOOLS) }),
    ...(process.env.AAP_SKIP_TOOLS && { skipTools: toolList(process.env.AAP_SKIP_TOOLS) }),
  };
}

export function save(patch) {
  mkdirSync(DIR, { recursive: true });
  const next = { ...load(), ...patch };
  // 0600 — this file holds the machine token, the payload key, and (self-hosted)
  // the OneSignal REST key.
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/**
 * The hook reads its own small file so it never has to parse the main config.
 *
 * Hosted mode carries the machine token and the payload key: the token because
 * every notify is authenticated, the key because encryption happens in the hook,
 * on this machine, before anything is sent.
 */
export function writeHookConfig(cfg) {
  mkdirSync(join(homedir(), '.claude'), { recursive: true });
  // The filters live here too: the hook must be able to decide "not worth a buzz"
  // without reading the main config, which holds credentials it does not need.
  const quiet = {
    muted: cfg.muted === true,
    onlyTools: toolList(cfg.onlyTools),
    skipTools: toolList(cfg.skipTools),
  };
  const out = cfg.mode === 'hosted'
    ? {
        mode: 'hosted',
        apiBase: cfg.apiBase,
        deviceId: cfg.deviceId,
        machineToken: cfg.machineToken,
        payloadKey: cfg.payloadKey,
        supabaseUrl: cfg.supabaseUrl,
        supabaseAnonKey: cfg.supabaseAnonKey,
        timeoutSec: cfg.timeoutSec,
        graceSec: cfg.graceSec,
        ...quiet,
      }
    : {
        mode: 'self-hosted',
        url: `http://localhost:${cfg.port}`,
        deviceId: cfg.deviceId,
        timeoutSec: cfg.timeoutSec,
        graceSec: cfg.graceSec,
        ...quiet,
      };
  writeFileSync(HOOK_CONFIG_PATH, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
}
