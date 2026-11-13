-- UI-160: Web Push notifications (they arrive even when the Snacc tab is closed).
--
--  1) push_subscriptions_snacc  one row per browser/device that turned push on. A player may insert, select and
--                               delete only their own rows (RLS); the service role updates delivery bookkeeping.
--  2) push_vapid_snacc          the VAPID key pair. SERVICE ROLE ONLY: RLS on, no policy, no grant to anon or
--                               authenticated. The `push` Edge Function generates the P-256 key pair with Web Crypto
--                               on first use and stores it here, so the private key never goes through a chat, a
--                               repository file or a pasted env var. Only the public key is exposed (GET /push/key).
--  3) notifications_snacc.pushed_at  marker the cron-driven `push-dispatch` function claims before it sends, so every
--                               producer of notifications (notify-scan, starter pack, dividends, admin broadcast) is
--                               pushed through one path. Existing rows are stamped now: nothing historic is ever pushed.
--  4) cron job snacc_push_dispatch  every minute, authenticated with the same Vault secret as notify-scan (OPS-128).
--
-- Deploy the `push` and `push-dispatch` Edge Functions BEFORE applying this file (the cron job calls push-dispatch).
-- Re-runnable: every statement is guarded or idempotent.

-- ---------------------------------------------------------------------------------------------
-- 1) push_subscriptions_snacc
-- ---------------------------------------------------------------------------------------------
create table if not exists public.push_subscriptions_snacc (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0,
  constraint push_subscriptions_snacc_endpoint_key unique (endpoint),
  -- https only, no userinfo or port in the authority, bounded length. The host allow-list (known push services) is
  -- enforced by the `push` function on subscribe and again by `push-dispatch` before every send.
  constraint push_subscriptions_snacc_endpoint_check check (
    char_length(endpoint) between 20 and 2048 and endpoint ~ '^https://[A-Za-z0-9.-]+/[^[:space:]]+$'
  ),
  -- base64url without padding: 65 bytes -> 87 characters, 16 bytes -> 22 characters
  constraint push_subscriptions_snacc_p256dh_check check (p256dh ~ '^[A-Za-z0-9_-]{87}$'),
  constraint push_subscriptions_snacc_auth_check check (auth ~ '^[A-Za-z0-9_-]{22}$'),
  constraint push_subscriptions_snacc_user_agent_check check (user_agent is null or char_length(user_agent) <= 200),
  constraint push_subscriptions_snacc_failures_check check (failures >= 0)
);
create index if not exists snacc_push_subscriptions_user_idx on public.push_subscriptions_snacc (user_id);

comment on table public.push_subscriptions_snacc is
  'UI-160: Web Push subscriptions (one per browser). endpoint/p256dh/auth are the browser PushSubscription; failures counts consecutive failed delivery runs.';

alter table public.push_subscriptions_snacc enable row level security;
revoke all on table public.push_subscriptions_snacc from public, anon, authenticated;
grant select, delete on table public.push_subscriptions_snacc to authenticated;
-- A player can insert only the identifying columns; id, created_at, last_ok_at and failures stay server-controlled.
grant insert (user_id, endpoint, p256dh, auth, user_agent) on table public.push_subscriptions_snacc to authenticated;
grant select, insert, update, delete on table public.push_subscriptions_snacc to service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions_snacc' and policyname = 'snacc_push_subscriptions_select_own') then
    create policy snacc_push_subscriptions_select_own on public.push_subscriptions_snacc for select to authenticated
      using (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions_snacc' and policyname = 'snacc_push_subscriptions_insert_own') then
    create policy snacc_push_subscriptions_insert_own on public.push_subscriptions_snacc for insert to authenticated
      with check (user_id = (select auth.uid()));
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions_snacc' and policyname = 'snacc_push_subscriptions_delete_own') then
    create policy snacc_push_subscriptions_delete_own on public.push_subscriptions_snacc for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- 2) push_vapid_snacc: the single VAPID key pair, service role only
-- ---------------------------------------------------------------------------------------------
create table if not exists public.push_vapid_snacc (
  id smallint primary key default 1,
  public_key text not null,
  private_jwk jsonb not null,
  created_at timestamptz not null default now(),
  constraint push_vapid_snacc_single_row check (id = 1)
);

comment on table public.push_vapid_snacc is
  'UI-160: the VAPID key pair (single row). Generated by the push Edge Function on first use. SERVICE ROLE ONLY: no policy, no grant to anon/authenticated. Deleting the row invalidates every existing subscription (they were created for the old public key).';

alter table public.push_vapid_snacc enable row level security;
revoke all on table public.push_vapid_snacc from public, anon, authenticated;
grant select, insert on table public.push_vapid_snacc to service_role;
-- Deliberately no policy: with RLS on and no policy, anon and authenticated can neither read nor write.

-- ---------------------------------------------------------------------------------------------
-- 3) notifications_snacc.pushed_at
-- ---------------------------------------------------------------------------------------------
alter table public.notifications_snacc add column if not exists pushed_at timestamptz;

-- Everything that exists now was never meant to be pushed: stamp it once (only while the column is still empty).
update public.notifications_snacc set pushed_at = now() where pushed_at is null;

create index if not exists snacc_notifications_unpushed_idx on public.notifications_snacc (created_at, id) where pushed_at is null;

-- ---------------------------------------------------------------------------------------------
-- 4) cron: push-dispatch every minute (same Vault secret as notify-scan)
-- ---------------------------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'snacc_push_dispatch',
  '* * * * *',
  $job$
    select net.http_post(
      url := 'https://vldhsabgpfxccsljdtye.supabase.co/functions/v1/push-dispatch',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'snacc_cron_secret' limit 1)
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $job$
);

-- Check / pause:
--   select jobid, jobname, schedule, active from cron.job where jobname = 'snacc_push_dispatch';
--   select status, return_message, start_time from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'snacc_push_dispatch') order by start_time desc limit 5;
--   select cron.unschedule('snacc_push_dispatch');   -- removes only this job
