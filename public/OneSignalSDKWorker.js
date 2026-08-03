importScripts('/aap-crypto.js');

/* OneSignal's own SDK is imported at the BOTTOM of this file, not here, and the
 * order is load-bearing — see the note above the import. Nothing in this file
 * runs at import time, so the listeners below are registered first either way. */

/** Chrome and friends. iOS is left on OneSignal's own click path — see below. */
const IS_IOS = /iPad|iPhone|iPod/.test(self.navigator?.userAgent ?? '');

/**
 * Android Chrome will not foreground itself to open an action button's URL
 * when the browser is backgrounded — the click fires here but the navigation
 * is dropped. So we answer straight from the service worker with a fetch(),
 * which needs no window at all.
 *
 * Body taps are handled here too, everywhere except iOS: OneSignal's launch-URL
 * navigation loses to an already-open tab and lands on the marketing page.
 *
 * Hosted mode adds a second job. The push deliberately carries no payload — only
 * "Approve Bash?" and "Tap to review" — because OneSignal must never see a
 * command. The real body is fetched and decrypted here, then written into the
 * notification in place. Every step of that is best-effort: if the key is
 * missing, the fetch fails, or decryption fails, the generic notification simply
 * stays as it is. Nothing here can leak plaintext into the push, and nothing here
 * can decide anything on its own.
 */

/** OneSignal nests custom data differently across versions — go find it. */
function findRequestId(notification) {
  const seen = new Set();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 5 || seen.has(o)) return null;
    seen.add(o);
    if (typeof o.request_id === 'string') return o.request_id;
    for (const v of Object.values(o)) {
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };

  const id = walk(notification.data, 0);
  if (id) return id;
  // web_push_topic surfaces as the notification tag — our fallback carrier.
  // Self-hosted ids are 32 hex; hosted ids are uuids.
  const tag = notification.tag || '';
  return /^[a-f0-9]{32}$/.test(tag) || /^[0-9a-f-]{36}$/i.test(tag) ? tag : null;
}

/* -------------------------------------------------- answering (do not simplify) */

self.addEventListener('notificationclick', (event) => {
  const verdict = event.action;
  const id = findRequestId(event.notification);

  if (verdict === 'allow' || verdict === 'deny') {
    if (!id) return;
    event.notification.close();
    event.waitUntil(answer(id, verdict));
    return;
  }

  // Body tap. OneSignal used to own this, and on Android without the app
  // installed it lands on the marketing page instead of the request: the launch
  // URL is only honoured when there is no window to reuse, and an already-open
  // tab gets focused wherever it happens to be sitting. From here the request id
  // is in hand, so navigate to it ourselves and stop the SDK's handler from
  // running a second, conflicting navigation.
  //
  // iOS is deliberately excluded. The body tap is the ONLY way to answer there,
  // OneSignal's path already works, and `clients.navigate` / `openWindow` are
  // exactly the calls WebKit is unreliable about — taking over would risk a tap
  // that opens nothing at all on the one platform with no fallback.
  if (IS_IOS) return;

  event.stopImmediatePropagation();
  event.notification.close();
  event.waitUntil(openReview(id));
});

/**
 * Focus the request, wherever a window for it already is.
 *
 * `navigate()` on an existing client rather than a bare `focus()`: the phone
 * almost always has a tab open from pairing, and focusing it without navigating
 * is precisely the bug — you get whatever page that tab was on. `openWindow` is
 * the fallback for the no-window case and for a client that refuses to navigate.
 */
async function openReview(id) {
  // No id means this is one of our own outcome notifications, or a push we could
  // not parse. The app root still resolves to something useful: it looks for a
  // pending request on boot.
  const target = new URL(id ? `/r/${id}` : '/app', self.registration.scope).href;
  const origin = new URL(target).origin;

  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of windows) {
    if (new URL(client.url).origin !== origin) continue;
    try {
      if (!client.navigate) continue;
      const navigated = await client.navigate(target);
      await (navigated ?? client).focus();
      return;
    } catch {
      // Cross-origin, uncontrolled, or WebKit. Try the next window, then a new one.
    }
  }
  await self.clients.openWindow(target).catch(() => {});
}

async function answer(id, verdict) {
  // Hosted mode authenticates with this phone's own token; self-hosted has none
  // and the request id is the capability. Sending an empty header in that case is
  // harmless — the self-hosted server ignores it.
  let phoneToken = '';
  try { ({ phoneToken } = await self.AAP.loadSecrets()); } catch {}

  let out = null;
  try {
    const res = await fetch('/api/decide', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(phoneToken ? { authorization: `Bearer ${phoneToken}` } : {}),
      },
      body: JSON.stringify({ id, verdict, source: 'sw' }),
    });
    out = await res.json().catch(() => null);
  } catch {}

  // A tap that decided nothing must say so. The button closes the notification
  // before the fetch even starts (it has to — the OS wants the click handled),
  // so silence here reads exactly like success: the notification vanishes and
  // the machine does nothing. This is the case where the terminal already
  // answered, or the hook stopped waiting and the row was withdrawn.
  if (out && out.applied) return;
  await self.registration.showNotification(
    out?.status === 'cancelled' ? 'No longer waiting'
      : out?.status === 'expired' ? 'Timed out'
      : out ? 'Already answered'
      : 'Answer not delivered',
    {
      body: out?.status === 'cancelled'
          ? 'Your machine stopped waiting — answered in the terminal, or dismissed.'
        : out?.status === 'expired'
          ? 'This expired before your answer arrived. Nothing was decided.'
        : out
          ? `Recorded answer: ${
              out.status === 'allow' ? 'approved'
                : out.status === 'deny' ? 'denied'
                : out.status === 'answer' ? 'an option was already chosen'
                // Settled at the keyboard before this tap arrived, and now
                // recorded as such. Saying where matters: otherwise this reads as
                // another device having answered.
                : out.status === 'local_allow' ? 'approved in the terminal'
                : out.status === 'local_deny' ? 'denied in the terminal'
                : out.status === 'local_answer' ? 'answered in the terminal'
                : out.status
            }.`
          : 'Could not reach your machine. Nothing was decided.',
      tag: `${id}:outcome`,
      data: { request_id: id, outcome: true },
    },
  ).catch(() => {});
}

/* --------------------------------------------------- filling in the real body */

/**
 * Races OneSignal's own push handler, which shows the generic notification. This
 * listener is registered first now (the SDK is imported last, for the click
 * ordering), so it may well start before the generic one is on screen — which is
 * what the backoff in `fillInBody` is waiting for. We then re-show under the tag
 * that notification actually has, with `renotify: false`, replacing the content
 * in place without buzzing the phone a second time.
 */
self.addEventListener('push', (event) => {
  let id = null;
  try {
    const raw = event.data?.json?.();
    id = raw ? findRequestId({ data: raw, tag: '' }) : null;
  } catch {}
  if (!id) return;
  event.waitUntil(fillInBody(id));
});

async function fillInBody(id) {
  try {
    const { payloadKey, phoneToken } = await self.AAP.loadSecrets();
    if (!payloadKey || !phoneToken) return;             // not paired in hosted mode

    const res = await fetch(`/api/request?id=${encodeURIComponent(id)}`, {
      headers: { authorization: `Bearer ${phoneToken}` },
    });
    if (!res.ok) return;
    const r = await res.json();
    if (r.status !== 'pending' || !r.payload_ciphertext) return;

    const { summary, questions } = await self.AAP.decryptPayload(payloadKey, r.payload_ciphertext);
    if (!summary) return;

    // A question has no allow/deny answer. Dropping the actions here is not
    // cosmetic: an "Approve" button on a question would answer it with a verdict
    // the tool cannot use, and the notification would vanish having decided
    // nothing. The body tap opens the option list, which is the only real answer.
    const asking = Array.isArray(questions) && questions.length > 0;

    // OneSignal may not have rendered yet. Retry a few times, backing off, before
    // giving up on the race.
    let existing = await notificationsFor(id);
    for (const wait of [400, 700, 1200]) {
      if (existing.length) break;
      await new Promise((r) => setTimeout(r, wait));
      existing = await notificationsFor(id);
    }

    // Never show a second notification we cannot prove is a replacement.
    //
    // Showing regardless is what puts "Tap to review" and the decrypted body on
    // screen together. Two separate things have to hold for the replacement to
    // land, and on iOS neither reliably does: the tag has to match (OneSignal
    // does not carry `web_push_topic` through as the tag there), and anything
    // under a different tag has to be closable — which needs `getNotifications()`
    // to enumerate it, and WebKit returns an empty list. Both failures look the
    // same from here: we cannot see the notification we were sent to rewrite.
    //
    // So an empty list is treated as "cannot replace", not "nothing there". The
    // generic notification stays and stays alone; the real text is one tap away
    // on the review page, which is the only path iOS has anyway. Where
    // enumeration works — Android, desktop Chrome — nothing about this changes.
    if (!existing.length) return;

    // Anything already under our tag is replaced in place by the show below,
    // silently. Anything under a *different* tag would survive it and leave two
    // notifications on screen, so close those explicitly first.
    for (const n of existing) if (n.tag !== id) n.close();

    // Replace under the tag the notification on screen actually has, not the tag
    // we wish it had. On Android those are the same string and nothing changes.
    // On iOS OneSignal does not carry `web_push_topic` through as the tag, so
    // showing under `id` *adds* a notification rather than replacing one — and
    // `close()` above is unreliable in WebKit, so the generic "Tap to review" is
    // still sitting there. That is the two-notifications-per-request case: one
    // generic, one with the real body. Matching the live tag makes the OS do the
    // replacement for us, which is the one mechanism that does work there.
    const tag = existing[0]?.tag || id;

    // A question's content is the question and its options, so put them where a
    // notification is actually read: the question in the title, the option labels
    // in the body. "Claude needs your answer" over the question text wasted the
    // one line the OS shows in full on the thing the user already knows.
    // Verdict requests keep the shape they had — the tool name is the title and
    // the command is the body.
    const q = asking ? questions[0] : null;
    const title = q
      ? (q.question.length > 64 ? `${q.question.slice(0, 63)}…` : q.question)
      : (existing[0]?.title ?? `Approve ${r.tool}?`);
    const body = q
      ? [
        (q.options ?? []).map((o) => o.label).filter(Boolean).join(' · '),
        questions.length > 1 ? `+${questions.length - 1} more to answer` : '',
      ].filter(Boolean).join('\n').slice(0, 180)
      : summary.slice(0, 180);

    await self.registration.showNotification(title, {
      body,
      tag,
      renotify: false,          // replace in place, do not alert again
      requireInteraction: true,
      data: { request_id: id },
      icon: '/icon-192.png',
      // A mask, not a picture: Android keeps only the alpha channel here. The
      // favicon that used to be in this slot is an opaque square, so it masked
      // down to a blank blob. See scripts/make-action-icons.mjs.
      badge: '/notification-badge.png',
      // Android renders these; iOS ignores the array entirely and always has.
      //
      // `icon` per action instead of an emoji in the title: Chrome gives the icon
      // its own slot, so the tick and the cross are legible at a glance and the
      // label keeps the full width. Same two PNGs the push itself references, so
      // the button looks identical before and after this replacement — the user
      // does not see the notification change shape under their thumb.
      actions: asking ? [] : [
        { action: 'allow', title: 'Approve', icon: '/action-allow.png' },
        { action: 'deny', title: 'Deny', icon: '/action-deny.png' },
      ],
    });

    // The pre-show close only covers what had rendered by then. OneSignal's own
    // notification can still land after ours, under its own tag, and survive the
    // replacement — the same duplicate, arriving in the other order. Sweep once
    // more and drop anything for this id that is not the one we just wrote.
    // Keyed on `tag`, not `id`: that is the tag our own notification went out
    // under, and comparing against `id` would close the replacement itself
    // wherever the two differ.
    // Swept twice, 800ms and 3s. Once was enough when OneSignal's own handler ran
    // first; now that this listener is registered ahead of it (the SDK is imported
    // last, for the click ordering) the generic notification can land noticeably
    // later, and a single sweep can run before the duplicate it was meant to
    // remove exists. The second pass costs one enumeration and closes nothing on
    // the common path.
    for (const wait of [800, 2200]) {
      await new Promise((r) => setTimeout(r, wait));
      for (const n of await notificationsFor(id)) if (n.tag !== tag) n.close();
    }
  } catch {
    // Generic notification stays. Never a thrown error, never a leaked plaintext.
  }
}

/**
 * Every notification on screen that belongs to this request.
 *
 * Filtering by tag alone is not enough. OneSignal does not put the same tag on
 * the notification across platforms — on iOS the generic one lands under a
 * different tag (or none), the tag lookup misses, and re-showing then *adds* a
 * second notification rather than replacing the first: the user sees "Tap to
 * review" and the decrypted body side by side. So match on the request id
 * wherever it is carried — data payload or tag — and let the caller close what
 * the tag would not have replaced.
 */
async function notificationsFor(id) {
  const all = await self.registration.getNotifications();
  return all.filter((n) => n.tag === id || findRequestId(n) === id);
}

/* ------------------------------------------------------ OneSignal, imported last
 *
 * Deliberately the last line in the file, and not for tidiness.
 *
 * `importScripts` registers the SDK's own `notificationclick` and `push`
 * listeners at the moment it runs, and listeners on the same target fire in
 * registration order. Ours must be first, because a body tap calls
 * `stopImmediatePropagation()` to keep the SDK from running its own navigation
 * on top of the one we just did. Move this back to the top of the file and
 * Android goes back to opening the marketing page on a notification tap.
 */
importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js');
