-- UI-162: name/bio moderation, admins, announcements and broadcast.
-- * profiles_snacc: usernames that equal a reserved word (admin, snacc, near, ...) or contain a blocked
--   term are refused, bios that contain a blocked term are refused (trigger, so every write path is covered).
--   Matching normalises the text first: lower case, '_' and spaces removed, common digit swaps undone
--   (0->o 1->i 3->e 4->a 5->s 7->t 8->b). The seed list here is short on purpose; admins add more terms
--   with snacc_admin_block_term() so the full list does not live in this public repository.
-- * admins_snacc: service-only list of admin user ids (seeded with the project's testnet deployer profile
--   when it exists; add more with: insert into public.admins_snacc (user_id)
--   select user_id from public.profiles_snacc where near_account_id = '<account>';).
-- * announcements_snacc: public, read-only for clients; written only through snacc_admin_broadcast(), which
--   also sends a 'system' notification to every profile that has system notifications on.
-- Idempotent; touches only *_snacc tables and snacc_* functions.

create table if not exists public.admins_snacc (
  user_id uuid primary key references public.profiles_snacc (user_id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.admins_snacc enable row level security;
revoke all on public.admins_snacc from anon, authenticated;

create table if not exists public.blocked_terms_snacc (
  term text primary key,
  kind text not null,
  added_at timestamptz not null default now(),
  constraint blocked_terms_snacc_term check (term ~ '^[a-z]{3,30}$'),
  constraint blocked_terms_snacc_kind check (kind in ('reserved', 'abusive'))
);
alter table public.blocked_terms_snacc enable row level security;
revoke all on public.blocked_terms_snacc from anon, authenticated;

insert into public.blocked_terms_snacc (term, kind) values
  ('admin', 'reserved'), ('administrator', 'reserved'), ('moderator', 'reserved'), ('support', 'reserved'),
  ('official', 'reserved'), ('snacc', 'reserved'), ('snaccteam', 'reserved'), ('near', 'reserved'),
  ('nearprotocol', 'reserved'), ('system', 'reserved'), ('root', 'reserved'), ('staff', 'reserved'),
  ('security', 'reserved'), ('faucet', 'reserved'), ('helpdesk', 'reserved'),
  ('fuck', 'abusive'), ('shit', 'abusive'), ('cunt', 'abusive'), ('bitch', 'abusive'), ('asshole', 'abusive'),
  ('bastard', 'abusive'), ('dickhead', 'abusive'), ('whore', 'abusive'), ('slut', 'abusive'), ('rapist', 'abusive')
on conflict (term) do nothing;

create or replace function public.snacc_normalize_text(p text)
returns text
language sql
immutable
set search_path = ''
as $$
  select translate(regexp_replace(lower(coalesce(p, '')), '[_\s\.\-]+', '', 'g'), '0134578', 'oieastb');
$$;

-- Null when allowed, else 'reserved' or 'abusive'.
create or replace function public.snacc_text_violation(p text, p_is_username boolean)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- t: leet-normalised (for "contains a blocked word" and "sn4cc" = "snacc");
  -- plain: separators removed and trailing digits dropped, digits NOT swapped ("admin_42" = "admin").
  with n as (
    select public.snacc_normalize_text(p) as t,
           regexp_replace(regexp_replace(lower(coalesce(p, '')), '[_\s\.\-]+', '', 'g'), '[0-9]+$', '') as plain
  )
  select case
    when exists (select 1 from public.blocked_terms_snacc b, n where b.kind = 'abusive' and position(b.term in n.t) > 0) then 'abusive'
    when p_is_username and exists (
      select 1 from public.blocked_terms_snacc b, n
      where b.kind = 'reserved' and (b.term = n.plain or b.term = n.t)
    ) then 'reserved'
    else null
  end;
$$;

create or replace function public.snacc_profiles_moderate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v text;
begin
  if new.username is not null and (tg_op = 'INSERT' or new.username is distinct from old.username) then
    v := public.snacc_text_violation(new.username, true);
    if v is not null then
      raise exception 'username_not_allowed' using errcode = 'P0001', detail = v,
        hint = 'Pick another username: it is reserved or contains a blocked word.';
    end if;
  end if;
  if new.bio is not null and (tg_op = 'INSERT' or new.bio is distinct from old.bio) then
    v := public.snacc_text_violation(new.bio, false);
    if v is not null then
      raise exception 'bio_not_allowed' using errcode = 'P0001', detail = v,
        hint = 'Your bio contains a blocked word.';
    end if;
  end if;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'snacc_profiles_moderate' and tgrelid = 'public.profiles_snacc'::regclass
  ) then
    create trigger snacc_profiles_moderate
      before insert or update of username, bio on public.profiles_snacc
      for each row execute function public.snacc_profiles_moderate();
  end if;
end;
$$;

create table if not exists public.announcements_snacc (
  id bigint generated always as identity primary key,
  title text not null,
  body text not null default '',
  created_by uuid references public.profiles_snacc (user_id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint announcements_snacc_title check (char_length(title) between 3 and 120),
  constraint announcements_snacc_body check (char_length(body) <= 1000)
);
alter table public.announcements_snacc enable row level security;
revoke all on public.announcements_snacc from anon, authenticated;
grant select on public.announcements_snacc to anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'announcements_snacc' and policyname = 'snacc_announcements_select') then
    create policy snacc_announcements_select on public.announcements_snacc for select to anon, authenticated
      using (expires_at is null or expires_at > now());
  end if;
end;
$$;

create or replace function public.snacc_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins_snacc a where a.user_id = auth.uid());
$$;

create or replace function public.snacc_admin_broadcast(p_title text, p_body text, p_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  ann_id bigint;
  sent integer;
begin
  if not public.snacc_is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  insert into public.announcements_snacc (title, body, created_by, expires_at)
  values (p_title, coalesce(p_body, ''), auth.uid(), now() + make_interval(days => greatest(1, least(coalesce(p_days, 7), 90))))
  returning id into ann_id;
  insert into public.notifications_snacc (user_id, kind, strain_id, title, body, dedupe_key)
  select p.user_id, 'system', null, p_title, coalesce(p_body, ''), 'announce:' || ann_id
  from public.profiles_snacc p
  left join public.notification_prefs_snacc np on np.user_id = p.user_id
  where coalesce(np.system, true)
  on conflict do nothing;
  get diagnostics sent = row_count;
  return sent;
end;
$$;

create or replace function public.snacc_admin_reset_profile_text(p_account text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target uuid;
begin
  if not public.snacc_is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  update public.profiles_snacc set username = null, bio = null, updated_at = now()
  where near_account_id = p_account
  returning user_id into target;
  if target is null then
    return false;
  end if;
  insert into public.notifications_snacc (user_id, kind, strain_id, title, body, dedupe_key)
  values (target, 'system', null, 'Your profile name was reset',
          'A moderator cleared your username and bio because they broke the naming rules. Pick a new username in your profile.',
          'moderation:' || extract(epoch from now())::bigint)
  on conflict do nothing;
  return true;
end;
$$;

create or replace function public.snacc_admin_block_term(p_term text, p_kind text default 'abusive')
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.snacc_is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  insert into public.blocked_terms_snacc (term, kind)
  values (public.snacc_normalize_text(p_term), p_kind)
  on conflict (term) do update set kind = excluded.kind;
end;
$$;

revoke all on function public.snacc_normalize_text(text) from public;
grant execute on function public.snacc_normalize_text(text) to anon, authenticated, service_role;
revoke all on function public.snacc_text_violation(text, boolean) from public, anon;
grant execute on function public.snacc_text_violation(text, boolean) to authenticated, service_role;
revoke all on function public.snacc_profiles_moderate() from public, anon, authenticated;
revoke all on function public.snacc_is_admin() from public, anon;
grant execute on function public.snacc_is_admin() to authenticated, service_role;
revoke all on function public.snacc_admin_broadcast(text, text, integer) from public, anon;
grant execute on function public.snacc_admin_broadcast(text, text, integer) to authenticated;
revoke all on function public.snacc_admin_reset_profile_text(text) from public, anon;
grant execute on function public.snacc_admin_reset_profile_text(text) to authenticated;
revoke all on function public.snacc_admin_block_term(text, text) from public, anon;
grant execute on function public.snacc_admin_block_term(text, text) to authenticated;

-- Seed admin: the project's testnet deployer profile, when it exists.
insert into public.admins_snacc (user_id)
select user_id from public.profiles_snacc where near_account_id = 'snacc-v001.testnet'
on conflict do nothing;
