-- OPS-128: schedule notify-scan without any hand-copied secret.
-- The x-cron-secret is generated inside the database and stored only in Supabase Vault.
-- pg_cron reads it from vault.decrypted_secrets when it calls notify-scan, and notify-scan checks
-- the header through snacc_cron_secret_ok(), which only the service role may execute.
-- Setting the SNACC_CRON_SECRET edge secret is now optional (it still takes precedence when set,
-- so an existing setup keeps working).
-- Re-runnable: the secret is created once, cron.schedule with an existing job name updates it.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'snacc_cron_secret') then
    -- two v4 UUIDs = 244 random bits from the server CSPRNG; never leaves the database except via cron.
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'snacc_cron_secret',
      'x-cron-secret for the Snacc notify-scan edge function (OPS-128)'
    );
  end if;
end;
$$;

create or replace function public.snacc_cron_secret_ok(candidate text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(candidate, '') <> ''
     and exists (
       select 1 from vault.decrypted_secrets
       where name = 'snacc_cron_secret' and decrypted_secret = candidate
     );
$$;

revoke all on function public.snacc_cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.snacc_cron_secret_ok(text) to service_role;

select cron.schedule(
  'snacc_notify_scan',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url := 'https://vldhsabgpfxccsljdtye.supabase.co/functions/v1/notify-scan',
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
--   select jobid, jobname, schedule, active from cron.job where jobname = 'snacc_notify_scan';
--   select status, return_message, start_time from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'snacc_notify_scan') order by start_time desc limit 5;
--   select cron.unschedule('snacc_notify_scan');   -- removes only this job
