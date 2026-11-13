-- UI-158: invite links and the `recruiter` badge.
-- Idempotent: safe to re-run. Creates only `*_snacc` objects and `snacc_*` functions. Existing objects touched:
-- `achievements_snacc` (one more allowed code), the trigger function `snacc_award_achievements()` (replaced in
-- place, same name, same trigger) and `snacc_export_my_data()` (replaced in place with one more key).
--
-- WHAT THIS IS (and is not)
--   A new player who opens `https://snacc-nu.vercel.app/app?ref=<account>` and signs in can attach that account as
--   their referrer, once, before they have a recorded hatch. When the referee's first `incubate_strain` is
--   recorded the referrer earns the cosmetic `recruiter` badge. That is all: no token, no NEAR, no XP, nothing with
--   a money value. Snacc runs on NEAR testnet.
--
-- TABLE `referrals_snacc` (referee pk, referrer, created_at)
--   One row per referred player. RLS: a signed-in player reads rows where they are the referrer or the referee.
--   No client can write: rows only appear through `snacc_claim_referral()` below. Deleting either profile
--   (account deletion cascades) removes the row.
--
-- RPC `snacc_claim_referral(p_referrer_account text) returns text` (authenticated only, pinned to auth.uid())
--   Returns a status instead of raising, so the client can ignore every outcome quietly:
--     claimed            row inserted
--     no_profile         the caller has no profiles_snacc row yet
--     already_referred   the caller already has a referral (also on a concurrent double claim)
--     invalid_account    empty, too long or not NEAR-account shaped
--     unknown_referrer   no profile with that account id
--     self_referral      the referrer is the caller
--     not_new_player     the caller already has a recorded `incubate_strain` (only new players can be referred)
--   Not signed in raises 28000, like the other player RPCs.
--
-- VIEW `referral_counts_snacc` (referrer, near_account_id, recruits, recruits_hatched)
--   Public aggregate per referrer. It deliberately runs with the view owner's rights (security_invoker = false):
--   the table itself is private, and the view reveals only the referrer's already public account id and two counts,
--   never who the referees are. recruits_hatched counts referees with at least one recorded `incubate_strain`.
--
-- BADGE `recruiter`
--   Awarded to the referrer by `snacc_award_achievements()` when a referee's first recorded `incubate_strain`
--   arrives. The trigger body below is the one from migration 0004 verbatim plus that one block at the end.
--
-- ORDER NOTE: `20261113000009_snacc_export.sql` also does `create or replace function snacc_export_my_data()` and
-- is the older body. Applied in file order on a fresh database it would replace the copy below, so after a full
-- replay re-run this file (or fold the `referrals` key into 0009).

-- ---------------------------------------------------------------------------------------------
-- achievements_snacc: allowed codes = every code from 0001 and 0004 plus `recruiter`.
-- ---------------------------------------------------------------------------------------------
alter table public.achievements_snacc drop constraint if exists achievements_snacc_code;
alter table public.achievements_snacc add constraint achievements_snacc_code check (code in (
  'first_hatch', 'first_feed', 'feeds_10', 'streak_3', 'streak_7', 'rescuer', 'gifter', 'colony_5',
  'quest_first', 'quest_streak_7',
  'recruiter'
));

-- ---------------------------------------------------------------------------------------------
-- referrals_snacc
-- ---------------------------------------------------------------------------------------------
create table if not exists public.referrals_snacc (
  referee uuid primary key references public.profiles_snacc (user_id) on delete cascade,
  referrer uuid not null references public.profiles_snacc (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint referrals_snacc_no_self check (referee <> referrer)
);
create index if not exists snacc_referrals_referrer_idx on public.referrals_snacc (referrer);

alter table public.referrals_snacc enable row level security;
revoke all on public.referrals_snacc from public, anon, authenticated;
grant select on public.referrals_snacc to authenticated;
grant select, insert, update, delete on public.referrals_snacc to service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'referrals_snacc' and policyname = 'snacc_referrals_select_own') then
    create policy snacc_referrals_select_own on public.referrals_snacc for select to authenticated
      using (referrer = (select auth.uid()) or referee = (select auth.uid()));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- snacc_claim_referral(p_referrer_account)
-- ---------------------------------------------------------------------------------------------
create or replace function public.snacc_claim_referral(p_referrer_account text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  v_account text := lower(btrim(coalesce(p_referrer_account, '')));
  v_referrer uuid;
  v_rows integer;
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  if not exists (select 1 from public.profiles_snacc where user_id = uid) then
    return 'no_profile';
  end if;
  if exists (select 1 from public.referrals_snacc where referee = uid) then
    return 'already_referred';
  end if;
  if char_length(v_account) < 2 or char_length(v_account) > 64 or v_account !~ '^[a-z0-9._-]+$' then
    return 'invalid_account';
  end if;
  select user_id into v_referrer from public.profiles_snacc where near_account_id = v_account;
  if v_referrer is null then
    return 'unknown_referrer';
  end if;
  if v_referrer = uid then
    return 'self_referral';
  end if;
  if exists (select 1 from public.activity_snacc a where a.user_id = uid and a.method = 'incubate_strain') then
    return 'not_new_player';
  end if;
  insert into public.referrals_snacc (referee, referrer) values (uid, v_referrer) on conflict (referee) do nothing;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    return 'already_referred';
  end if;
  return 'claimed';
end;
$$;

revoke all on function public.snacc_claim_referral(text) from public, anon;
grant execute on function public.snacc_claim_referral(text) to authenticated;

-- ---------------------------------------------------------------------------------------------
-- referral_counts_snacc: public aggregate (see the header for why it is not security_invoker).
-- ---------------------------------------------------------------------------------------------
create or replace view public.referral_counts_snacc
with (security_invoker = false)
as
select r.referrer as user_id,
       p.near_account_id,
       count(*)::integer as recruits,
       (count(*) filter (where exists (
          select 1 from public.activity_snacc a
          where a.user_id = r.referee and a.method = 'incubate_strain'
       )))::integer as recruits_hatched
from public.referrals_snacc r
join public.profiles_snacc p on p.user_id = r.referrer
group by r.referrer, p.near_account_id;

revoke all on public.referral_counts_snacc from public, anon, authenticated;
grant select on public.referral_counts_snacc to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------------------------
-- Achievements trigger: migration 0004's body verbatim, plus the `recruiter` block at the end.
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

  -- Referrals: the referrer earns `recruiter` when their referee's first hatch is recorded.
  if new.method = 'incubate_strain'
     and not exists (
       select 1 from public.activity_snacc a
       where a.user_id = new.user_id and a.method = 'incubate_strain' and a.tx_hash <> new.tx_hash
     ) then
    insert into public.achievements_snacc (user_id, code)
    select r.referrer, 'recruiter'
    from public.referrals_snacc r
    where r.referee = new.user_id
    on conflict do nothing;
  end if;

  return null;
end;
$$;

revoke all on function public.snacc_award_achievements() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- snacc_export_my_data(): migration 0009's body plus a `referrals` key (who invited the caller, and who the
-- caller invited; for other players only the account id and username, which are already public).
-- ---------------------------------------------------------------------------------------------
create or replace function public.snacc_export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'format', 'snacc-export-v1',
    'exported_at', now(),
    'note', 'Off-chain Snacc data only. On-chain state (Snacc NFTs, balances) lives on NEAR testnet and is public there.',
    'profile', (select to_jsonb(p) from public.profiles_snacc p where p.user_id = uid),
    'activity', coalesce((select jsonb_agg(to_jsonb(a) order by a.block_time) from public.activity_snacc a where a.user_id = uid), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(x) order by x.earned_at) from public.achievements_snacc x where x.user_id = uid), '[]'::jsonb),
    'notifications', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at) from public.notifications_snacc n where n.user_id = uid), '[]'::jsonb),
    'notification_prefs', (select to_jsonb(np) from public.notification_prefs_snacc np where np.user_id = uid),
    'following', coalesce((
      select jsonb_agg(jsonb_build_object('near_account_id', p.near_account_id, 'username', p.username, 'since', f.created_at) order by f.created_at)
      from public.follows_snacc f join public.profiles_snacc p on p.user_id = f.followee
      where f.follower = uid), '[]'::jsonb),
    'followers_count', (select count(*) from public.follows_snacc f where f.followee = uid),
    'starter_claim', (
      select jsonb_build_object('near_account_id', s.near_account_id, 'amount_yocto', s.amount_yocto, 'tx_hash', s.tx_hash, 'created_at', s.created_at)
      from public.starter_claims_snacc s where s.user_id = uid limit 1),
    'referrals', jsonb_build_object(
      'referred_by', (
        select jsonb_build_object('near_account_id', p.near_account_id, 'username', p.username, 'since', r.created_at)
        from public.referrals_snacc r join public.profiles_snacc p on p.user_id = r.referrer
        where r.referee = uid),
      'recruits', coalesce((
        select jsonb_agg(jsonb_build_object('near_account_id', p.near_account_id, 'username', p.username, 'since', r.created_at) order by r.created_at)
        from public.referrals_snacc r join public.profiles_snacc p on p.user_id = r.referee
        where r.referrer = uid), '[]'::jsonb))
  );
end;
$$;

revoke all on function public.snacc_export_my_data() from public, anon;
grant execute on function public.snacc_export_my_data() to authenticated;
