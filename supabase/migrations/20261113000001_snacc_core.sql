-- Snacc core schema for Supabase project vldhsabgpfxccsljdtye (shared project).
-- Every table/view name ends in `_snacc`; functions, triggers and policies start with `snacc_`.
-- Idempotent: safe to re-run. Never drops anything. RLS is enabled on every table; tables without
-- policies are service-role only (the service role bypasses RLS).

-- ---------------------------------------------------------------------------------------------
-- Shared trigger function: updated_at
-- ---------------------------------------------------------------------------------------------
create or replace function public.snacc_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- profiles_snacc: one row per signed-in NEAR account. Public read; owner edits username/avatar/bio.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.profiles_snacc (
  user_id uuid primary key references auth.users (id) on delete cascade,
  near_account_id text not null unique,
  username text unique,
  avatar_strain_id bigint,
  bio text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_snacc_account_len check (char_length(near_account_id) between 2 and 64),
  constraint profiles_snacc_username_format check (username is null or username ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_snacc_bio_len check (bio is null or char_length(bio) <= 160),
  constraint profiles_snacc_avatar_nonneg check (avatar_strain_id is null or avatar_strain_id >= 0)
);

-- user_id / near_account_id / created_at are immutable for API roles; updated_at is maintained here.
create or replace function public.snacc_profiles_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated')
     and (new.user_id is distinct from old.user_id
          or new.near_account_id is distinct from old.near_account_id
          or new.created_at is distinct from old.created_at) then
    raise exception 'snacc: user_id, near_account_id and created_at cannot be changed'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger snacc_profiles_guard
  before update on public.profiles_snacc
  for each row execute function public.snacc_profiles_guard();

alter table public.profiles_snacc enable row level security;

-- Column-level privileges: API roles may only ever write these three columns.
revoke insert, update, delete, truncate on public.profiles_snacc from anon, authenticated;
grant select on public.profiles_snacc to anon, authenticated;
grant update (username, avatar_strain_id, bio) on public.profiles_snacc to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles_snacc' and policyname = 'snacc_profiles_select') then
    create policy snacc_profiles_select on public.profiles_snacc for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'profiles_snacc' and policyname = 'snacc_profiles_update_own') then
    create policy snacc_profiles_update_own on public.profiles_snacc for update to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- auth_nonces_snacc: NEP-413 sign-in challenges (service only).
-- ---------------------------------------------------------------------------------------------
create table if not exists public.auth_nonces_snacc (
  nonce text primary key,
  account_id text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists snacc_auth_nonces_expires_idx on public.auth_nonces_snacc (expires_at);
alter table public.auth_nonces_snacc enable row level security;
revoke all on public.auth_nonces_snacc from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- activity_snacc: verified on-chain Snacc transactions (public read, service insert).
-- ---------------------------------------------------------------------------------------------
create table if not exists public.activity_snacc (
  tx_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  near_account_id text not null,
  method text not null,
  strain_id bigint,
  block_time timestamptz not null,
  created_at timestamptz not null default now(),
  constraint activity_snacc_tx_hash_b58 check (tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
create index if not exists snacc_activity_user_method_idx on public.activity_snacc (user_id, method, block_time);
create index if not exists snacc_activity_strain_idx on public.activity_snacc (strain_id) where strain_id is not null;
alter table public.activity_snacc enable row level security;
revoke insert, update, delete, truncate on public.activity_snacc from anon, authenticated;
grant select on public.activity_snacc to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_snacc' and policyname = 'snacc_activity_select') then
    create policy snacc_activity_select on public.activity_snacc for select to anon, authenticated using (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- notifications_snacc: per-user inbox (own read, own mark-as-read; service insert). Realtime enabled.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.notifications_snacc (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  strain_id bigint,
  title text not null,
  body text not null default '',
  dedupe_key text,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_snacc_kind check (kind in ('starving', 'distressed', 'lost', 'dividend', 'starter', 'system')),
  constraint notifications_snacc_title_len check (char_length(title) <= 120),
  constraint notifications_snacc_body_len check (char_length(body) <= 500),
  constraint notifications_snacc_user_dedupe unique (user_id, dedupe_key)
);
create index if not exists snacc_notifications_user_created_idx on public.notifications_snacc (user_id, created_at desc);
alter table public.notifications_snacc enable row level security;
revoke insert, update, delete, truncate on public.notifications_snacc from anon, authenticated;
revoke select on public.notifications_snacc from anon;
grant select on public.notifications_snacc to authenticated;
grant update (read_at) on public.notifications_snacc to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications_snacc' and policyname = 'snacc_notifications_select_own') then
    create policy snacc_notifications_select_own on public.notifications_snacc for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notifications_snacc' and policyname = 'snacc_notifications_update_own') then
    create policy snacc_notifications_update_own on public.notifications_snacc for update to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  end if;
end $$;

-- Realtime (postgres_changes honours the select policy above). Guarded: skip if already a member
-- or if the publication is FOR ALL TABLES.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables)
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications_snacc'
     ) then
    alter publication supabase_realtime add table public.notifications_snacc;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- notification_prefs_snacc: per-kind opt-out (own select/insert/update). Missing row = all on.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.notification_prefs_snacc (
  user_id uuid primary key references auth.users (id) on delete cascade,
  starving boolean not null default true,
  distressed boolean not null default true,
  lost boolean not null default true,
  dividend boolean not null default true,
  starter boolean not null default true,
  system boolean not null default true,
  updated_at timestamptz not null default now()
);

create or replace trigger snacc_notification_prefs_updated_at
  before update on public.notification_prefs_snacc
  for each row execute function public.snacc_set_updated_at();

alter table public.notification_prefs_snacc enable row level security;
revoke delete, truncate on public.notification_prefs_snacc from anon, authenticated;
revoke all on public.notification_prefs_snacc from anon;
grant select, insert, update on public.notification_prefs_snacc to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_prefs_snacc' and policyname = 'snacc_prefs_select_own') then
    create policy snacc_prefs_select_own on public.notification_prefs_snacc for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_prefs_snacc' and policyname = 'snacc_prefs_insert_own') then
    create policy snacc_prefs_insert_own on public.notification_prefs_snacc for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_prefs_snacc' and policyname = 'snacc_prefs_update_own') then
    create policy snacc_prefs_update_own on public.notification_prefs_snacc for update to authenticated
      using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- achievements_snacc: public read; written only by the security definer trigger below.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.achievements_snacc (
  user_id uuid not null references auth.users (id) on delete cascade,
  code text not null,
  earned_at timestamptz not null default now(),
  primary key (user_id, code),
  constraint achievements_snacc_code check (code in (
    'first_hatch', 'first_feed', 'feeds_10', 'streak_3', 'streak_7', 'rescuer', 'gifter', 'colony_5'
  ))
);
alter table public.achievements_snacc enable row level security;
revoke insert, update, delete, truncate on public.achievements_snacc from anon, authenticated;
grant select on public.achievements_snacc to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'achievements_snacc' and policyname = 'snacc_achievements_select') then
    create policy snacc_achievements_select on public.achievements_snacc for select to anon, authenticated using (true);
  end if;
end $$;

-- Rules mirrored in supabase/functions/_shared/rules.ts (computeAchievements / bestFeedStreak):
--   first_hatch  >= 1 incubate_strain          first_feed >= 1 feed_strain     feeds_10 >= 10 feed_strain
--   streak_3/7   >= 3/7 consecutive UTC days with >= 1 feed_strain (best run ever)
--   rescuer      >= 1 adopt                     gifter     >= 1 nft_transfer
--   colony_5     >= 5 incubate_strain + divide_strain
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

  return null;
end;
$$;

revoke all on function public.snacc_award_achievements() from public, anon, authenticated;

create or replace trigger snacc_award_achievements
  after insert on public.activity_snacc
  for each row execute function public.snacc_award_achievements();

-- ---------------------------------------------------------------------------------------------
-- streaks_snacc: current feeding streak per user (security_invoker; activity_snacc is public).
-- The run ending on the last feed day counts only if that day is today or yesterday (UTC).
-- ---------------------------------------------------------------------------------------------
create or replace view public.streaks_snacc
with (security_invoker = true)
as
with days as (
  select distinct a.user_id, a.near_account_id, (a.block_time at time zone 'UTC')::date as feed_day
  from public.activity_snacc a
  where a.method = 'feed_strain'
),
islands as (
  select user_id, near_account_id, feed_day,
         feed_day - (row_number() over (partition by user_id order by feed_day))::integer as grp
  from days
),
runs as (
  select user_id, near_account_id, grp, count(*)::integer as run_len, max(feed_day) as last_day,
         row_number() over (partition by user_id order by max(feed_day) desc) as rn
  from islands
  group by user_id, near_account_id, grp
)
select user_id,
       near_account_id,
       case when last_day >= (now() at time zone 'UTC')::date - 1 then run_len else 0 end as current_streak_days,
       last_day as last_feed_day
from runs
where rn = 1;

grant select on public.streaks_snacc to anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- follows_snacc: public social graph; users follow/unfollow as themselves.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.follows_snacc (
  follower uuid not null references public.profiles_snacc (user_id) on delete cascade,
  followee uuid not null references public.profiles_snacc (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower, followee),
  constraint follows_snacc_no_self check (follower <> followee)
);
create index if not exists snacc_follows_followee_idx on public.follows_snacc (followee);
alter table public.follows_snacc enable row level security;
revoke update, truncate on public.follows_snacc from anon, authenticated;
revoke insert, delete on public.follows_snacc from anon;
grant select on public.follows_snacc to anon, authenticated;
grant insert, delete on public.follows_snacc to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'follows_snacc' and policyname = 'snacc_follows_select') then
    create policy snacc_follows_select on public.follows_snacc for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'follows_snacc' and policyname = 'snacc_follows_insert_own') then
    create policy snacc_follows_insert_own on public.follows_snacc for insert to authenticated
      with check (follower = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'follows_snacc' and policyname = 'snacc_follows_delete_own') then
    create policy snacc_follows_delete_own on public.follows_snacc for delete to authenticated
      using (follower = (select auth.uid()));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- starter_claims_snacc: one testnet starter pack per NEAR account (service only).
-- user_id is kept nullable (set null on user deletion) so a deleted user cannot claim again.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.starter_claims_snacc (
  near_account_id text primary key,
  user_id uuid references auth.users (id) on delete set null,
  amount_yocto text not null,
  tx_hash text,
  created_at timestamptz not null default now(),
  constraint starter_claims_snacc_amount check (amount_yocto ~ '^[0-9]{1,39}$')
);
create index if not exists snacc_starter_claims_created_idx on public.starter_claims_snacc (created_at);
alter table public.starter_claims_snacc enable row level security;
revoke all on public.starter_claims_snacc from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- scan_state_snacc: notify-scan memory (strain id -> last seen status) per user (service only).
-- scan_queue_snacc: profiles ordered by last scan (service only).
-- ---------------------------------------------------------------------------------------------
create table if not exists public.scan_state_snacc (
  user_id uuid primary key references public.profiles_snacc (user_id) on delete cascade,
  near_account_id text not null,
  strains jsonb not null default '{}'::jsonb,
  scanned_at timestamptz not null default now()
);
alter table public.scan_state_snacc enable row level security;
revoke all on public.scan_state_snacc from anon, authenticated;

create or replace view public.scan_queue_snacc
with (security_invoker = true)
as
select p.user_id, p.near_account_id, s.scanned_at, s.strains
from public.profiles_snacc p
left join public.scan_state_snacc s on s.user_id = p.user_id;

revoke all on public.scan_queue_snacc from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- Edge Functions use the service role: grant explicitly instead of relying on default privileges.
-- ---------------------------------------------------------------------------------------------
grant select, insert, update, delete on
  public.profiles_snacc,
  public.auth_nonces_snacc,
  public.activity_snacc,
  public.notifications_snacc,
  public.notification_prefs_snacc,
  public.achievements_snacc,
  public.follows_snacc,
  public.starter_claims_snacc,
  public.scan_state_snacc
to service_role;
grant select on public.streaks_snacc, public.scan_queue_snacc to service_role;
