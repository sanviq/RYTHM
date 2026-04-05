-- Run once in Supabase SQL Editor so contact snapshots sync across localhost, Cloudflare, and devices.
-- (Browser localStorage is per-origin; this stores the same snapshot in your DB.)

alter table user_sheets add column if not exists contacts_cache jsonb;
alter table user_sheets add column if not exists contacts_cache_at timestamptz;

comment on column user_sheets.contacts_cache is 'Last fetched contacts JSON for cross-origin/device cache';
comment on column user_sheets.contacts_cache_at is 'When contacts_cache was written';
