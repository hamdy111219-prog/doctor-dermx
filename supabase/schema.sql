-- supabase/schema.sql
-- Run this in Supabase -> SQL Editor.
--
-- ⚠️  PROTOTYPE ONLY. The policies below are intentionally permissive so the demo
--     works without auth. Do NOT use these settings with real patient data.

-- 1) Table to store completed cases ------------------------------------------
create table if not exists public.sessions (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  image_path      text,
  answers         jsonb not null default '[]'::jsonb,
  result          jsonb not null default '{}'::jsonb,
  most_likely     text,
  top_probability numeric
);

alter table public.sessions enable row level security;

-- The save-session function uses the SERVICE ROLE key, which bypasses RLS, so the
-- table can stay locked to the public/anon role. (No anon policy needed for writes.)
-- If you want to read sessions from the browser for a prototype dashboard, add:
--
-- create policy "anon can read sessions (prototype)"
--   on public.sessions for select
--   to anon using (true);


-- 2) Storage bucket for the cropped images -----------------------------------
insert into storage.buckets (id, name, public)
values ('skin-images', 'skin-images', true)
on conflict (id) do nothing;

-- Allow the browser (anon) to upload to the bucket. Prototype-only.
create policy "anon can upload skin images (prototype)"
  on storage.objects for insert
  to anon
  with check (bucket_id = 'skin-images');

-- Allow public read of the uploaded images (so they can be displayed). Prototype-only.
create policy "public can read skin images (prototype)"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'skin-images');
