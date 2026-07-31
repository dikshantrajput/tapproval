# Troubleshooting

[← back to the README](../README.md)

---

Run `doctor` first. Then:

**Nothing happens on a permission prompt.**
The hook isn't registered or wasn't reloaded. Check
`jq '.hooks.PermissionRequest' ~/.claude/settings.json`, then restart the
agent. A session started before install rewrites settings from its startup
snapshot and deletes the hook.

**It worked for a while, then silently stopped.**
`doctor` — the likely answer is a hook path that no longer exists. Either the
global package was removed without running `uninstall`, or an older version pointed
the hook into an npx cache that npm has since pruned. `npx tapproval setup` fixes
both: it copies the runtime to `~/.tapproval/runtime/` and repoints the hook there.
The hook fails safe while broken, so every prompt goes to the terminal and nothing
is auto-approved — which is also why it is easy to miss.

**Prompts reach the phone late, or the terminal prompt appears while my phone is
still buzzing.**
The two are related: the push is held back by `graceSec` and the agent kills the
hook at `graceSec + timeoutSec + 60`. If you edited either value in
`config.json` by hand, the kill timeout did not move with it. Re-run `setup`, or
set the grace period with `tapproval notify --grace=N`, which does it for you. See
[Tuning it](internals.md#tuning-it).

**The phone never buzzes, but `doctor` is all green.**
Check the grace period line. At `graceSec: 30` a prompt you answer within thirty
seconds is *designed* to never reach your phone — `doctor` prints the value for
exactly this reason. `tapproval notify --grace=0` to see a push immediately.

**Notification arrives, buttons do nothing (Android).**
Stale service worker. Chrome → Settings → Site settings → your domain →
**Clear & reset**, reload, re-subscribe. Verify by opening
`https://<domain>/OneSignalSDKWorker.js` — you should see a
`notificationclick` handler, not just the imports.

**Notification says "Tap to review" instead of the command.**
The worker couldn't decrypt: it has no key (phone paired before this feature, or
`localStorage` cleared), or the fetch failed. Re-pair. The notification is still
answerable — only the preview is missing.

**The page says "Cannot read this request".**
This phone holds the wrong payload key — usually because `setup` was re-run and
generated a new one. `tapproval pair` and scan again.

**Notification tap opens the app but shows the pairing screen.**
The phone isn't paired, or the request already expired. Re-run `pair`.

**Two identical "Thanks for subscribing" notifications.**
OneSignal's Welcome Notification. Settings → Web Configuration → disable. It
double-fires because subscribing and then `login()` both trigger it.

**`doctor` says the API rejected the machine token.**
The device was revoked, or the config is stale. Run `setup` again — it will
register a new device, and you'll need to re-pair your phones.

**Self-hosted: everything looks right but nothing reaches the server.**
Your tunnel is dead. Free ngrok issues a new URL on every restart:
`curl -s -o /dev/null -w '%{http_code}\n' https://<domain>/api/config`
→ anything other than 401 and the tunnel is down. Claim a static domain.
Also: `pkill -f "node server.mjs"` often fails to free the port and the
replacement then silently fails to bind, so you test stale code. Use
`lsof -ti:8787 | xargs kill -9`.

**The phone says Approved but the terminal didn't move.**
The hook wasn't waiting — it never ran. See the first item.

---
