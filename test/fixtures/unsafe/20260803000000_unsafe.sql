create table public.audit_log (
  id bigint generated always as identity primary key,
  payload jsonb
);

create table public.secrets (
  id bigint generated always as identity primary key,
  owner_id uuid
);

grant all privileges on table public.secrets to authenticated;

alter table public.secrets enable row level security;

create policy "open writes"
on public.secrets
for update
to authenticated
using (true);

create policy "metadata authorization"
on public.secrets
for select
to authenticated
using (auth.role() = 'authenticated' and auth.jwt() -> 'user_metadata' ->> 'admin' = 'true');

create policy "per-row auth call"
on public.secrets
for select
to authenticated
using (auth.uid() = owner_id);

create view public.all_secrets
as select * from public.secrets;

create function public.read_everything()
returns setof public.secrets
language sql
security definer
as $$ select * from public.secrets $$;

drop table if exists public.legacy_secrets;

alter table auth.users add column if not exists unsafe_flag boolean;
