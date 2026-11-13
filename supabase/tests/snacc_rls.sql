-- Snacc RLS / privilege assertions. Run as the migration owner (postgres) AFTER the core migration:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/snacc_rls.sql      (or paste into the SQL editor)
-- Everything runs in one transaction and is rolled back: no rows are left behind. Any failed check
-- raises an exception whose message starts with "FAIL". Success ends with the notice
-- "ALL SNACC RLS CHECKS PASSED".
-- Note: fixture users are inserted into auth.users inside the transaction; if another app in this
-- shared project has an auth.users trigger that rejects them, the script fails before any check.

begin;

-- ---------------------------------------------------------------------------------------------
-- Fixtures (as owner). User A = ...0001, user B = ...0002.
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-5acc-4000-8000-000000000001', 'authenticated', 'authenticated', 'near-rls-check-a@snacc-nu.vercel.app'),
  ('aaaaaaaa-5acc-4000-8000-000000000002', 'authenticated', 'authenticated', 'near-rls-check-b@snacc-nu.vercel.app');

insert into public.profiles_snacc (user_id, near_account_id) values
  ('aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet'),
  ('aaaaaaaa-5acc-4000-8000-000000000002', 'rls-check-b.testnet');

insert into public.notifications_snacc (user_id, kind, title, dedupe_key) values
  ('aaaaaaaa-5acc-4000-8000-000000000001', 'system', 'for A', 'rls-check:a'),
  ('aaaaaaaa-5acc-4000-8000-000000000002', 'system', 'for B', 'rls-check:b');

insert into public.auth_nonces_snacc (nonce, account_id, expires_at) values
  ('rls-check-nonce', 'rls-check-a.testnet', now() + interval '5 minutes');
insert into public.starter_claims_snacc (near_account_id, user_id, amount_yocto) values
  ('rls-check-a.testnet', 'aaaaaaaa-5acc-4000-8000-000000000001', '300000000000000000000000');
insert into public.scan_state_snacc (user_id, near_account_id) values
  ('aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet');

-- ---------------------------------------------------------------------------------------------
-- Achievements trigger + streaks view (as owner = what the record-tx service role does)
-- ---------------------------------------------------------------------------------------------
insert into public.activity_snacc (tx_hash, user_id, near_account_id, method, strain_id, block_time) values
  ('RLSa111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'incubate_strain', 1, now() - interval '2 days'),
  ('RLSb111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'feed_strain', 1, now() - interval '2 days'),
  ('RLSc111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'feed_strain', 1, now() - interval '1 day'),
  ('RLSd111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'feed_strain', 1, now()),
  ('RLSe111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'nft_transfer', 1, now());
-- duplicate tx_hash is ignored (record-tx is idempotent)
insert into public.activity_snacc (tx_hash, user_id, near_account_id, method, strain_id, block_time) values
  ('RLSe111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'nft_transfer', 1, now())
  on conflict (tx_hash) do nothing;

do $$
declare
  got text;
  streak integer;
begin
  -- quest_* badges (UI-153) depend on which three daily quests the date picks: covered by snacc_quests_seasons.sql
  select string_agg(code, ',' order by code) into got
  from public.achievements_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001' and code not like 'quest\_%';
  if got is distinct from 'first_feed,first_hatch,gifter,streak_3' then
    raise exception 'FAIL achievements: expected first_feed,first_hatch,gifter,streak_3, got %', got;
  end if;
  select current_streak_days into streak from public.streaks_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
  if streak is distinct from 3 then
    raise exception 'FAIL streaks_snacc: expected 3, got %', streak;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- anon
-- ---------------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  begin
    insert into public.profiles_snacc (user_id, near_account_id) values ('aaaaaaaa-5acc-4000-8000-000000000003', 'rls-check-x.testnet');
    raise exception 'FAIL anon inserted into profiles_snacc';
  exception when insufficient_privilege then null;
  end;
  if (select count(*) from public.profiles_snacc where near_account_id like 'rls-check-%') <> 2 then
    raise exception 'FAIL anon cannot read profiles_snacc';
  end if;
  begin
    update public.profiles_snacc set username = 'anon_edit' where near_account_id = 'rls-check-a.testnet';
    raise exception 'FAIL anon updated profiles_snacc';
  exception when insufficient_privilege then null;
  end;
  begin perform 1 from public.auth_nonces_snacc; raise exception 'FAIL anon read auth_nonces_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.notifications_snacc; raise exception 'FAIL anon read notifications_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.notification_prefs_snacc; raise exception 'FAIL anon read notification_prefs_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.starter_claims_snacc; raise exception 'FAIL anon read starter_claims_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.scan_state_snacc; raise exception 'FAIL anon read scan_state_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.scan_queue_snacc; raise exception 'FAIL anon read scan_queue_snacc';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.activity_snacc (tx_hash, user_id, near_account_id, method, block_time)
    values ('RLSf111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'feed_strain', now());
    raise exception 'FAIL anon inserted into activity_snacc';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.follows_snacc (follower, followee) values ('aaaaaaaa-5acc-4000-8000-000000000001', 'aaaaaaaa-5acc-4000-8000-000000000002');
    raise exception 'FAIL anon inserted into follows_snacc';
  exception when insufficient_privilege then null;
  end;
  -- public reads
  if (select count(*) from public.activity_snacc where near_account_id = 'rls-check-a.testnet') <> 5 then
    raise exception 'FAIL anon cannot read activity_snacc';
  end if;
  if (select count(*) from public.achievements_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001' and code not like 'quest\_%') <> 4 then
    raise exception 'FAIL anon cannot read achievements_snacc';
  end if;
  if (select current_streak_days from public.streaks_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001') is distinct from 3 then
    raise exception 'FAIL anon cannot read streaks_snacc';
  end if;
  perform 1 from public.follows_snacc;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- authenticated as user A
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-5acc-4000-8000-000000000001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-5acc-4000-8000-000000000001', true);

do $$
declare
  n integer;
begin
  if auth.uid() is distinct from 'aaaaaaaa-5acc-4000-8000-000000000001'::uuid then
    raise exception 'FAIL test setup: auth.uid() is %', auth.uid();
  end if;

  -- profiles: own row editable (allowed columns only), other rows untouched
  update public.profiles_snacc set username = 'rls_check_a', bio = 'hello' where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL A could not update own profile (rows=%)', n; end if;
  update public.profiles_snacc set username = 'rls_check_hijack' where user_id = 'aaaaaaaa-5acc-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL A updated profile of B'; end if;
  begin
    update public.profiles_snacc set near_account_id = 'evil.testnet' where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
    raise exception 'FAIL A changed own near_account_id';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.profiles_snacc set username = 'Bad Name!' where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
    raise exception 'FAIL invalid username accepted';
  exception when check_violation then null;
  end;
  begin
    update public.profiles_snacc set bio = repeat('x', 161) where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
    raise exception 'FAIL 161-char bio accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.profiles_snacc (user_id, near_account_id) values ('aaaaaaaa-5acc-4000-8000-000000000001', 'second.testnet');
    raise exception 'FAIL authenticated inserted into profiles_snacc';
  exception when insufficient_privilege then null;
  end;

  -- notifications: own only; only read_at writable; no inserts
  if (select count(*) from public.notifications_snacc) <> 1 then
    raise exception 'FAIL A sees notifications of other users';
  end if;
  update public.notifications_snacc set read_at = now() where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL A could not mark own notification read'; end if;
  update public.notifications_snacc set read_at = now() where user_id = 'aaaaaaaa-5acc-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL A marked notification of B'; end if;
  begin
    update public.notifications_snacc set title = 'edited' where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
    raise exception 'FAIL A edited notification title';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.notifications_snacc (user_id, kind, title) values ('aaaaaaaa-5acc-4000-8000-000000000001', 'system', 'self-made');
    raise exception 'FAIL authenticated inserted into notifications_snacc';
  exception when insufficient_privilege then null;
  end;

  -- prefs: own insert/update; not for others
  insert into public.notification_prefs_snacc (user_id, starving) values ('aaaaaaaa-5acc-4000-8000-000000000001', false);
  update public.notification_prefs_snacc set distressed = false where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL A could not update own prefs'; end if;
  begin
    insert into public.notification_prefs_snacc (user_id) values ('aaaaaaaa-5acc-4000-8000-000000000002');
    raise exception 'FAIL A inserted prefs for B';
  exception when insufficient_privilege then null;
  end;

  -- follows: as self only, no self-follow, own delete
  insert into public.follows_snacc (follower, followee) values ('aaaaaaaa-5acc-4000-8000-000000000001', 'aaaaaaaa-5acc-4000-8000-000000000002');
  begin
    insert into public.follows_snacc (follower, followee) values ('aaaaaaaa-5acc-4000-8000-000000000002', 'aaaaaaaa-5acc-4000-8000-000000000001');
    raise exception 'FAIL A inserted a follow as B';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.follows_snacc (follower, followee) values ('aaaaaaaa-5acc-4000-8000-000000000001', 'aaaaaaaa-5acc-4000-8000-000000000001');
    raise exception 'FAIL self-follow accepted';
  exception when check_violation then null;
  end;
  delete from public.follows_snacc where follower = 'aaaaaaaa-5acc-4000-8000-000000000001' and followee = 'aaaaaaaa-5acc-4000-8000-000000000002';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL A could not unfollow'; end if;

  -- service-only and trigger-only tables
  begin
    insert into public.achievements_snacc (user_id, code) values ('aaaaaaaa-5acc-4000-8000-000000000001', 'streak_7');
    raise exception 'FAIL authenticated inserted into achievements_snacc';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.activity_snacc (tx_hash, user_id, near_account_id, method, block_time)
    values ('RLSg111111111111111111111111111111111111111', 'aaaaaaaa-5acc-4000-8000-000000000001', 'rls-check-a.testnet', 'adopt', now());
    raise exception 'FAIL authenticated inserted into activity_snacc';
  exception when insufficient_privilege then null;
  end;
  begin perform 1 from public.auth_nonces_snacc; raise exception 'FAIL authenticated read auth_nonces_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.starter_claims_snacc; raise exception 'FAIL authenticated read starter_claims_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.scan_state_snacc; raise exception 'FAIL authenticated read scan_state_snacc';
  exception when insufficient_privilege then null; end;
  begin perform 1 from public.scan_queue_snacc; raise exception 'FAIL authenticated read scan_queue_snacc';
  exception when insufficient_privilege then null; end;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- authenticated as user B: sees only B's notifications and prefs
-- ---------------------------------------------------------------------------------------------
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-5acc-4000-8000-000000000002","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-5acc-4000-8000-000000000002', true);

do $$
begin
  if (select count(*) from public.notifications_snacc) <> 1
     or (select title from public.notifications_snacc limit 1) <> 'for B' then
    raise exception 'FAIL B notification visibility';
  end if;
  if (select count(*) from public.notification_prefs_snacc) <> 0 then
    raise exception 'FAIL B sees prefs of A';
  end if;
  if (select username from public.profiles_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-000000000001') is distinct from 'rls_check_a' then
    raise exception 'FAIL profile edit of A not visible to B';
  end if;
end $$;

reset role;

do $$ begin raise notice 'ALL SNACC RLS CHECKS PASSED'; end $$;

rollback;
