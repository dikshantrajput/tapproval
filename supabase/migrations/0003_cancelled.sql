-- A fourth terminal status: `cancelled`.
--
-- Until now a request left `pending` only when the phone answered or the clock
-- ran out. But the hook can also stop listening early — the user answered the
-- prompt in the terminal, or hit escape, and Claude Code kills the hook. The row
-- stayed `pending` for the rest of its timeout, so tapping the notification
-- opened a live Approve/Deny screen for a question that had already been
-- answered somewhere else, and the tap did nothing.
--
-- `expired` would have been the cheap reuse, but it lies about why: nothing timed
-- out. The hook now marks the row `cancelled` on every give-up path, and the
-- phone says so.

alter table public.requests
  drop constraint if exists requests_status_check;

alter table public.requests
  add constraint requests_status_check
  check (status in ('pending', 'allow', 'deny', 'expired', 'cancelled'));


create index if not exists requests_device_history_idx
  on public.requests (device_id, created_at desc);