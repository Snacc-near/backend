-- UI-153 (daily quests, XP and level) and UI-154 (weekly seasons, season leaderboard, hall of fame).
-- Idempotent: safe to re-run. Creates only `*_snacc` views and `snacc_*` functions. The only existing
-- objects touched are `achievements_snacc` (two more allowed codes) and the trigger function
-- `snacc_award_achievements()` (replaced in place, same name, same trigger).
--
-- WHAT THIS IS (and is not)
--   Everything here is a pure function of the public `activity_snacc` rows that `record-tx` writes after
--   verifying a testnet transaction on-chain. There is NO client-writable progress: no table is added,
--   nothing can be inserted or updated by `anon` / `authenticated`, and no cron job is needed.
--   XP, levels, quests and seasons are cosmetic and off-chain: no token, no NEAR, no money value.
--
-- XP PER RECORDED ACTION (`snacc_action_xp(method)`)
--   incubate_strain 25 (hatch)        splice_strains 20            divide_strain 15      adopt 15
--   synthesize_and_redeem_aether 12   feed_strain 10               synthesize_elixir 10
--   allocate_atp 8                    transmute_spores_to_enzyme 8 extract_spores 6
--   nft_transfer 5                    npc_buy_spores 4             any other recorded method 2
--   Anti-grind cap: only the first 40 actions of a player per UTC day earn action XP (`snacc_xp_daily_action_cap()`).
--
-- DAILY QUESTS
--   Three quests per player per UTC day from the fixed catalog `quest_catalog_snacc` (10 entries). The
--   pick is deterministic: catalog rows are ordered by md5(user_id || ':' || day-number || ':' || code)
--   (`snacc_quest_rank`) and the first three win, so a player sees the same three all day and different
--   players (and days) get different sets. Progress = number of that player's `activity_snacc` rows of that
--   UTC day whose method is in the quest's `methods`; the quest is complete at `progress >= target` and
--   adds `bonus_xp` once for that (player, day, quest). Quests reset at 00:00 UTC.
--
-- LEVEL CURVE
--   XP needed to reach level L (L >= 1): 50 * (L - 1) * L  ->  L1 0, L2 100, L3 300, L4 600, L5 1000,
--   L6 1500, L7 2100, L8 2800, L9 3600, L10 4500. No cap. `snacc_level_for_xp(xp)` is the inverse.
--
-- SEASONS
--   A season is Monday 00:00 UTC (inclusive) to the next Monday 00:00 UTC (exclusive). Season 1 starts on
--   the fixed epoch Monday 2026-11-02 (`snacc_season_epoch()`); season n starts on epoch + 7 * (n - 1) days.
--   Days before the epoch belong to season 0 or lower and are left out of the season views.
--   `season_leaderboard_snacc` ranks players by the XP of the season's UTC days (action XP + quest bonus);
--   ties are broken by quests completed, then NEAR account id. `hall_of_fame_snacc` is the top 3 of every
--   season that has already ended (computed on read, no cron).
--
-- PRIVACY
--   The views read only `activity_snacc`, which is public by design (security_invoker keeps its RLS in
--   force), so nothing here reveals more than the public activity feed already does. The columns are
--   user_id / NEAR account id plus derived numbers; no email, no token, nothing private.
--   `snacc_my_quests()` is the "me, today" convenience for the signed-in player: it filters on
--   auth.uid(), cannot be pointed at someone else and is not executable by `anon`.

-- ---------------------------------------------------------------------------------------------
-- achievements_snacc: two more allowed codes (quest_first, quest_streak_7).
-- ---------------------------------------------------------------------------------------------
alter table public.achievements_snacc drop constraint if exists achievements_snacc_code;
alter table public.achievements_snacc add constraint achievements_snacc_code check (code in (
  'first_hatch', 'first_feed', 'feeds_10', 'streak_3', 'streak_7', 'rescuer', 'gifter', 'colony_5',
  'quest_first', 'quest_streak_7'
));

-- ---------------------------------------------------------------------------------------------
-- XP and level helpers (pure, immutable). Mirrored by supabase/functions/_shared/xp.ts.
-- ---------------------------------------------------------------------------------------------
create or replace function public.snacc_action_xp(p_method text)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_method
    when 'incubate_strain' then 25
    when 'splice_strains' then 20
    when 'divide_strain' then 15
    when 'adopt' then 15
    when 'synthesize_and_redeem_aether' then 12
    when 'feed_strain' then 10
    when 'synthesize_elixir' then 10
    when 'allocate_atp' then 8
    when 'transmute_spores_to_enzyme' then 8
    when 'extract_spores' then 6
    when 'nft_transfer' then 5
    when 'npc_buy_spores' then 4
    else 2
  end
$$;

create or replace function public.snacc_xp_daily_action_cap()
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$ select 40 $$;

-- XP needed to reach level p_level: 50 * (L - 1) * L (level 1 = 0 XP).
create or replace function public.snacc_xp_for_level(p_level integer)
returns bigint
language sql
immutable
parallel safe
set search_path = ''
as $$
  select 50::bigint * (greatest(coalesce(p_level, 1), 1) - 1) * greatest(coalesce(p_level, 1), 1)
$$;

-- Highest level whose threshold is <= p_xp. Closed form, then corrected for rounding at the boundaries.
create or replace function public.snacc_level_for_xp(p_xp bigint)
returns integer
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  l integer;
begin
  if p_xp is null or p_xp <= 0 then
    return 1;
  end if;
  l := greatest(1, floor((1 + sqrt(1 + (2 * p_xp)::numeric / 25)) / 2)::integer);
  while public.snacc_xp_for_level(l + 1) <= p_xp loop
    l := l + 1;
  end loop;
  while l > 1 and public.snacc_xp_for_level(l) > p_xp loop
    l := l - 1;
  end loop;
  return l;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- Season helpers. Mirrored by supabase/functions/_shared/xp.ts and src/account/quests.ts (frontend).
-- ---------------------------------------------------------------------------------------------
create or replace function public.snacc_season_epoch()
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$ select date '2026-11-02' $$;

-- Season number of a UTC calendar day (1 = the week starting on the epoch; 0 and below = before it).
create or replace function public.snacc_season_of(p_day date)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select floor((p_day - public.snacc_season_epoch())::numeric / 7)::integer + 1
$$;

-- First day (Monday, UTC) of a season.
create or replace function public.snacc_season_start(p_season integer)
returns date
language sql
immutable
parallel safe
set search_path = ''
as $$
  select public.snacc_season_epoch() + (p_season - 1) * 7
$$;

create or replace function public.snacc_current_season()
returns integer
language sql
stable
set search_path = ''
as $$
  select public.snacc_season_of((now() at time zone 'UTC')::date)
$$;

-- ---------------------------------------------------------------------------------------------
-- Quest catalog: fixed, read-only. `methods` are contract method names exactly as record-tx stores
-- them in activity_snacc.method.
-- ---------------------------------------------------------------------------------------------
create or replace view public.quest_catalog_snacc
as
select q.code, q.title, q.blurb, q.methods, q.target, q.bonus_xp
from (values
  ('feed_1',       'Snack time',          'Feed any Snacc once.',                                  array['feed_strain']::text[],                                                         1, 10),
  ('feed_3',       'Three meals',         'Feed your Snaccs three times.',                         array['feed_strain']::text[],                                                         3, 25),
  ('allocate_atp', 'Spend your ATP',      'Allocate ATP on one Snacc.',                            array['allocate_atp']::text[],                                                        1, 15),
  ('extract_2',    'Spore picker',        'Run the Extractor twice.',                              array['extract_spores']::text[],                                                      2, 20),
  ('transmute_1',  'Fermenter shift',     'Run the Fermenter once.',                               array['transmute_spores_to_enzyme']::text[],                                          1, 20),
  ('synthesize_1', 'Elixir maker',        'Run the Synthesizer once.',                             array['synthesize_elixir']::text[],                                                   1, 25),
  ('stages_3',     'Full production line', 'Run any three production stages (extract, transmute, synthesize).', array['extract_spores', 'transmute_spores_to_enzyme', 'synthesize_elixir']::text[], 3, 30),
  ('hatch_1',      'New arrival',         'Hatch a new Snacc.',                                    array['incubate_strain']::text[],                                                     1, 30),
  ('divide_1',     'Cell division',       'Divide a Snacc.',                                       array['divide_strain']::text[],                                                       1, 25),
  ('buy_spores_1', 'Merchant visit',      'Buy spores from an NPC merchant.',                      array['npc_buy_spores']::text[],                                                      1, 15)
) as q (code, title, blurb, methods, target, bonus_xp);

-- Deterministic ordering key for the daily pick. The day enters as an integer day number so the result
-- does not depend on the session DateStyle.
create or replace function public.snacc_quest_rank(p_user uuid, p_day date, p_code text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select md5(p_user::text || ':' || (p_day - date '2000-01-01')::text || ':' || p_code)
$$;

-- ---------------------------------------------------------------------------------------------
-- quest_days_snacc: for every (player, UTC day with activity) the three picked quests with progress.
-- ---------------------------------------------------------------------------------------------
create or replace view public.quest_days_snacc
with (security_invoker = true)
as
with user_days as (
  select distinct a.user_id, a.near_account_id, (a.block_time at time zone 'UTC')::date as quest_day
  from public.activity_snacc a
),
picked as (
  select u.user_id, u.near_account_id, u.quest_day,
         c.code, c.title, c.blurb, c.methods, c.target, c.bonus_xp,
         row_number() over (
           partition by u.user_id, u.quest_day
           order by public.snacc_quest_rank(u.user_id, u.quest_day, c.code), c.code
         )::integer as slot
  from user_days u
  cross join public.quest_catalog_snacc c
)
select p.user_id, p.near_account_id, p.quest_day, p.slot,
       p.code, p.title, p.blurb, p.target, p.bonus_xp,
       count(a.tx_hash)::integer as progress,
       count(a.tx_hash) >= p.target as completed
from picked p
left join public.activity_snacc a
  on a.user_id = p.user_id
 and (a.block_time at time zone 'UTC')::date = p.quest_day
 and a.method = any (p.methods)
where p.slot <= 3
group by p.user_id, p.near_account_id, p.quest_day, p.slot, p.code, p.title, p.blurb, p.target, p.bonus_xp;

-- ---------------------------------------------------------------------------------------------
-- xp_days_snacc: XP per (player, UTC day) = capped action XP + bonus of completed quests.
-- ---------------------------------------------------------------------------------------------
create or replace view public.xp_days_snacc
with (security_invoker = true)
as
with act as (
  select a.user_id, a.near_account_id,
         (a.block_time at time zone 'UTC')::date as xp_day,
         case
           when row_number() over (
                  partition by a.user_id, (a.block_time at time zone 'UTC')::date
                  order by a.block_time, a.tx_hash
                ) <= public.snacc_xp_daily_action_cap()
           then public.snacc_action_xp(a.method)
           else 0
         end as xp
  from public.activity_snacc a
),
action_days as (
  select user_id, near_account_id, xp_day, count(*)::integer as actions, sum(xp)::integer as action_xp
  from act
  group by user_id, near_account_id, xp_day
),
quest_bonus as (
  select q.user_id, q.quest_day as xp_day,
         (count(*) filter (where q.completed))::integer as quests_completed,
         coalesce(sum(q.bonus_xp) filter (where q.completed), 0)::integer as quest_xp
  from public.quest_days_snacc q
  group by q.user_id, q.quest_day
)
select d.user_id, d.near_account_id, d.xp_day, d.actions, d.action_xp,
       coalesce(b.quests_completed, 0) as quests_completed,
       coalesce(b.quest_xp, 0) as quest_xp,
       d.action_xp + coalesce(b.quest_xp, 0) as xp
from action_days d
left join quest_bonus b on b.user_id = d.user_id and b.xp_day = d.xp_day;

-- ---------------------------------------------------------------------------------------------
-- player_xp_snacc: total XP and level per player (public, like streaks_snacc).
-- ---------------------------------------------------------------------------------------------
create or replace view public.player_xp_snacc
with (security_invoker = true)
as
select t.user_id, t.near_account_id, t.total_xp, t.level,
       public.snacc_xp_for_level(t.level) as level_start_xp,
       public.snacc_xp_for_level(t.level + 1) as next_level_xp,
       t.quests_completed, t.actions
from (
  select x.user_id, x.near_account_id,
         sum(x.xp)::bigint as total_xp,
         public.snacc_level_for_xp(sum(x.xp)::bigint) as level,
         sum(x.quests_completed)::integer as quests_completed,
         sum(x.actions)::integer as actions
  from public.xp_days_snacc x
  group by x.user_id, x.near_account_id
) t;

-- ---------------------------------------------------------------------------------------------
-- season_leaderboard_snacc and hall_of_fame_snacc (UI-154).
-- ---------------------------------------------------------------------------------------------
create or replace view public.season_leaderboard_snacc
with (security_invoker = true)
as
select s.season,
       public.snacc_season_start(s.season) as starts_on,
       public.snacc_season_start(s.season) + 7 as ends_on,
       (row_number() over (
          partition by s.season
          order by s.xp desc, s.quests_completed desc, s.near_account_id
        ))::integer as rank,
       s.user_id, s.near_account_id, s.xp, s.actions, s.quests_completed
from (
  select public.snacc_season_of(x.xp_day) as season,
         x.user_id, x.near_account_id,
         sum(x.xp)::bigint as xp,
         sum(x.actions)::integer as actions,
         sum(x.quests_completed)::integer as quests_completed
  from public.xp_days_snacc x
  group by public.snacc_season_of(x.xp_day), x.user_id, x.near_account_id
) s
where s.season >= 1;

create or replace view public.hall_of_fame_snacc
with (security_invoker = true)
as
select l.season, l.starts_on, l.ends_on, l.rank, l.user_id, l.near_account_id, l.xp, l.quests_completed
from public.season_leaderboard_snacc l
where l.rank <= 3
  and l.season < public.snacc_current_season();

-- ---------------------------------------------------------------------------------------------
-- snacc_my_quests(): today's three quests for the signed-in player (auth.uid()), live from activity.
-- ---------------------------------------------------------------------------------------------
create or replace function public.snacc_my_quests()
returns table (
  quest_day date,
  resets_at timestamptz,
  slot integer,
  code text,
  title text,
  blurb text,
  target integer,
  bonus_xp integer,
  progress integer,
  completed boolean
)
language sql
stable
set search_path = ''
as $$
  with me as (
    select auth.uid() as uid, (now() at time zone 'UTC')::date as d
  ),
  picked as (
    select me.uid, me.d, c.code, c.title, c.blurb, c.methods, c.target, c.bonus_xp,
           row_number() over (order by public.snacc_quest_rank(me.uid, me.d, c.code), c.code)::integer as slot
    from me
    cross join public.quest_catalog_snacc c
    where me.uid is not null
  )
  select p.d as quest_day,
         ((p.d + 1)::timestamp at time zone 'UTC') as resets_at,
         p.slot, p.code, p.title, p.blurb, p.target, p.bonus_xp,
         count(a.tx_hash)::integer as progress,
         count(a.tx_hash) >= p.target as completed
  from picked p
  left join public.activity_snacc a
    on a.user_id = p.uid
   and (a.block_time at time zone 'UTC')::date = p.d
   and a.method = any (p.methods)
  where p.slot <= 3
  group by p.d, p.slot, p.code, p.title, p.blurb, p.target, p.bonus_xp
  order by p.slot
$$;

-- ---------------------------------------------------------------------------------------------
-- Achievements trigger: the original rules (unchanged) plus the two quest badges.
--   quest_first     >= 1 completed quest (any UTC day)
--   quest_streak_7  >= 1 completed quest on 7 consecutive UTC days (best run ever)
-- ---------------------------------------------------------------------------------------------
create or replace function public.snacc_award_achievements()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feeds integer;
  v_best_streak integer;
  v_colony integer;
  v_day date;
  v_done integer;
  v_quest_streak integer;
begin
  if new.method = 'incubate_strain' then
    insert into public.achievements_snacc (user_id, code) values (new.user_id, 'first_hatch') on conflict do nothing;
  end if;

  if new.method = 'feed_strain' then
    insert into public.achievements_snacc (user_id, code) values (new.user_id, 'first_feed') on conflict do nothing;

    select count(*) into v_feeds
    from public.activity_snacc a
    where a.user_id = new.user_id and a.method = 'feed_strain';
    if v_feeds >= 10 then
      insert into public.achievements_snacc (user_id, code) values (new.user_id, 'feeds_10') on conflict do nothing;
    end if;

    select coalesce(max(run_len), 0) into v_best_streak
    from (
      select count(*) as run_len
      from (
        select d.feed_day, d.feed_day - (row_number() over (order by d.feed_day))::integer as grp
        from (
          select distinct (a.block_time at time zone 'UTC')::date as feed_day
          from public.activity_snacc a
          where a.user_id = new.user_id and a.method = 'feed_strain'
        ) d
      ) islands
      group by islands.grp
    ) runs;
    if v_best_streak >= 3 then
      insert into public.achievements_snacc (user_id, code) values (new.user_id, 'streak_3') on conflict do nothing;
    end if;
    if v_best_streak >= 7 then
      insert into public.achievements_snacc (user_id, code) values (new.user_id, 'streak_7') on conflict do nothing;
    end if;
  end if;

  if new.method = 'adopt' then
    insert into public.achievements_snacc (user_id, code) values (new.user_id, 'rescuer') on conflict do nothing;
  end if;

  if new.method = 'nft_transfer' then
    insert into public.achievements_snacc (user_id, code) values (new.user_id, 'gifter') on conflict do nothing;
  end if;

  if new.method in ('incubate_strain', 'divide_strain') then
    select count(*) into v_colony
    from public.activity_snacc a
    where a.user_id = new.user_id and a.method in ('incubate_strain', 'divide_strain');
    if v_colony >= 5 then
      insert into public.achievements_snacc (user_id, code) values (new.user_id, 'colony_5') on conflict do nothing;
    end if;
  end if;

  -- Quests: any action can complete a quest of its own UTC day.
  v_day := (new.block_time at time zone 'UTC')::date;
  select count(*) into v_done
  from public.quest_days_snacc q
  where q.user_id = new.user_id and q.quest_day = v_day and q.completed;
  if v_done >= 1 then
    insert into public.achievements_snacc (user_id, code) values (new.user_id, 'quest_first') on conflict do nothing;

    select coalesce(max(run_len), 0) into v_quest_streak
    from (
      select count(*) as run_len
      from (
        select d.quest_day, d.quest_day - (row_number() over (order by d.quest_day))::integer as grp
        from (
          select distinct q.quest_day
          from public.quest_days_snacc q
          where q.user_id = new.user_id and q.completed
        ) d
      ) islands
      group by islands.grp
    ) runs;
    if v_quest_streak >= 7 then
      insert into public.achievements_snacc (user_id, code) values (new.user_id, 'quest_streak_7') on conflict do nothing;
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.snacc_award_achievements() from public, anon, authenticated;

-- One-off, idempotent catch-up for activity recorded before this migration (quests are computed
-- retroactively, so earlier completed days count).
insert into public.achievements_snacc (user_id, code)
select distinct q.user_id, 'quest_first'
from public.quest_days_snacc q
where q.completed
on conflict do nothing;

insert into public.achievements_snacc (user_id, code)
select distinct runs.user_id, 'quest_streak_7'
from (
  select islands.user_id, count(*) as run_len
  from (
    select d.user_id, d.quest_day, d.quest_day - (row_number() over (partition by d.user_id order by d.quest_day))::integer as grp
    from (
      select distinct q.user_id, q.quest_day
      from public.quest_days_snacc q
      where q.completed
    ) d
  ) islands
  group by islands.user_id, islands.grp
) runs
where runs.run_len >= 7
on conflict do nothing;

-- ---------------------------------------------------------------------------------------------
-- Privileges. Views: read-only for the API roles. Pure helpers: executable (the security_invoker
-- views call them as the caller). snacc_my_quests(): signed-in players only.
-- ---------------------------------------------------------------------------------------------
revoke insert, update, delete, truncate, references, trigger on
  public.quest_catalog_snacc, public.quest_days_snacc, public.xp_days_snacc, public.player_xp_snacc,
  public.season_leaderboard_snacc, public.hall_of_fame_snacc
from anon, authenticated;

grant select on
  public.quest_catalog_snacc, public.quest_days_snacc, public.xp_days_snacc, public.player_xp_snacc,
  public.season_leaderboard_snacc, public.hall_of_fame_snacc
to anon, authenticated, service_role;

revoke all on function
  public.snacc_action_xp(text), public.snacc_xp_daily_action_cap(), public.snacc_xp_for_level(integer),
  public.snacc_level_for_xp(bigint), public.snacc_season_epoch(), public.snacc_season_of(date),
  public.snacc_season_start(integer), public.snacc_current_season(), public.snacc_quest_rank(uuid, date, text)
from public;
grant execute on function
  public.snacc_action_xp(text), public.snacc_xp_daily_action_cap(), public.snacc_xp_for_level(integer),
  public.snacc_level_for_xp(bigint), public.snacc_season_epoch(), public.snacc_season_of(date),
  public.snacc_season_start(integer), public.snacc_current_season(), public.snacc_quest_rank(uuid, date, text)
to anon, authenticated, service_role;

revoke all on function public.snacc_my_quests() from public, anon;
grant execute on function public.snacc_my_quests() to authenticated, service_role;
