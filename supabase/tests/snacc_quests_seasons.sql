-- Snacc quests / XP / seasons assertions (UI-153, UI-154). Run as the migration owner (postgres) AFTER
-- migrations 0001 and 0004:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/snacc_quests_seasons.sql      (or paste into the SQL editor)
-- One transaction, rolled back: no rows are left behind. Any failed check raises an exception whose
-- message starts with "FAIL". Success ends with the notice "ALL SNACC QUEST AND SEASON CHECKS PASSED".
-- Fixture users use ids bbbbbbbb-5acc-4000-8000-00000000000N and accounts quest-check-*.testnet, and every
-- assertion that depends on shared data is scoped to them, so real players do not disturb the result.
-- The pinned quest picks below pin the md5 selection (snacc_quest_rank); change them only on purpose.

begin;

do $$
begin
  if public.snacc_current_season() < 2 then
    raise exception 'FAIL test setup: needs a clock at or after season 2 (2026-11-09), got season %', public.snacc_current_season();
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Fixtures (as owner)
-- ---------------------------------------------------------------------------------------------
insert into auth.users (id, aud, role, email)
select ('bbbbbbbb-5acc-4000-8000-00000000000' || n)::uuid, 'authenticated', 'authenticated', 'near-quest-check-' || n || '@snacc-nu.vercel.app'
from generate_series(1, 7) n;

insert into public.profiles_snacc (user_id, near_account_id)
select ('bbbbbbbb-5acc-4000-8000-00000000000' || n)::uuid, 'quest-check-' || chr(96 + n) || '.testnet'
from generate_series(1, 7) n;
-- Q1 = quest-check-a, Q2 = -b, Q3 = -c, Q4 = -d, Q5 = -e, Q6 = -f, Q7 = -g

create temp sequence snacc_qs_tx;

-- Unique, valid base58 transaction hash (44 chars, no 0/O/I/l).
create function pg_temp.txh() returns text language sql as $$
  select 'Q' || lpad(translate(nextval('pg_temp.snacc_qs_tx')::text, '0123456789', 'ABCDEFGHJK'), 43, 'A')
$$;

create function pg_temp.uid(n integer) returns uuid language sql as $$
  select ('bbbbbbbb-5acc-4000-8000-00000000000' || n)::uuid
$$;

create function pg_temp.acct(n integer) returns text language sql as $$
  select 'quest-check-' || chr(96 + n) || '.testnet'
$$;

-- n activity rows of one method for fixture user p_n at p_at (+1 second per row).
create function pg_temp.add(p_n integer, p_method text, p_at timestamptz, p_count integer default 1) returns void
language plpgsql as $$
begin
  for i in 1..p_count loop
    insert into public.activity_snacc (tx_hash, user_id, near_account_id, method, block_time)
    values (pg_temp.txh(), pg_temp.uid(p_n), pg_temp.acct(p_n), p_method, p_at + (i - 1) * interval '1 second');
  end loop;
end $$;

-- Noon UTC of a day.
create function pg_temp.noon(p_day date) returns timestamptz language sql as $$
  select (p_day::timestamp + interval '12 hours') at time zone 'UTC'
$$;

-- Seeds the day with one neutral action, reads the day's three picked quests and completes each of them.
create function pg_temp.complete_day(p_n integer, p_day date) returns void
language plpgsql as $$
declare
  r record;
begin
  perform pg_temp.add(p_n, 'nft_transfer', pg_temp.noon(p_day));
  for r in
    select q.code, q.target, c.methods
    from public.quest_days_snacc q
    join public.quest_catalog_snacc c on c.code = q.code
    where q.user_id = pg_temp.uid(p_n) and q.quest_day = p_day
  loop
    perform pg_temp.add(p_n, r.methods[1], pg_temp.noon(p_day) + interval '1 minute', r.target);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 1. Pure math: XP table, level curve, season dates
-- ---------------------------------------------------------------------------------------------
do $$
declare
  l integer;
begin
  if (select array[public.snacc_action_xp('incubate_strain'), public.snacc_action_xp('splice_strains'), public.snacc_action_xp('divide_strain'),
                   public.snacc_action_xp('adopt'), public.snacc_action_xp('synthesize_and_redeem_aether'), public.snacc_action_xp('feed_strain'),
                   public.snacc_action_xp('synthesize_elixir'), public.snacc_action_xp('allocate_atp'), public.snacc_action_xp('transmute_spores_to_enzyme'),
                   public.snacc_action_xp('extract_spores'), public.snacc_action_xp('nft_transfer'), public.snacc_action_xp('npc_buy_spores'),
                   public.snacc_action_xp('advance_epoch'), public.snacc_action_xp(null)])
     is distinct from array[25, 20, 15, 15, 12, 10, 10, 8, 8, 6, 5, 4, 2, 2] then
    raise exception 'FAIL snacc_action_xp table';
  end if;
  if public.snacc_xp_daily_action_cap() <> 40 then raise exception 'FAIL daily action cap'; end if;

  if (select array[public.snacc_xp_for_level(1), public.snacc_xp_for_level(2), public.snacc_xp_for_level(3), public.snacc_xp_for_level(4),
                   public.snacc_xp_for_level(5), public.snacc_xp_for_level(10)])
     is distinct from array[0::bigint, 100, 300, 600, 1000, 4500] then
    raise exception 'FAIL snacc_xp_for_level';
  end if;
  if (select array[public.snacc_level_for_xp(null), public.snacc_level_for_xp(-5), public.snacc_level_for_xp(0), public.snacc_level_for_xp(99),
                   public.snacc_level_for_xp(100), public.snacc_level_for_xp(299), public.snacc_level_for_xp(300), public.snacc_level_for_xp(599),
                   public.snacc_level_for_xp(600), public.snacc_level_for_xp(999), public.snacc_level_for_xp(1000), public.snacc_level_for_xp(4499),
                   public.snacc_level_for_xp(4500)])
     is distinct from array[1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 9, 10] then
    raise exception 'FAIL snacc_level_for_xp boundaries';
  end if;
  -- the inverse holds at every threshold, and one XP short of it is the level below
  for l in 1..300 loop
    if public.snacc_level_for_xp(public.snacc_xp_for_level(l)) <> l then raise exception 'FAIL level % at its own threshold', l; end if;
    if l > 1 and public.snacc_level_for_xp(public.snacc_xp_for_level(l) - 1) <> l - 1 then raise exception 'FAIL level % one XP short', l; end if;
  end loop;

  if public.snacc_season_epoch() <> date '2026-11-02' or extract(isodow from public.snacc_season_epoch()) <> 1 then
    raise exception 'FAIL season epoch must be the Monday 2026-11-02';
  end if;
  if (select array[public.snacc_season_of(date '2026-10-25'), public.snacc_season_of(date '2026-10-26'), public.snacc_season_of(date '2026-11-01'),
                   public.snacc_season_of(date '2026-11-02'), public.snacc_season_of(date '2026-11-08'), public.snacc_season_of(date '2026-11-09'),
                   public.snacc_season_of(date '2026-11-15'), public.snacc_season_of(date '2026-11-16')])
     is distinct from array[-1, 0, 0, 1, 1, 2, 2, 3] then
    raise exception 'FAIL snacc_season_of boundaries';
  end if;
  if public.snacc_season_start(1) <> date '2026-11-02' or public.snacc_season_start(2) <> date '2026-11-09' or public.snacc_season_start(3) <> date '2026-11-16' then
    raise exception 'FAIL snacc_season_start';
  end if;
  -- every day falls inside the week of its own season, and every season starts on a Monday
  if exists (
    select 1 from generate_series(0, 730) g(n), lateral (select date '2026-01-01' + g.n as d) x
    where not (public.snacc_season_start(public.snacc_season_of(x.d)) <= x.d
               and x.d < public.snacc_season_start(public.snacc_season_of(x.d)) + 7
               and extract(isodow from public.snacc_season_start(public.snacc_season_of(x.d))) = 1)
  ) then
    raise exception 'FAIL season windows are not Monday-to-Monday';
  end if;
  if public.snacc_current_season() is distinct from public.snacc_season_of((now() at time zone 'UTC')::date) then
    raise exception 'FAIL snacc_current_season';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2. Catalog: ten fixed quests, each mapped to real recorded methods
-- ---------------------------------------------------------------------------------------------
do $$
begin
  if (select count(*) from public.quest_catalog_snacc) <> 10 or (select count(distinct code) from public.quest_catalog_snacc) <> 10 then
    raise exception 'FAIL quest catalog size';
  end if;
  if exists (select 1 from public.quest_catalog_snacc where target < 1 or bonus_xp < 1 or cardinality(methods) < 1 or title = '' or blurb = '') then
    raise exception 'FAIL quest catalog has an empty or non-positive entry';
  end if;
  -- every method of every quest is a real action with its own XP (not the 2 XP fallback)
  if exists (select 1 from public.quest_catalog_snacc c, unnest(c.methods) m where public.snacc_action_xp(m) <= 2) then
    raise exception 'FAIL a quest counts a method that has no XP of its own';
  end if;
  -- the daily pick is a stable function of (player, UTC day): same inputs, same three; pinned values
  if (select array_agg(code order by public.snacc_quest_rank(pg_temp.uid(1), date '2026-11-10', code), code) from public.quest_catalog_snacc)
     is distinct from array['hatch_1', 'allocate_atp', 'extract_2', 'transmute_1', 'feed_3', 'feed_1', 'divide_1', 'synthesize_1', 'stages_3', 'buy_spores_1'] then
    raise exception 'FAIL quest pick order for fixture 1 on 2026-11-10 changed';
  end if;
  if (select array_agg(code order by public.snacc_quest_rank(pg_temp.uid(1), date '2026-11-11', code), code) from public.quest_catalog_snacc)
     is not distinct from (select array_agg(code order by public.snacc_quest_rank(pg_temp.uid(1), date '2026-11-10', code), code) from public.quest_catalog_snacc) then
    raise exception 'FAIL the next day must pick a different set';
  end if;
  if (select array_agg(code order by public.snacc_quest_rank(pg_temp.uid(2), date '2026-11-10', code), code) from public.quest_catalog_snacc)
     is not distinct from (select array_agg(code order by public.snacc_quest_rank(pg_temp.uid(1), date '2026-11-10', code), code) from public.quest_catalog_snacc) then
    raise exception 'FAIL two players must not share one pick order';
  end if;
  -- the session DateStyle and time zone must not change the pick
  set local datestyle = 'SQL, DMY';
  set local timezone = 'Asia/Jakarta';
  if (select array_agg(code order by public.snacc_quest_rank(pg_temp.uid(1), date '2026-11-10', code), code) from public.quest_catalog_snacc)
     is distinct from array['hatch_1', 'allocate_atp', 'extract_2', 'transmute_1', 'feed_3', 'feed_1', 'divide_1', 'synthesize_1', 'stages_3', 'buy_spores_1'] then
    raise exception 'FAIL quest pick depends on DateStyle or time zone';
  end if;
  set local datestyle = 'ISO, MDY';
  set local timezone = 'UTC';
end $$;

-- ---------------------------------------------------------------------------------------------
-- 3. Action XP, the daily cap and the level of a player
-- ---------------------------------------------------------------------------------------------
-- Q5: 45 feeds on one UTC day; only the first 40 earn XP (40 * 10)
select pg_temp.add(5, 'feed_strain', pg_temp.noon(date '2026-10-14'), 45);

do $$
declare
  r record;
  p record;
begin
  select * into r from public.xp_days_snacc where user_id = pg_temp.uid(5) and xp_day = date '2026-10-14';
  if r.actions <> 45 or r.action_xp <> 400 then
    raise exception 'FAIL daily cap: expected 45 actions and 400 action XP, got % and %', r.actions, r.action_xp;
  end if;
  if r.xp <> r.action_xp + r.quest_xp then raise exception 'FAIL xp_days_snacc.xp is not action_xp + quest_xp'; end if;
  select * into p from public.player_xp_snacc where user_id = pg_temp.uid(5);
  if p.total_xp <> r.xp or p.level <> public.snacc_level_for_xp(r.xp) or p.actions <> 45
     or p.level_start_xp <> public.snacc_xp_for_level(p.level) or p.next_level_xp <> public.snacc_xp_for_level(p.level + 1)
     or p.total_xp < p.level_start_xp or p.total_xp >= p.next_level_xp then
    raise exception 'FAIL player_xp_snacc for the capped player: %', row_to_json(p);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 4. Quest completion, bonus XP and the quest badges (Q6, days before the season epoch)
-- ---------------------------------------------------------------------------------------------
select pg_temp.complete_day(6, date '2026-10-20');

do $$
declare
  r record;
  got text;
begin
  select string_agg(code, ',' order by slot) into got from public.quest_days_snacc where user_id = pg_temp.uid(6) and quest_day = date '2026-10-20';
  if got is distinct from 'buy_spores_1,transmute_1,feed_1' then raise exception 'FAIL pinned picks for fixture 6 on 2026-10-20: %', got; end if;
  if (select count(*) from public.quest_days_snacc where user_id = pg_temp.uid(6) and quest_day = date '2026-10-20' and completed) <> 3 then
    raise exception 'FAIL the three picked quests should all be complete';
  end if;
  if exists (select 1 from public.quest_days_snacc where user_id = pg_temp.uid(6) and progress < target and completed) then
    raise exception 'FAIL completed must mean progress >= target';
  end if;
  -- actions: nft_transfer 5 + npc_buy_spores 4 + transmute_spores_to_enzyme 8 + feed_strain 10 = 27; bonus 15 + 20 + 10 = 45
  select * into r from public.xp_days_snacc where user_id = pg_temp.uid(6) and xp_day = date '2026-10-20';
  if r.actions <> 4 or r.action_xp <> 27 or r.quests_completed <> 3 or r.quest_xp <> 45 or r.xp <> 72 then
    raise exception 'FAIL quest XP math: %', row_to_json(r);
  end if;
  if not exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(6) and code = 'quest_first') then
    raise exception 'FAIL quest_first not awarded';
  end if;
  if exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(6) and code = 'quest_streak_7') then
    raise exception 'FAIL quest_streak_7 awarded after one day';
  end if;
end $$;

-- a day with one neutral action (nft_transfer is in no quest): three quests listed, none finished, no bonus
select pg_temp.add(2, 'nft_transfer', pg_temp.noon(date '2026-10-30'));
do $$
declare
  r record;
begin
  select * into r from public.xp_days_snacc where user_id = pg_temp.uid(2) and xp_day = date '2026-10-30';
  if r.quests_completed <> 0 or r.quest_xp <> 0 or r.xp <> 5 then raise exception 'FAIL a day without a finished quest: %', row_to_json(r); end if;
  if (select count(*) from public.quest_days_snacc where user_id = pg_temp.uid(2) and quest_day = date '2026-10-30') <> 3 then
    raise exception 'FAIL every active day lists exactly three quests';
  end if;
end $$;

-- six more consecutive days: quest_streak_7 appears only with the seventh
select pg_temp.complete_day(6, date '2026-10-20' + n) from generate_series(1, 5) g(n);
do $$
begin
  if exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(6) and code = 'quest_streak_7') then
    raise exception 'FAIL quest_streak_7 awarded after six days';
  end if;
end $$;
select pg_temp.complete_day(6, date '2026-10-26');
do $$
begin
  if not exists (select 1 from public.achievements_snacc where user_id = pg_temp.uid(6) and code = 'quest_streak_7') then
    raise exception 'FAIL quest_streak_7 not awarded after seven consecutive days';
  end if;
  begin
    insert into public.achievements_snacc (user_id, code) values (pg_temp.uid(6), 'not_a_badge');
    raise exception 'FAIL unknown achievement code accepted';
  exception when check_violation then null;
  end;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 5. Seasons: boundaries in UTC (session time zone must not matter), ranking, tie-break, hall of fame
-- ---------------------------------------------------------------------------------------------
set local timezone = 'Asia/Jakarta';
select pg_temp.add(7, 'nft_transfer', timestamptz '2026-11-01 23:59:59+00');   -- season 0 (left out)
select pg_temp.add(7, 'nft_transfer', timestamptz '2026-11-02 00:00:00+00');   -- season 1, first second
select pg_temp.add(7, 'nft_transfer', timestamptz '2026-11-08 23:59:59+00');   -- season 1, last second
select pg_temp.add(7, 'nft_transfer', timestamptz '2026-11-09 00:00:00+00');   -- season 2, first second
set local timezone = 'UTC';

do $$
declare
  r record;
begin
  if (select count(*) from public.season_leaderboard_snacc where user_id = pg_temp.uid(7) and season < 1) <> 0 then
    raise exception 'FAIL season 0 or lower must not be listed';
  end if;
  select * into r from public.season_leaderboard_snacc where user_id = pg_temp.uid(7) and season = 1;
  if r.xp <> 10 or r.actions <> 2 or r.starts_on <> date '2026-11-02' or r.ends_on <> date '2026-11-09' then
    raise exception 'FAIL season 1 for fixture 7: %', row_to_json(r);
  end if;
  select * into r from public.season_leaderboard_snacc where user_id = pg_temp.uid(7) and season = 2;
  if r.xp <> 5 or r.actions <> 1 or r.starts_on <> date '2026-11-09' or r.ends_on <> date '2026-11-16' then
    raise exception 'FAIL season 2 for fixture 7: %', row_to_json(r);
  end if;
end $$;

-- Previous (finished) season, relative to the clock. Neutral methods only, so quest bonus stays 0:
--   Q1 = 2 splice (40) + adopt (15) + nft_transfer (5) + advance_epoch (2) = 62     Q2 = 5 splice = 100
--   Q3 = 2 splice = 40                                                             Q4 = 2 splice = 40 (tie with Q3)
do $$
declare
  prev_start date := public.snacc_season_start(public.snacc_current_season() - 1);
begin
  perform pg_temp.add(1, 'splice_strains', pg_temp.noon(prev_start + 1), 2);
  perform pg_temp.add(1, 'adopt', pg_temp.noon(prev_start + 1) + interval '1 minute');
  perform pg_temp.add(1, 'nft_transfer', pg_temp.noon(prev_start + 1) + interval '2 minutes');
  perform pg_temp.add(1, 'advance_epoch', pg_temp.noon(prev_start + 3));
  perform pg_temp.add(2, 'splice_strains', pg_temp.noon(prev_start + 2), 5);
  perform pg_temp.add(3, 'splice_strains', pg_temp.noon(prev_start + 2), 2);
  perform pg_temp.add(4, 'splice_strains', pg_temp.noon(prev_start + 2), 2);
end $$;

do $$
declare
  prev integer := public.snacc_current_season() - 1;
  xp1 bigint; xp2 bigint; xp3 bigint; xp4 bigint;
  r1 integer; r2 integer; r3 integer; r4 integer;
begin
  select xp, rank into xp1, r1 from public.season_leaderboard_snacc where season = prev and user_id = pg_temp.uid(1);
  select xp, rank into xp2, r2 from public.season_leaderboard_snacc where season = prev and user_id = pg_temp.uid(2);
  select xp, rank into xp3, r3 from public.season_leaderboard_snacc where season = prev and user_id = pg_temp.uid(3);
  select xp, rank into xp4, r4 from public.season_leaderboard_snacc where season = prev and user_id = pg_temp.uid(4);
  if xp1 <> 62 or xp2 <> 100 or xp3 <> 40 or xp4 <> 40 then
    raise exception 'FAIL previous season XP: %, %, %, %', xp1, xp2, xp3, xp4;
  end if;
  if not (r2 < r1 and r1 < r3 and r3 < r4) then
    raise exception 'FAIL previous season order (expected Q2 > Q1 > Q3 > Q4 by XP, tie broken by account id): ranks %, %, %, %', r2, r1, r3, r4;
  end if;
  -- ranks inside a season are 1..n with no gaps and no duplicates
  if exists (
    select 1 from (
      select season, count(*) n, max(rank) mx, count(distinct rank) d from public.season_leaderboard_snacc group by season
    ) t where t.n <> t.mx or t.n <> t.d
  ) then
    raise exception 'FAIL season ranks are not 1..n';
  end if;

  -- hall of fame = the top three of every finished season, nothing else
  if exists (select 1 from public.hall_of_fame_snacc where season >= public.snacc_current_season() or rank > 3 or rank < 1) then
    raise exception 'FAIL hall of fame lists the running season or a rank above 3';
  end if;
  if (select count(*) from public.hall_of_fame_snacc where season = prev) > 3 then raise exception 'FAIL hall of fame has more than 3 per season'; end if;
  if exists (
    (select season, rank, user_id, xp from public.season_leaderboard_snacc where rank <= 3 and season < public.snacc_current_season())
    except
    (select season, rank, user_id, xp from public.hall_of_fame_snacc)
  ) or exists (
    (select season, rank, user_id, xp from public.hall_of_fame_snacc)
    except
    (select season, rank, user_id, xp from public.season_leaderboard_snacc where rank <= 3 and season < public.snacc_current_season())
  ) then
    raise exception 'FAIL hall of fame differs from the top three of finished seasons';
  end if;
  -- the running season never appears in the hall of fame, but is on the leaderboard once someone plays
  if exists (select 1 from public.hall_of_fame_snacc where season = public.snacc_current_season()) then
    raise exception 'FAIL the running season is in the hall of fame';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 6. Today's quests (Q1 has two feeds today, Q2 has nothing today)
-- ---------------------------------------------------------------------------------------------
select pg_temp.add(1, 'feed_strain', now() - interval '1 second', 2);

-- ---------------------------------------------------------------------------------------------
-- 7. Privileges and row-level security
-- ---------------------------------------------------------------------------------------------
do $$
declare
  v text;
  expected jsonb := jsonb_build_object(
    'quest_catalog_snacc',       'code,title,blurb,methods,target,bonus_xp',
    'quest_days_snacc',          'user_id,near_account_id,quest_day,slot,code,title,blurb,target,bonus_xp,progress,completed',
    'xp_days_snacc',             'user_id,near_account_id,xp_day,actions,action_xp,quests_completed,quest_xp,xp',
    'player_xp_snacc',           'user_id,near_account_id,total_xp,level,level_start_xp,next_level_xp,quests_completed,actions',
    'season_leaderboard_snacc',  'season,starts_on,ends_on,rank,user_id,near_account_id,xp,actions,quests_completed',
    'hall_of_fame_snacc',        'season,starts_on,ends_on,rank,user_id,near_account_id,xp,quests_completed'
  );
  cols text;
begin
  -- public views expose exactly these derived columns: no email, no token, nothing private
  for v in select jsonb_object_keys(expected) loop
    select string_agg(column_name, ',' order by ordinal_position) into cols
    from information_schema.columns where table_schema = 'public' and table_name = v;
    if cols is distinct from expected ->> v then raise exception 'FAIL columns of %: %', v, cols; end if;
    if has_table_privilege('anon', 'public.' || v, 'INSERT') or has_table_privilege('anon', 'public.' || v, 'UPDATE')
       or has_table_privilege('anon', 'public.' || v, 'DELETE') or has_table_privilege('anon', 'public.' || v, 'TRUNCATE')
       or has_table_privilege('authenticated', 'public.' || v, 'INSERT') or has_table_privilege('authenticated', 'public.' || v, 'UPDATE')
       or has_table_privilege('authenticated', 'public.' || v, 'DELETE') or has_table_privilege('authenticated', 'public.' || v, 'TRUNCATE') then
      raise exception 'FAIL % is writable by an API role', v;
    end if;
    if not has_table_privilege('anon', 'public.' || v, 'SELECT') or not has_table_privilege('authenticated', 'public.' || v, 'SELECT') then
      raise exception 'FAIL % is not readable by anon and authenticated', v;
    end if;
  end loop;
  -- every view that reads activity_snacc runs with the caller's rights, so its row-level security stays in force
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
        and c.relname in ('quest_days_snacc', 'xp_days_snacc', 'player_xp_snacc', 'season_leaderboard_snacc', 'hall_of_fame_snacc')
        and 'security_invoker=true' = any (c.reloptions)) <> 5 then
    raise exception 'FAIL a quest or season view is not security_invoker';
  end if;
  -- the achievements trigger function is still not callable by API roles
  if has_function_privilege('anon', 'public.snacc_award_achievements()', 'EXECUTE') or has_function_privilege('authenticated', 'public.snacc_award_achievements()', 'EXECUTE') then
    raise exception 'FAIL snacc_award_achievements() is executable by an API role';
  end if;
  if has_function_privilege('anon', 'public.snacc_my_quests()', 'EXECUTE') or not has_function_privilege('authenticated', 'public.snacc_my_quests()', 'EXECUTE') then
    raise exception 'FAIL snacc_my_quests() privileges';
  end if;
end $$;

-- anon: reads the public boards, cannot call snacc_my_quests()
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);
select set_config('request.jwt.claim.sub', '', true);

do $$
begin
  if (select count(*) from public.quest_catalog_snacc) <> 10 then raise exception 'FAIL anon cannot read quest_catalog_snacc'; end if;
  if (select total_xp from public.player_xp_snacc where user_id = pg_temp.uid(5)) is null then raise exception 'FAIL anon cannot read player_xp_snacc'; end if;
  if (select count(*) from public.season_leaderboard_snacc where user_id = pg_temp.uid(7)) <> 2 then raise exception 'FAIL anon cannot read season_leaderboard_snacc'; end if;
  perform 1 from public.hall_of_fame_snacc;
  perform 1 from public.xp_days_snacc;
  perform 1 from public.quest_days_snacc;
  begin
    perform 1 from public.snacc_my_quests();
    raise exception 'FAIL anon called snacc_my_quests()';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.achievements_snacc (user_id, code) values (pg_temp.uid(5), 'quest_first');
    raise exception 'FAIL anon inserted a quest badge';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- authenticated as Q1: own quests only
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-5acc-4000-8000-000000000001","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-5acc-4000-8000-000000000001', true);

do $$
declare
  today date := (now() at time zone 'UTC')::date;
  mine text;
  expected text;
  progress_mine text;
  progress_view text;
begin
  if (select count(*) from public.snacc_my_quests()) <> 3 then raise exception 'FAIL snacc_my_quests() must return three quests'; end if;
  if exists (select 1 from public.snacc_my_quests() where quest_day <> today or resets_at <> ((today + 1)::timestamp at time zone 'UTC')) then
    raise exception 'FAIL snacc_my_quests() day or reset time';
  end if;
  if (select array_agg(slot order by slot) from public.snacc_my_quests()) is distinct from array[1, 2, 3] then raise exception 'FAIL quest slots'; end if;

  -- the three codes are Q1's own pick for today, recomputed independently
  select string_agg(code, ',' order by slot) into mine from public.snacc_my_quests();
  select string_agg(code, ',' order by public.snacc_quest_rank(pg_temp.uid(1), today, code), code) into expected
  from (select code from public.quest_catalog_snacc order by public.snacc_quest_rank(pg_temp.uid(1), today, code), code limit 3) t;
  if mine is distinct from expected then raise exception 'FAIL snacc_my_quests() is not the caller''s pick: % vs %', mine, expected; end if;

  -- the function and the history view agree on progress (Q1 has activity today)
  select string_agg(code || '=' || progress || '/' || completed::text, ',' order by slot) into progress_mine from public.snacc_my_quests();
  select string_agg(code || '=' || progress || '/' || completed::text, ',' order by slot) into progress_view
  from public.quest_days_snacc where user_id = pg_temp.uid(1) and quest_day = today;
  if progress_mine is distinct from progress_view then raise exception 'FAIL function and view disagree: % vs %', progress_mine, progress_view; end if;

  -- progress cannot be written by the player
  begin
    insert into public.activity_snacc (tx_hash, user_id, near_account_id, method, block_time)
    values (pg_temp.txh(), pg_temp.uid(1), pg_temp.acct(1), 'feed_strain', now());
    raise exception 'FAIL authenticated inserted activity (quest progress)';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.achievements_snacc (user_id, code) values (pg_temp.uid(1), 'quest_streak_7');
    raise exception 'FAIL authenticated inserted a quest badge';
  exception when insufficient_privilege then null;
  end;
end $$;

reset role;

-- authenticated as Q2 (no activity today): sees only Q2's own, untouched quests
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-5acc-4000-8000-000000000002","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'bbbbbbbb-5acc-4000-8000-000000000002', true);

do $$
declare
  today date := (now() at time zone 'UTC')::date;
  mine text;
  expected text;
begin
  select string_agg(code, ',' order by slot) into mine from public.snacc_my_quests();
  select string_agg(code, ',' order by public.snacc_quest_rank(pg_temp.uid(2), today, code), code) into expected
  from (select code from public.quest_catalog_snacc order by public.snacc_quest_rank(pg_temp.uid(2), today, code), code limit 3) t;
  if mine is distinct from expected then raise exception 'FAIL Q2 does not get its own pick: % vs %', mine, expected; end if;
  if exists (select 1 from public.snacc_my_quests() where progress <> 0 or completed) then
    raise exception 'FAIL Q2 inherited progress from another player';
  end if;
end $$;

reset role;

-- a caller without a session id gets no quests rather than someone else's
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  if (select count(*) from public.snacc_my_quests()) <> 0 then raise exception 'FAIL snacc_my_quests() without auth.uid() must be empty'; end if;
end $$;
reset role;

do $$ begin raise notice 'ALL SNACC QUEST AND SEASON CHECKS PASSED'; end $$;

rollback;
