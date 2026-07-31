-- agent-approvals — hosted multi-tenant schema.
--
-- Every table is RLS-protected. The API routes talk to Postgres with the
-- service_role key and scope every query explicitly; RLS is the second wall,
-- the one that holds when a handler has a bug. The only client that talks to
-- Postgres directly is the hook's Realtime subscription, and it arrives with a
-- device-scoped JWT (see 0002_realtime.sql).
--
-- Nothing here can hold a plaintext command: `requests.payload_ciphertext` is
-- AES-256-GCM and the key never reaches the server.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- devices ---
-- One row per laptop. `machine_token_hash` is sha256(machineToken) hex — the
-- token itself exists only in ~/.agent-approvals/config.json.
create table if not exists public.devices (
  id                 uuid primary key default gen_random_uuid(),
  machine_token_hash text        not null unique,
  label              text,
  revoked_at         timestamptz,
  created_at         timestamptz not null default now()
);

-- ----------------------------------------------------------------- phones ---
-- One row per paired phone, so a lost phone is revocable on its own without
-- re-pairing the others.
create table if not exists public.phones (
  id               uuid primary key default gen_random_uuid(),
  device_id        uuid        not null references public.devices(id) on delete cascade,
  phone_token_hash text        not null unique,
  user_agent       text,
  revoked_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists phones_device_idx on public.phones (device_id);

-- ------------------------------------------------------------- pair_codes ---
-- Short-lived, single-use. `payload_key` is the ONE place the server holds the
-- encryption key, and only until the phone claims it — /api/claim nulls it in
-- the same statement that stamps claimed_at.
create table if not exists public.pair_codes (
  code        text primary key,
  device_id   uuid        not null references public.devices(id) on delete cascade,
  payload_key text,
  expires_at  timestamptz not null,
  claimed_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists pair_codes_device_idx on public.pair_codes (device_id, created_at desc);

-- --------------------------------------------------------------- requests ---
-- `expires_at` mirrors the hook's own wait exactly. Past it, nobody is
-- listening, so a late tap must be told "timed out" rather than reported as a
-- success. `status` is the single source of truth for that.
create table if not exists public.requests (
  id                 uuid primary key default gen_random_uuid(),
  device_id          uuid        not null references public.devices(id) on delete cascade,
  tool               text        not null default 'unknown',
  payload_ciphertext text        not null,
  status             text        not null default 'pending'
                       check (status in ('pending', 'allow', 'deny', 'expired')),
  note               text,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         uuid references public.phones(id) on delete set null
);
create index if not exists requests_device_pending_idx
  on public.requests (device_id, created_at desc) where status = 'pending';
create index if not exists requests_expiry_idx on public.requests (expires_at);

-- -------------------------------------------------------------------- RLS ---
-- Deny by default, everywhere. service_role bypasses RLS, which is how the API
-- routes work; no policy below grants anon or authenticated any write.
alter table public.devices    enable row level security;
alter table public.phones     enable row level security;
alter table public.pair_codes enable row level security;
alter table public.requests   enable row level security;

alter table public.devices    force row level security;
alter table public.phones     force row level security;
alter table public.pair_codes force row level security;
alter table public.requests   force row level security;

-- devices / phones / pair_codes get NO policies at all: unreachable except via
-- service_role. Tokens and payload keys live here.

-- The hook's Realtime subscription is the one direct client read. Its JWT
-- carries a device_id claim minted by /api/notify, and it may see only its own
-- rows. A handler bug cannot widen this.
drop policy if exists requests_own_device_select on public.requests;
create policy requests_own_device_select
  on public.requests
  for select
  to authenticated
  using (device_id::text = (auth.jwt() ->> 'device_id'));

-- ----------------------------------------------------------------- grants ---
-- Supabase grants anon and authenticated broad access to new public tables by
-- default. RLS would still hold, but defence in depth means the roles should not
-- have the privilege in the first place: tokens and payload keys must be
-- unreachable even if a policy is added by accident later.
revoke all on public.devices    from anon, authenticated;
revoke all on public.phones     from anon, authenticated;
revoke all on public.pair_codes from anon, authenticated;
revoke all on public.requests   from anon, authenticated;

-- The single exception, and the narrowest one that works: the hook's Realtime
-- subscription needs SELECT, and the policy above confines it to its own device.
grant select on public.requests to authenticated;

-- ---------------------------------------------------------------- sweeper ---
-- Two jobs: flip pending → expired so a late tap gets an honest answer, and
-- delete anything nobody can act on any more. Payload ciphertext is dropped
-- with the row; nothing accumulates.
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
end;
$$;

revoke all on function public.sweep_expired() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'agent-approvals-sweep',
      '* * * * *',
      $cron$select public.sweep_expired()$cron$
    );
  end if;
exception when others then
  raise notice 'pg_cron not scheduled: %', sqlerrm;
end;
$$;
