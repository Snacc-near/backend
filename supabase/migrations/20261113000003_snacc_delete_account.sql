-- UI-148: let a signed-in player delete their own Snacc account.
-- Deleting the auth user cascades to every *_snacc row that references it (profiles, activity,
-- notifications, prefs, achievements, follows); starter_claims_snacc keeps the claim with
-- user_id set to null so a deleted account cannot claim the starter pack twice.
-- Only users that own a Snacc profile can be deleted here: the project is shared, and this
-- function must never act on another app's users.

create or replace function public.snacc_delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles_snacc where user_id = uid) then
    raise exception 'no Snacc profile for this user' using errcode = 'P0002';
  end if;
  delete from auth.users where id = uid;
end;
$$;

revoke all on function public.snacc_delete_my_account() from public, anon;
grant execute on function public.snacc_delete_my_account() to authenticated;
