-- Inbound SMS/MMS for POST https://theapexworks.com/api/sms.
-- Apply in the Supabase SQL editor for project kolahmdxqsgnfljuaquz
-- (the project apex-flow.html already uses). The webhook writes with
-- SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS. There is no anon policy:
-- the public anon key must not be able to read these messages.

create table if not exists public.apex_sms_inbound (
  id bigint generated always as identity primary key,
  received_at timestamptz not null default now(),
  "from" text not null,
  "to" text not null,
  body text,
  media_urls text[] not null default '{}',
  sid text not null unique
);

alter table public.apex_sms_inbound enable row level security;

revoke all on table public.apex_sms_inbound from public, anon, authenticated;
