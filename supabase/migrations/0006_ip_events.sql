-- Durable per-IP rate limiting for the two unauthenticated routes.
--
-- `/api/devices` and `/api/claim` have no token to key a limit on — that is the
-- whole point of them, and what makes `setup` promptless. Until now they leaned
-- on the in-memory bucket in _shared/base.ts, which cannot hold: an Edge Function
-- isolate is short-lived and there are several of them in parallel, so the real
-- ceiling was some unknown multiple of the number written down.
--
-- It matters more than it did. Now that /api/notify is capped per device, free
-- device registration is the obvious way around that cap — a thousand devices is
-- a thousand fresh budgets. A limit on creating them is what makes the per-device
-- limit mean anything.
--
-- One table for both routes rather than a column on `devices`, because a claim
-- attempt has nothing to hang a column on: the interesting event is the one that
-- FAILS, and a failed claim creates no row anywhere else. `kind` keeps the two
-- budgets independent.

create table if not exists public.ip_events (
  id         bigserial   primary key,
  -- sha256 hex, never the address. This table exists to say "too many from one
  -- place", which a hash answers exactly as well as an IP does — and an IP is
  -- the one piece of personal data this system otherwise never stores.
  ip_hash    text        not null,
  -- 'register' — POST /api/devices
  -- 'claim'    — POST /api/claim that did NOT find a live code. Successes are
  --              not counted: a real pairing is self-limiting (the code is
  --              single-use), and counting them would punish a phone that
  --              pairs, gets cleared, and pairs again.
  kind       text        not null check (kind in ('register', 'claim')),
  created_at timestamptz not null default now()
);

-- The only query: count one kind, from one hash, inside a window.
create index if not exists ip_events_lookup_idx
  on public.ip_events (ip_hash, kind, created_at desc);

alter table public.ip_events enable row level security;
alter table public.ip_events force row level security;

-- No policies, and no grants. Reachable only through service_role, like every
-- other table that holds something we would rather not hand out.
revoke all on public.ip_events from anon, authenticated;
revoke all on sequence public.ip_events_id_seq from anon, authenticated;

-- Folded into the existing sweeper rather than given its own job. Two days is
-- comfortably past the longest window any caller counts over (24h), and rows
-- older than that can only slow the index down.
create or replace function public.sweep_expired()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.requests
     set status = 'expired'
   where status = 'pending'
     and expires_at < now();

  delete from public.requests  where created_at < now() - interval '7 days';
  delete from public.pair_codes where expires_at < now() - interval '1 hour';
  delete from public.ip_events  where created_at < now() - interval '2 days';
end;
$$;

revoke all on function public.sweep_expired() from public, anon, authenticated;
