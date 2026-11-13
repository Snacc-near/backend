-- UI-160 Web Push assertions. Run as the migration owner (postgres) AFTER migration 20261113000008:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/snacc_push.sql      (or paste into the SQL editor)
-- One transaction, rolled back: no rows are left behind. A failed check raises "FAIL ..."; success ends with the
-- notice "ALL SNACC PUSH CHECKS PASSED".

begin;

insert into auth.users (id, aud, role, email) values
  ('aaaaaaaa-5acc-4000-8000-0000000000c1', 'authenticated', 'authenticated', 'near-push-check-a@snacc-nu.vercel.app'),
  ('aaaaaaaa-5acc-4000-8000-0000000000c2', 'authenticated', 'authenticated', 'near-push-check-b@snacc-nu.vercel.app');

-- 87-char p256dh and 22-char auth, both base64url (shape only; the Edge Function checks the curve point).
create temp table push_fixture (p256dh text, auth text);
insert into push_fixture values (repeat('B', 87), repeat('a', 22));
grant select on push_fixture to authenticated;

-- A row stamped by the service (as owner): player A's device.
insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth, user_agent)
select 'aaaaaaaa-5acc-4000-8000-0000000000c1', 'https://fcm.googleapis.com/fcm/send/push-check-a', p256dh, auth, 'check-agent' from push_fixture;
insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth)
select 'aaaaaaaa-5acc-4000-8000-0000000000c2', 'https://updates.push.services.mozilla.com/wpush/v2/push-check-b', p256dh, auth from push_fixture;

-- Constraints (as owner).
do $$
begin
  begin
    insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth)
    select 'aaaaaaaa-5acc-4000-8000-0000000000c1', 'http://fcm.googleapis.com/fcm/send/not-https', p256dh, auth from push_fixture;
    raise exception 'FAIL http endpoint accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth)
    select 'aaaaaaaa-5acc-4000-8000-0000000000c1', 'https://user:pw@fcm.googleapis.com/x', p256dh, auth from push_fixture;
    raise exception 'FAIL userinfo in endpoint accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth)
    select 'aaaaaaaa-5acc-4000-8000-0000000000c1', 'https://fcm.googleapis.com:8443/x/y', p256dh, auth from push_fixture;
    raise exception 'FAIL port in endpoint accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth)
    values ('aaaaaaaa-5acc-4000-8000-0000000000c1', 'https://fcm.googleapis.com/fcm/send/bad-keys', 'short', 'short');
    raise exception 'FAIL short keys accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth)
    select 'aaaaaaaa-5acc-4000-8000-0000000000c2', 'https://fcm.googleapis.com/fcm/send/push-check-a', p256dh, auth from push_fixture;
    raise exception 'FAIL duplicate endpoint accepted';
  exception when unique_violation then null;
  end;
end $$;

-- Player A: own rows only.
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-5acc-4000-8000-0000000000c1","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', 'aaaaaaaa-5acc-4000-8000-0000000000c1', true);
do $$
declare n integer;
begin
  select count(*) into n from public.push_subscriptions_snacc;
  if n <> 1 then raise exception 'FAIL player A sees % subscription rows, expected 1', n; end if;

  insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth, user_agent)
  select 'aaaaaaaa-5acc-4000-8000-0000000000c1', 'https://web.push.apple.com/push-check-a2', p256dh, auth, 'phone' from push_fixture;

  begin
    insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth)
    select 'aaaaaaaa-5acc-4000-8000-0000000000c2', 'https://fcm.googleapis.com/fcm/send/as-b', p256dh, auth from push_fixture;
    raise exception 'FAIL player A inserted a row for player B';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.push_subscriptions_snacc (user_id, endpoint, p256dh, auth, failures)
    select 'aaaaaaaa-5acc-4000-8000-0000000000c1', 'https://fcm.googleapis.com/fcm/send/with-failures', p256dh, auth, 5 from push_fixture;
    raise exception 'FAIL player A set the failures column';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.push_subscriptions_snacc set failures = 0;
    raise exception 'FAIL player A can update subscriptions';
  exception when insufficient_privilege then null;
  end;

  delete from public.push_subscriptions_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-0000000000c2';
  delete from public.push_subscriptions_snacc where endpoint = 'https://web.push.apple.com/push-check-a2';
  select count(*) into n from public.push_subscriptions_snacc;
  if n <> 1 then raise exception 'FAIL after own delete player A sees % rows, expected 1', n; end if;

  begin
    perform 1 from public.push_vapid_snacc;
    raise exception 'FAIL player A can read the VAPID key table';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.push_vapid_snacc (public_key, private_jwk) values ('x', '{}'::jsonb);
    raise exception 'FAIL player A can write the VAPID key table';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Player B did not lose anything to A's delete.
do $$
begin
  if (select count(*) from public.push_subscriptions_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-0000000000c2') <> 1 then
    raise exception 'FAIL player B subscription was removed by player A';
  end if;
end $$;

-- Anonymous: nothing.
set local role anon;
do $$
begin
  begin
    perform 1 from public.push_subscriptions_snacc;
    raise exception 'FAIL anon can read subscriptions';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.push_vapid_snacc;
    raise exception 'FAIL anon can read the VAPID key table';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Service role: can use the key table, single-row rule holds.
set local role service_role;
do $$
begin
  insert into public.push_vapid_snacc (public_key, private_jwk) values ('check-public', '{"kty":"EC"}'::jsonb) on conflict (id) do nothing;
  if (select count(*) from public.push_vapid_snacc) < 1 then raise exception 'FAIL service role cannot store the VAPID key'; end if;
  begin
    insert into public.push_vapid_snacc (id, public_key, private_jwk) values (2, 'second', '{}'::jsonb);
    raise exception 'FAIL second VAPID row accepted';
  exception when check_violation then null;
  end;
end $$;
reset role;

-- pushed_at marker: new notifications start unpushed; the partial index serves the dispatcher.
do $$
declare id1 bigint;
begin
  insert into public.notifications_snacc (user_id, kind, strain_id, title, dedupe_key)
  values ('aaaaaaaa-5acc-4000-8000-0000000000c1', 'starving', 7, 'push-check', 'push-check:1') returning id into id1;
  if (select pushed_at from public.notifications_snacc where id = id1) is not null then raise exception 'FAIL new notification already marked pushed'; end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'snacc_notifications_unpushed_idx') then
    raise exception 'FAIL unpushed partial index missing';
  end if;
end $$;

-- Deleting the auth user removes the subscriptions (on delete cascade).
delete from auth.users where id = 'aaaaaaaa-5acc-4000-8000-0000000000c2';
do $$
begin
  if exists (select 1 from public.push_subscriptions_snacc where user_id = 'aaaaaaaa-5acc-4000-8000-0000000000c2') then
    raise exception 'FAIL subscriptions survived the user delete';
  end if;
  raise notice 'ALL SNACC PUSH CHECKS PASSED';
end $$;

rollback;
