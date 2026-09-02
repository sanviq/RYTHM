-- Full Rythm schema. Run once in a fresh Supabase project (SQL Editor).
-- This matches the live database exactly.

create table if not exists public.user_sheets (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users (id) on delete cascade,
  sheet_url         text not null,
  tab_name          text not null,
  sheet_name        text not null,
  column_mapping    jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now()
);

-- App always filters by user_id and orders by created_at.
create index if not exists user_sheets_user_id_created_at_idx
  on public.user_sheets (user_id, created_at);

-- Without RLS the anon key would expose every user's sheets.
alter table public.user_sheets enable row level security;

drop policy if exists "Users read own sheets"   on public.user_sheets;
drop policy if exists "Users insert own sheets" on public.user_sheets;
drop policy if exists "Users update own sheets" on public.user_sheets;
drop policy if exists "Users delete own sheets" on public.user_sheets;

create policy "Users read own sheets"
  on public.user_sheets for select
  using (auth.uid() = user_id);

create policy "Users insert own sheets"
  on public.user_sheets for insert
  with check (auth.uid() = user_id);

create policy "Users update own sheets"
  on public.user_sheets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users delete own sheets"
  on public.user_sheets for delete
  using (auth.uid() = user_id);


-- Keepalive target for .github/workflows/keep-supabase-awake.yml.
--
-- The workflow used to read user_sheets, which RLS correctly answers with an
-- empty array for an unauthenticated caller. That reaches Postgres and so does
-- count as activity, but it leaves no trace, so there is no way to confirm from
-- the data that the pings are landing. This table is written instead: pinged_at
-- is the last time the keepalive actually ran.
--
-- The shape bounds what a hostile caller can do with the public anon key. `id`
-- is a boolean primary key constrained to true, so the table holds at most one
-- row, and only select and update are granted — no insert, no delete. The worst
-- available action is overwriting one timestamp that nothing depends on.
create table if not exists public.keepalive (
  id         boolean primary key default true check (id),
  pinged_at  timestamptz not null default now()
);

insert into public.keepalive (id) values (true) on conflict (id) do nothing;

alter table public.keepalive enable row level security;

drop policy if exists "Anyone may read the keepalive row"  on public.keepalive;
drop policy if exists "Anyone may touch the keepalive row" on public.keepalive;

create policy "Anyone may read the keepalive row"
  on public.keepalive for select
  using (true);

create policy "Anyone may touch the keepalive row"
  on public.keepalive for update
  using (true)
  with check (true);
