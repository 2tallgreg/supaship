create table public.appraisals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id),
  address text not null
);

alter table public.appraisals enable row level security;

grant select, insert, update on table public.appraisals to authenticated;
revoke all on table public.appraisals from anon;

create policy "owners can read appraisals"
on public.appraisals
for select
to authenticated
using ((select auth.uid()) = owner_id);

create policy "owners can update appraisals"
on public.appraisals
for update
to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

create view public.appraisal_addresses
with (security_invoker = true)
as select id, address from public.appraisals;

create schema if not exists private;

create function private.is_appraisal_owner(appraisal_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.appraisals
    where id = appraisal_id
      and owner_id = (select auth.uid())
  );
$$;

revoke execute on function private.is_appraisal_owner(uuid)
from public, anon, authenticated, service_role;
