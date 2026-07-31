-- Realtime on `requests` only.
--
-- This is the hook's return path and the reason hosted mode is viable at all:
-- Vercel functions cannot hold a connection open, and short-polling a 90s wait
-- would burn ~45 invocations per approval. The websocket costs zero.
--
-- `requests` is the only table in the publication. devices, phones and
-- pair_codes hold tokens and payload keys and must never stream anywhere.

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

do $$
begin
  alter publication supabase_realtime add table public.requests;
exception when duplicate_object then
  null;
end;
$$;

-- Realtime sends the changed row; the hook filters on `id`. Default replica
-- identity (primary key) is enough for that and keeps the WAL small — we never
-- need the OLD row.
alter table public.requests replica identity default;
