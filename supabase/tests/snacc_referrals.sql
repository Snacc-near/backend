-- Snacc referral assertions (UI-158). Run as the migration owner (postgres) AFTER migrations 0001, 0004 and 0007:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/snacc_referrals.sql      (or paste into the SQL editor)
-- One transaction, rolled back: no rows are left behind. Any failed check raises an exception whose
-- message starts with "FAIL". Success ends with the notice "ALL SNACC REFERRAL CHECKS PASSED".
-- Fixture users use ids cccccccc-5acc-4000-8000-00000000000N and accounts ref-check-*.testnet, and every
-- assertion that depends on shared data is scoped to them, so real players do not disturb the result.
--   1 = A referrer      2 = B referee (hatches)   3 = C hatched before claiming   4 = D second referee
--   5 = E outsider      6 = F auth user without a Snacc profile

begin;

-- ---------------------------------------------------------------------------------------------
-- Fixtures (as owner)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
select ('cccccccc-5acc-4000-8000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'near-ref-check-' || n || '@snacc-nu.vercel.app'
from generate_series(1, 6) n;

insert into public.profiles_snacc (user_id, near_account_id)
select ('cccccccc-5acc-4000-8000-00000000000' || n)::uuid, 'ref-check-' || chr(96 + n) || '.testnet'
from generate_series(1, 5) n;

create temp sequence snacc_ref_tx;

-- Unique, valid base58 transaction hash (44 chars, no 0/O/I/l).
create function pg_temp.txh() returns text language sql as $$
  select 'R' || lpad(translate(nextval('pg_temp.snacc_ref_tx')::text, '0123456789', 'ABCDEFGHJK'), 43, 'A')
$$;

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('cccccccc-5acc-4000-8000-00000000000' || n)::uuid
$$;

create function pg_temp.acct(n integer) returns text language sql as $$
  select 'ref-check-' || chr(96 + n) || '.testnet'
$$;

create function pg_temp.act(p_n integer, p_method text) returns void language plpgsql as $$
begin
  insert into public.activity_snacc (tx_hash, user_id, near_account_id, method, block_time)
  values (pg_temp.txh(), pg_temp.uid(p_n), pg_temp.acct(p_n), p_method, now());
end $$;

-- Point auth.uid() at fixture user n (call as owner, then `set local role authenticated`).
create function pg_temp.jwt(n integer) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', pg_temp.uid(n), 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', pg_temp.uid(n)::text, true);
end $$;

-- C hatched before it ever claims a referral.
select pg_temp.act(3, 'incubate_strain');

do $$
begin
  if exists (select 1 from public.achievements_snacc where code = 'recruiter' and user_id in (select pg_temp.uid(n) from generate_series(1, 6) n)) then
    raise exception 'FAIL setup: recruiter badge exists before any referral';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- anon: no RPC, no table, public counts view readable
-- ---------------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  begin
    perform public.snacc_claim_referral('ref-check-a.testnet');
    raise exception 'FAIL anon executed snacc_claim_referral';
  exception when insufficient_privilege then null;
  end;
  begin perform 1 from public.referrals_snacc; raise exception 'FAIL anon read referrals_snacc';
  exception when insufficient_privilege then null; end;
  begin
    insert into public.referrals_snacc (referee, referrer) values ('cccccccc-5acc-4000-8000-000000000002', 'cccccccc-5acc-4000-8000-000000000001');
    raise exception 'FAIL anon inserted into referrals_snacc';
  exception when insufficient_privilege then null;
  end;
  perform 1 from public.referral_counts_snacc;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- F: signed in, but has no Snacc profile
-- ---------------------------------------------------------------------------------------------
select pg_temp.jwt(6);
set local role authenticated;

do $$
declare s text;
begin
  if auth.uid() is distinct from 'cccccccc-5acc-4000-8000-000000000006'::uuid then
    raise exception 'FAIL test setup: auth.uid() is %', auth.uid();
  end if;
  s := public.snacc_claim_referral('ref-check-a.testnet');
  if s is distinct from 'no_profile' then raise exception 'FAIL player without a profile: got %', s; end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- A (the referrer): self-referral, bad input, no direct writes
-- ---------------------------------------------------------------------------------------------
select pg_temp.jwt(1);
set local role authenticated;

do $$
declare s text;
begin
  s := public.snacc_claim_referral('ref-check-a.testnet');
  if s is distinct from 'self_referral' then raise exception 'FAIL self-referral: got %', s; end if;
  s := public.snacc_claim_referral('nobody-here.testnet');
  if s is distinct from 'unknown_referrer' then raise exception 'FAIL unknown referrer: got %', s; end if;
  s := public.snacc_claim_referral('Bad Account!!');
  if s is distinct from 'invalid_account' then raise exception 'FAIL malformed account: got %', s; end if;
  s := public.snacc_claim_referral(null);
  if s is distinct from 'invalid_account' then raise exception 'FAIL null account: got %', s; end if;
  s := public.snacc_claim_referral(repeat('a', 65));
  if s is distinct from 'invalid_account' then raise exception 'FAIL 65-char account: got %', s; end if;
  if (select count(*) from public.referrals_snacc) <> 0 then raise exception 'FAIL refused claims left a row behind'; end if;

  begin
    insert into public.referrals_snacc (referee, referrer) values ('cccccccc-5acc-4000-8000-000000000001', 'cccccccc-5acc-4000-8000-000000000002');
    raise exception 'FAIL authenticated inserted into referrals_snacc';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.referrals_snacc set referrer = 'cccccccc-5acc-4000-8000-000000000001';
    raise exception 'FAIL authenticated updated referrals_snacc';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.referrals_snacc;
    raise exception 'FAIL authenticated deleted from referrals_snacc';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- C: already hatched, so it can no longer be referred
-- ---------------------------------------------------------------------------------------------
select pg_temp.jwt(3);
set local role authenticated;

do $$
declare s text;
begin
  s := public.snacc_claim_referral('ref-check-a.testnet');
  if s is distinct from 'not_new_player' then raise exception 'FAIL claim after hatching: got %', s; end if;
  if (select count(*) from public.referrals_snacc) <> 0 then raise exception 'FAIL claim after hatching left a row behind'; end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- B: a valid claim (input is trimmed and lower-cased), then a double claim and a switch are refused
-- ---------------------------------------------------------------------------------------------
select pg_temp.jwt(2);
set local role authenticated;

do $$
declare s text;
begin
  s := public.snacc_claim_referral('  REF-CHECK-A.testnet ');
  if s is distinct from 'claimed' then raise exception 'FAIL valid claim: got %', s; end if;
  s := public.snacc_claim_referral('ref-check-a.testnet');
  if s is distinct from 'already_referred' then raise exception 'FAIL double claim: got %', s; end if;
  s := public.snacc_claim_referral('ref-check-e.testnet');
  if s is distinct from 'already_referred' then raise exception 'FAIL switching referrer: got %', s; end if;
  if (select count(*) from public.referrals_snacc) <> 1 then raise exception 'FAIL B should see exactly its own referral'; end if;
end $$;

reset role;

-- D claims A as well
select pg_temp.jwt(4);
set local role authenticated;

do $$
declare s text;
begin
  s := public.snacc_claim_referral('ref-check-a.testnet');
  if s is distinct from 'claimed' then raise exception 'FAIL second valid claim: got %', s; end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- Badge: awarded to the referrer when a referee's FIRST hatch is recorded (as owner = record-tx)
-- ---------------------------------------------------------------------------------------------
do $$
declare
  n integer;
begin
  select count(*) into n from public.referrals_snacc where referrer = pg_temp.uid(1);
  if n <> 2 then raise exception 'FAIL expected 2 referrals for A, got %', n; end if;

  if exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(1) and code = 'recruiter') then
    raise exception 'FAIL recruiter awarded on claim, before any hatch';
  end if;

  perform pg_temp.act(2, 'feed_strain');
  if exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(1) and code = 'recruiter') then
    raise exception 'FAIL recruiter awarded for a referee feed, before the hatch';
  end if;

  perform pg_temp.act(2, 'incubate_strain');
  if not exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(1) and code = 'recruiter') then
    raise exception 'FAIL recruiter not awarded after the referee hatched';
  end if;
  if not exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(2) and code = 'first_hatch') then
    raise exception 'FAIL first_hatch no longer awarded to the referee';
  end if;
  if exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(2) and code = 'recruiter') then
    raise exception 'FAIL the referee got the recruiter badge';
  end if;

  -- a second hatch, a second referee and an outsider change nothing about the single badge
  perform pg_temp.act(2, 'incubate_strain');
  perform pg_temp.act(4, 'incubate_strain');
  perform pg_temp.act(5, 'incubate_strain');
  select count(*) into n from public.achievements_snacc
  where code = 'recruiter' and user_id in (select pg_temp.uid(k) from generate_series(1, 6) k);
  if n <> 1 then raise exception 'FAIL expected exactly one recruiter badge among the fixtures, got %', n; end if;
  if not exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(5) and code = 'first_hatch') then
    raise exception 'FAIL outsider lost first_hatch';
  end if;

  -- every code from 0001 and 0004 plus recruiter is still allowed; unknown codes are not
  insert into public.achievements_snacc (user_id, code)
  select pg_temp.uid(6), c
  from unnest(array['first_hatch', 'first_feed', 'feeds_10', 'streak_3', 'streak_7', 'rescuer', 'gifter', 'colony_5',
                    'quest_first', 'quest_streak_7', 'recruiter']) c;
  begin
    insert into public.achievements_snacc (user_id, code) values (pg_temp.uid(6), 'not_a_badge');
    raise exception 'FAIL unknown achievement code accepted';
  exception when check_violation then null;
  end;

  -- the quest logic from 0004 is still part of the trigger function
  if position('quest_streak_7' in pg_get_functiondef('public.snacc_award_achievements()'::regprocedure)) = 0
     or position('quest_first' in pg_get_functiondef('public.snacc_award_achievements()'::regprocedure)) = 0 then
    raise exception 'FAIL snacc_award_achievements() lost the quest logic';
  end if;
  if has_function_privilege('anon', 'public.snacc_award_achievements()', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.snacc_award_achievements()', 'EXECUTE') then
    raise exception 'FAIL snacc_award_achievements() is executable by an API role';
  end if;

  -- no self-referral even for the owner role
  begin
    insert into public.referrals_snacc (referee, referrer) values (pg_temp.uid(1), pg_temp.uid(1));
    raise exception 'FAIL self-referral row accepted';
  exception when check_violation then null;
  end;

  -- RPC privileges
  if has_function_privilege('anon', 'public.snacc_claim_referral(text)', 'EXECUTE') then
    raise exception 'FAIL anon can execute snacc_claim_referral';
  end if;
  if not has_function_privilege('authenticated', 'public.snacc_claim_referral(text)', 'EXECUTE') then
    raise exception 'FAIL authenticated cannot execute snacc_claim_referral';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Public counts view: aggregate only, readable by anon
-- ---------------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.sub', '', true);

do $$
declare
  r record;
begin
  select * into r from public.referral_counts_snacc where user_id = 'cccccccc-5acc-4000-8000-000000000001';
  if r.near_account_id is distinct from 'ref-check-a.testnet' or r.recruits is distinct from 2 or r.recruits_hatched is distinct from 2 then
    raise exception 'FAIL referral_counts_snacc for A: %', to_jsonb(r);
  end if;
  if (select count(*) from public.referral_counts_snacc where user_id = 'cccccccc-5acc-4000-8000-000000000005') <> 0 then
    raise exception 'FAIL referral_counts_snacc lists a player without recruits';
  end if;
  if (select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns
      where table_schema = 'public' and table_name = 'referral_counts_snacc') is distinct from 'user_id,near_account_id,recruits,recruits_hatched' then
    raise exception 'FAIL referral_counts_snacc exposes unexpected columns';
  end if;
end $$;

reset role;

-- ---------------------------------------------------------------------------------------------
-- RLS visibility: referrer and referee see their row, nobody else does
-- ---------------------------------------------------------------------------------------------
select pg_temp.jwt(1);
set local role authenticated;
do $$
begin
  if (select count(*) from public.referrals_snacc) <> 2 then raise exception 'FAIL referrer A should see 2 rows'; end if;
  if (select count(*) from public.referrals_snacc where referrer = auth.uid()) <> 2 then raise exception 'FAIL referrer A rows are not its own'; end if;
end $$;
reset role;

select pg_temp.jwt(2);
set local role authenticated;
do $$
begin
  if (select count(*) from public.referrals_snacc) <> 1 then raise exception 'FAIL referee B should see exactly 1 row'; end if;
  if (select referee from public.referrals_snacc) is distinct from 'cccccccc-5acc-4000-8000-000000000002'::uuid then
    raise exception 'FAIL referee B sees a row that is not its own';
  end if;
end $$;
reset role;

select pg_temp.jwt(5);
set local role authenticated;
do $$
begin
  if (select count(*) from public.referrals_snacc) <> 0 then raise exception 'FAIL outsider E sees referral rows'; end if;
end $$;
reset role;

select pg_temp.jwt(3);
set local role authenticated;
do $$
begin
  if (select count(*) from public.referrals_snacc) <> 0 then raise exception 'FAIL player C (refused claim) sees referral rows'; end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- Data export carries the referrals key
-- ---------------------------------------------------------------------------------------------
select pg_temp.jwt(1);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.snacc_export_my_data();
  if v->>'format' is distinct from 'snacc-export-v1' or not jsonb_exists(v, 'starter_claim') or not jsonb_exists(v, 'followers_count') then
    raise exception 'FAIL export lost an existing key';
  end if;
  if jsonb_array_length(v->'referrals'->'recruits') <> 2 then raise exception 'FAIL A export recruits: %', v->'referrals'; end if;
  if jsonb_typeof(v->'referrals'->'referred_by') <> 'null' then raise exception 'FAIL A export referred_by should be null'; end if;
  if jsonb_exists(v->'referrals'->'recruits'->0, 'user_id') or jsonb_exists(v->'referrals'->'recruits'->0, 'email') then
    raise exception 'FAIL A export exposes more than account id and username of a recruit';
  end if;
end $$;
reset role;

select pg_temp.jwt(2);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.snacc_export_my_data();
  if v->'referrals'->'referred_by'->>'near_account_id' is distinct from 'ref-check-a.testnet' then
    raise exception 'FAIL B export referred_by: %', v->'referrals';
  end if;
  if jsonb_array_length(v->'referrals'->'recruits') <> 0 then raise exception 'FAIL B export recruits should be empty'; end if;
end $$;
reset role;

select pg_temp.jwt(5);
set local role authenticated;
do $$
declare v jsonb;
begin
  v := public.snacc_export_my_data();
  if jsonb_typeof(v->'referrals'->'referred_by') <> 'null' or jsonb_array_length(v->'referrals'->'recruits') <> 0 then
    raise exception 'FAIL outsider export referrals: %', v->'referrals';
  end if;
end $$;
reset role;

-- ---------------------------------------------------------------------------------------------
-- Deleting a referee (account deletion) removes the referral and lowers the public count
-- ---------------------------------------------------------------------------------------------
delete from auth.users where id = 'cccccccc-5acc-4000-8000-000000000002';

do $$
declare r record;
begin
  if exists (select 1 from public.referrals_snacc where referee = 'cccccccc-5acc-4000-8000-000000000002') then
    raise exception 'FAIL referral survived deleting the referee';
  end if;
  select * into r from public.referral_counts_snacc where user_id = 'cccccccc-5acc-4000-8000-000000000001';
  if r.recruits is distinct from 1 or r.recruits_hatched is distinct from 1 then
    raise exception 'FAIL counts after deleting a referee: %', to_jsonb(r);
  end if;
  raise notice 'ALL SNACC REFERRAL CHECKS PASSED';
end $$;

rollback;
