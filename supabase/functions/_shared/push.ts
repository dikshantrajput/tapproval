/**
 * OneSignal, outbound only.
 *
 * The push carries a generic title and body and NO payload. The command lives in
 * `payload_ciphertext` in Postgres and is fetched and decrypted by the service
 * worker, which then re-renders the notification body in place. Even if that
 * fails the user still gets a tappable notification — they just see
 * "Tap to review" instead of the command.
 *
 * The one thing that must never happen is plaintext reaching OneSignal. There is
 * no branch below that puts request content into the push.
 */

import { env } from './env.ts';

const GENERIC_BODY = 'Tap to review';

export interface PushArgs {
  deviceId: string;
  requestId: string;
  tool: string;
  base: string;
  ttlSec: number;
}

export async function sendPush(
  { deviceId, requestId, tool, base, ttlSec }: PushArgs,
): Promise<{ warning?: string }> {
  const appId = env('ONESIGNAL_APP_ID');
  const apiKey = env('ONESIGNAL_API_KEY');
  if (!appId || !apiKey) throw new Error('OneSignal not configured');

  // AskUserQuestion asks for a choice, not permission. The tool name is all we know
  // here — and it is enough to know that Approve/Deny is the wrong shape, so the
  // inline verdict buttons are left off and the only path is the option list on the
  // page. (The worker re-shapes the body once it can decrypt the questions.)
  const asking = tool === 'AskUserQuestion';

  const body = {
    app_id: appId,
    target_channel: 'push',
    include_aliases: { external_id: [deviceId] },
    // Tool name only. The server knows it; it is not the command.
    headings: { en: asking ? 'Claude needs your answer' : `Approve ${tool}?` },
    contents: { en: GENERIC_BODY },
    // Body tap (the only option on iOS) opens the full review page.
    url: `${base}/r/${requestId}`,
    // Reaches the service worker: the id it needs to fetch and decrypt.
    data: { request_id: requestId },
    // Surfaces as the notification tag — both a fallback carrier for the id and
    // the handle the worker uses to replace the body after decrypting.
    web_push_topic: requestId,
    // The notification's own artwork. Generic on purpose — it is the product
    // mark, not the request, and it is the one part of the push OneSignal is
    // allowed to see.
    chrome_web_icon: `${base}/icon-192.png`,
    chrome_web_badge: `${base}/favicon-32.png`,
    // Chrome/Android render these inline, max 2. iOS ignores them entirely.
    // The URLs are the desktop fallback; on Android the worker answers by fetch
    // before any navigation would happen.
    //
    // A real icon per button rather than an emoji in the label: Chrome draws the
    // icon at full colour in its own slot, so the green tick and the red cross
    // read at a glance, and the label gets the full width for the word. Emoji had
    // to share that width and rendered as flat glyphs on several launchers.
    ...(asking ? {} : {
      web_buttons: [
        {
          id: 'allow',
          text: 'Approve',
          icon: `${base}/action-allow.png`,
          url: `${base}/r/${requestId}?a=allow`,
        },
        {
          id: 'deny',
          text: 'Deny',
          icon: `${base}/action-deny.png`,
          url: `${base}/r/${requestId}?a=deny`,
        },
      ],
    }),
    ttl: Math.max(30, Math.min(ttlSec, 600)),
    priority: 10,
  };

  const res = await fetch('https://api.onesignal.com/notifications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Key ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const out = await res.json().catch(() => ({} as Record<string, unknown>));
  if (!res.ok) throw new Error(`onesignal ${res.status}`);

  // The delivery verdict, and the only place it is visible. `recipients: 0`
  // means OneSignal accepted the call and matched nobody — the alias never
  // registered, or the subscription is gone. No id means it was not queued at
  // all. Neither raises, so without this line a dropped push looks identical to
  // a delivered one. Contains no request content.
  console.log(
    '[push] onesignal',
    JSON.stringify({
      id: out.id ?? null,
      recipients: out.recipients ?? null,
      errors: out.errors ?? null,
    }).slice(0, 400),
  );

  // "no subscribers" comes back 200 with an errors array — the phone never
  // paired, or unsubscribed. Worth surfacing to the hook's stderr.
  if (out.errors) return { warning: JSON.stringify(out.errors).slice(0, 200) };
  if (!out.recipients) return { warning: 'onesignal matched 0 recipients' };
  return {};
}

/**
 * DRY_RUN: no push, no phone needed. Prints where to answer instead. This is how
 * every earlier transport bug was found, so it survives into hosted mode.
 */
export function dryRunPush(
  { requestId, tool, base }: { requestId: string; tool: string; base: string },
): { dryRun: true } {
  console.log(`[dry-run] ${tool} → ${requestId}`);
  console.log(`[dry-run]   review: ${base}/r/${requestId}`);
  // Same rule as the real push: a question has no allow/deny answer, so it is not
  // offered one here either. Printing the verdict links would invite a dry run to
  // settle a question with a verdict the tool cannot use.
  if (tool === 'AskUserQuestion') {
    console.log(`[dry-run]   (question — pick an option on the page)`);
  } else {
    console.log(`[dry-run]   allow:  ${base}/r/${requestId}?a=allow`);
    console.log(`[dry-run]   deny:   ${base}/r/${requestId}?a=deny`);
  }
  return { dryRun: true };
}
