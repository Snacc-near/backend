-- OPS-127: first-party usage funnel and client error reports (no third-party analytics service).
-- Rows are written only by the `track` Edge Function (service role). They hold a random device id and
-- session id generated in the browser (no account id, no raw IP: ip_hash is an HMAC used for rate
-- limiting), a generalised route, an allow-listed event name and small scrubbed props or error text.
-- Clients cannot read or write the table. Admins read aggregates through snacc_admin_metrics().
-- Retention: rows older than 90 days can be removed by hand; no automatic job is scheduled here.

create table if not exists public.client_telemetry_snacc (
  id bigint generated always as identity primary key,
  kind text not null,
  name text not null,
  device_id text not null,
  session_id text not null,
  route text not null,
  props jsonb not null default '{}'::jsonb,
  message text,
  stack text,
  ip_hash text,
  client_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint client_telemetry_snacc_kind check (kind in ('event', 'error')),
  constraint client_telemetry_snacc_ids check (device_id ~ '^[a-z0-9-]{8,64}$' and session_id ~ '^[a-z0-9-]{8,64}$'),
  constraint client_telemetry_snacc_sizes check (
    char_length(name) <= 40 and char_length(route) <= 40 and coalesce(char_length(message), 0) <= 300
    and coalesce(char_length(stack), 0) <= 1500 and pg_column_size(props) <= 2048
  )
);
create index if not exists snacc_telemetry_created_idx on public.client_telemetry_snacc (created_at);
create index if not exists snacc_telemetry_ip_idx on public.client_telemetry_snacc (ip_hash, created_at);
create index if not exists snacc_telemetry_device_idx on public.client_telemetry_snacc (device_id, created_at);
alter table public.client_telemetry_snacc enable row level security;
revoke all on public.client_telemetry_snacc from anon, authenticated;

-- Admin aggregates: daily funnel (distinct devices per step), D1/D7 retention by first-seen day, top errors.
create or replace function public.snacc_admin_metrics(p_days integer default 14)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  since timestamptz := date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' - make_interval(days => greatest(1, least(coalesce(p_days, 14), 90)) - 1);
begin
  if not public.snacc_is_admin() then
    raise exception 'admin_only' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'since', since,
    'funnel', coalesce((
      select jsonb_agg(row_to_json(f) order by f.day)
      from (
        select (t.created_at at time zone 'UTC')::date as day,
          count(distinct t.device_id) filter (where t.kind = 'event' and t.name = 'page_view' and t.route = '/') as landing,
          count(distinct t.device_id) filter (where t.kind = 'event' and t.name = 'page_view' and t.route = '/app') as app,
          count(distinct t.device_id) filter (where t.name = 'onboarding_done') as onboarding_done,
          count(distinct t.device_id) filter (where t.name = 'wallet_connected') as wallet_connected,
          count(distinct t.device_id) filter (where t.name = 'signed_in') as signed_in,
          count(distinct t.device_id) filter (where t.name = 'tx_succeeded') as tx_succeeded,
          count(*) filter (where t.kind = 'error') as errors
        from public.client_telemetry_snacc t
        where t.created_at >= since
        group by 1
      ) f), '[]'::jsonb),
    'retention', coalesce((
      select jsonb_agg(row_to_json(r) order by r.cohort)
      from (
        with firsts as (
          select device_id, min((created_at at time zone 'UTC')::date) as first_day
          from public.client_telemetry_snacc group by device_id
        ), seen as (
          select distinct device_id, (created_at at time zone 'UTC')::date as d from public.client_telemetry_snacc
        )
        select f.first_day as cohort, count(*) as devices,
          count(*) filter (where exists (select 1 from seen s where s.device_id = f.device_id and s.d = f.first_day + 1)) as d1,
          count(*) filter (where exists (select 1 from seen s where s.device_id = f.device_id and s.d = f.first_day + 7)) as d7
        from firsts f
        where f.first_day >= (since at time zone 'UTC')::date
        group by f.first_day
      ) r), '[]'::jsonb),
    'top_errors', coalesce((
      select jsonb_agg(row_to_json(e))
      from (
        select t.name, t.message, t.route, count(*) as n, max(t.created_at) as last_seen
        from public.client_telemetry_snacc t
        where t.kind = 'error' and t.created_at >= now() - interval '7 days'
        group by t.name, t.message, t.route
        order by n desc
        limit 20
      ) e), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.snacc_admin_metrics(integer) from public, anon;
grant execute on function public.snacc_admin_metrics(integer) to authenticated;
