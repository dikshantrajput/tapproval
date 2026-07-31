/**
 * The small config the hooks read.
 *
 * Deliberately separate from lib/config.mjs: that one is the CLI's view, with the
 * OneSignal keys and the setup defaults in it. A hook needs the endpoint, the
 * credentials for it, the wait, and the filters — and it runs on every prompt, so
 * it reads one file and parses nothing else.
 *
 * Shared by the permission hook and the reconcile hook so the two cannot drift on
 * where the config lives or what a missing field means. Both of them then behave
 * identically when it is half-written, which is the state a first install is in.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// The second path is the pre-rename name, kept readable so an install that
// predates `tapproval` does not silently stop notifying. `setup` rewrites the
// new one, so this only ever matters until the next setup run.
export const CONFIG_PATHS = [
  join(homedir(), '.claude', 'tapproval.json')
];
export const CONFIG_PATH = CONFIG_PATHS[0];

/** How long the hook waits for the phone when nothing says otherwise. */
export const DEFAULT_TIMEOUT_SEC = 300;

/**
 * How long the push is held back so a keyboard answer can pre-empt it.
 *
 * Must match lib/config.mjs. It is duplicated rather than imported because this
 * file is the one the hook reads on every prompt, and it deliberately depends on
 * nothing — a half-written config has to still produce sane behaviour.
 */
export const DEFAULT_GRACE_SEC = 30;

/** Accepts an array or the comma-separated env form. */
export const toolList = (v) => (Array.isArray(v) ? v : String(v ?? '').split(','))
  .map((s) => String(s).trim())
  .filter(Boolean);

export function loadHookConfig() {
  let file = {};
  for (const p of CONFIG_PATHS) {
    try { file = JSON.parse(readFileSync(p, 'utf8')); break; } catch {}
  }
  const trim = (s) => (s ?? '').replace(/\/$/, '');
  return {
    mode: process.env.AAP_MODE ?? file.mode ?? 'self-hosted',
    // self-hosted: the local server. hosted: the deployment.
    url: trim(process.env.AAP_URL ?? file.url),
    apiBase: trim(process.env.AAP_API_BASE ?? file.apiBase ?? file.url),
    deviceId: process.env.AAP_DEVICE_ID ?? file.deviceId ?? '',
    machineToken: process.env.AAP_MACHINE_TOKEN ?? file.machineToken ?? '',
    payloadKey: process.env.AAP_PAYLOAD_KEY ?? file.payloadKey ?? '',
    supabaseUrl: trim(process.env.AAP_SUPABASE_URL ?? file.supabaseUrl),
    supabaseAnonKey: process.env.AAP_SUPABASE_ANON_KEY ?? file.supabaseAnonKey ?? '',
    timeoutSec: Number(process.env.AAP_TIMEOUT ?? file.timeoutSec ?? DEFAULT_TIMEOUT_SEC),
    graceSec: Number(process.env.AAP_GRACE ?? file.graceSec ?? DEFAULT_GRACE_SEC),

    // Which prompts are worth a buzz. Enforced in the permission hook, before
    // anything is sent.
    muted: (process.env.AAP_MUTE ?? '') === '1' || file.muted === true,
    onlyTools: toolList(process.env.AAP_ONLY_TOOLS ?? file.onlyTools),
    skipTools: toolList(process.env.AAP_SKIP_TOOLS ?? file.skipTools),
  };
}

/** Where this install's API lives, whichever mode it is in. */
export const endpoint = (cfg) => (cfg.mode === 'hosted' ? cfg.apiBase : cfg.url);
