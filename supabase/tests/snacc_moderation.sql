-- UI-162 moderation / admin assertions. Run as postgres AFTER migration 20261113000011.
-- One transaction, rolled back. A failed check raises "FAIL ..."; success ends with the notice
-- "ALL SNACC MODERATION CHECKS PASSED".

begin;

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-5acc-4000-8000-0000000000a1', 'authenticated', 'authenticated', 'near-mod-check-a@snacc-nu.vercel.app'),
  ('aaaaaaaa-5acc-4000-8000-0000000000a2', 'authenticated', 'authenticated', 'near-mod-check-b@snacc-nu.vercel.app');
insert into public.profiles_snacc (user_id, near_account_id) values
  ('aaaaaaaa-5acc-4000-8000-0000000000a1', 'mod-check-admin.testnet'),
  ('aaaaaaaa-5acc-4000-8000-0000000000a2', 'mod-check-player.testnet');
insert into public.admins_snacc (user_id) values ('aaaaaaaa-5acc-4000-8000-0000000000a1');

-- Normalisation and rules (as owner).
do $$
begin
  if public.snacc_normalize_text('Sn4cc_T3am.') <> 'snaccteam' then raise exception 'FAIL normalize'; end if;
  if public.snacc_text_violation('admin', true) is distinct from 'reserved' then raise exception 'FAIL reserved exact'; end if;
  if public.snacc_text_violation('admin_42', true) is distinct from 'reserved' then raise exception 'FAIL reserved + digits'; end if;
  if public.snacc_text_violation('near_fan', true) is not null then raise exception 'FAIL reserved word inside a longer name must pass'; end if;
  if public.snacc_text_violation('lab_keeper', true) is not null then raise exception 'FAIL ordinary name'; end if;
  if public.snacc_text_violation('sh1t_lord', true) is distinct from 'abusive' then raise exception 'FAIL leet abusive'; end if;
  if public.snacc_text_violation('I feed my Snacc daily', false) is not null then raise exception 'FAIL ordinary bio'; end if;
  if public.snacc_text_violation('admin', false) is not null then raise exception 'FAIL reserved words are fine in a bio'; end if;
end $$;

-- Player B (not admin).
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-5acc-4000-8000-0000000000a2","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-5acc-4000-8000-0000000000a2', true);
do $$
declare ok boolean;
begin
  update public.profiles_snacc set username = 'cell_tamer' where user_id = 'aaaaaaaa-5acc-4000-8000-0000000000a2';
  begin
    update public.profiles_snacc set username = 'snacc' where user_id = 'aaaaaaaa-5acc-4000-8000-0000000000a2';
    raise exception 'FAIL reserved username accepted';
  exception when others then
    if sqlerrm <> 'username_not_allowed' then raise; end if;
  end;
  begin
    update public.profiles_snacc set bio = 'total b1tch' where user_id = 'aaaaaaaa-5acc-4000-8000-0000000000a2';
    raise exception 'FAIL abusive bio accepted';
  exception when others then
    if sqlerrm <> 'bio_not_allowed' then raise; end if;
  end;
  if public.snacc_is_admin() then raise exception 'FAIL player is admin'; end if;
  begin
    perform public.snacc_admin_broadcast('Hello lab', 'x', 1);
    raise exception 'FAIL non-admin broadcast';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.snacc_admin_reset_profile_text('mod-check-player.testnet');
    raise exception 'FAIL non-admin reset';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.announcements_snacc (title) values ('sneaky');
    raise exception 'FAIL client insert into announcements';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.admins_snacc;
    raise exception 'FAIL client can read admins';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Admin A.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-5acc-4000-8000-0000000000a1","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-5acc-4000-8000-0000000000a1', true);
do $$
declare n integer;
begin
  if not public.snacc_is_admin() then raise exception 'FAIL admin not recognised'; end if;
  n := public.snacc_admin_broadcast('Lab maintenance tonight', 'Testnet RPC may be slow for an hour.', 2);
  if n < 2 then raise exception 'FAIL broadcast reached % profiles', n; end if;
  if not public.snacc_admin_reset_profile_text('mod-check-player.testnet') then raise exception 'FAIL reset returned false'; end if;
  perform public.snacc_admin_block_term('Gr3mlin', 'abusive');
end $$;
reset role;

do $$
begin
  if (select username from public.profiles_snacc where near_account_id = 'mod-check-player.testnet') is not null then
    raise exception 'FAIL username not cleared';
  end if;
  if not exists (select 1 from public.notifications_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-0000000000a2' and title = 'Your profile name was reset') then
    raise exception 'FAIL reset notification missing';
  end if;
  if not exists (select 1 from public.blocked_terms_snacc where term = 'gremiin' or term = 'gremlin') then
    raise exception 'FAIL admin term not stored';
  end if;
end $$;

-- anon sees live announcements only, cannot call admin RPCs.
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  if not exists (select 1 from public.announcements_snacc where title = 'Lab maintenance tonight') then
    raise exception 'FAIL anon cannot read the live announcement';
  end if;
  begin
    perform public.snacc_is_admin();
    raise exception 'FAIL anon can call snacc_is_admin';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

do $$ begin raise notice 'ALL SNACC MODERATION CHECKS PASSED'; end $$;

rollback;
