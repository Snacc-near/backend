-- UI-155 (Snacc lineage + feed history) and UI-156 (Snacc graveyard): a contract-wide chain index.
--
-- Why: the contract stores no parent ids. Divide / splice / hostile takeover / adopt / harvest / feed facts exist only as
-- NEP-297 `EVENT_JSON:` logs in transaction receipts. record-tx only sees txs our own UI users submit, so the new
-- `chain-index` Edge Function lists every tx to the contract and to the market contract snacc-market.testnet (NearBlocks API v3),
-- fetches each outcome with EXPERIMENTAL_tx_status and stores the events of successful receipts here: the Snacc contract's own
-- events (standards 'snacc', 'nep171', 'nep141') and the market's 'snacc_market' events (listed, sold, delisted, price_updated).
--
-- Objects (all `_snacc` / `snacc_`; nothing else in the shared project is touched):
--   chain_events_snacc          one row per EVENT_JSON log (public read, service write), unique (receipt_id, log_index)
--   chain_index_state_snacc     the cursor, one row per indexed account (service only)
--   chain_events_current_snacc  view: events of the CURRENT state generation (see below)
--   strain_lineage_snacc        view: who divided / was spliced into / was hostilely absorbed by whom
--   strain_history_snacc        view: per-strain event history (feeds, allocations, stages, transfers ...)
--   graveyard_snacc             view: strains that died (harvested, spliced away, hostile takeover) and who did it
--   cron job snacc_chain_index  every 10 minutes, same Vault secret as snacc_notify_scan
--
-- State generations: `migrate()` and `new()` reset the contract state (strain ids start again at 1), so a strain id is only
-- meaningful inside one generation. The indexer stores every SUCCESSFUL `migrate` / `new` call as the pseudo event
-- (standard 'snacc-index', event 'state_reset'); chain_events_current_snacc keeps only events from the latest reset onwards
-- (same block counts as after). Older generations stay in chain_events_snacc but are not shown by the views.
--
-- Chain data is public, so the tables are world-readable and the views run with security_invoker. Nothing is client-writable.
-- Amounts in `data` are exact: integers with 16+ digits are stored as JSON strings and read with `->> ... ::numeric`.
-- Re-runnable: create ... if not exists, create or replace view, cron.schedule on an existing job name updates it.

create table if not exists public.chain_events_snacc (
  receipt_id text not null,
  log_index integer not null,
  tx_hash text not null,
  standard text not null,
  version text not null,
  event text not null,
  data jsonb not null,
  signer_id text not null,
  block_height bigint not null,
  block_time timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (receipt_id, log_index),
  constraint chain_events_snacc_tx_hash_b58 check (tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$')
);
create index if not exists snacc_chain_events_event_idx on public.chain_events_snacc (event, block_height);
create index if not exists snacc_chain_events_tx_idx on public.chain_events_snacc (tx_hash);
alter table public.chain_events_snacc enable row level security;
revoke insert, update, delete, truncate on public.chain_events_snacc from anon, authenticated;
grant select on public.chain_events_snacc to anon, authenticated;
grant select, insert, update, delete on public.chain_events_snacc to service_role;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'chain_events_snacc' and policyname = 'snacc_chain_events_select') then
    create policy snacc_chain_events_select on public.chain_events_snacc for select to anon, authenticated using (true);
  end if;
end;
$$;

-- The cursor of the indexer: one row per indexed account (the Snacc contract and the market contract).
-- head_ts / walk / seen / retry / dead are explained in functions/_shared/chain-index.ts.
create table if not exists public.chain_index_state_snacc (
  account_id text primary key,
  head_ts text not null default '0',
  seen jsonb not null default '[]'::jsonb,
  walk jsonb,
  retry jsonb not null default '[]'::jsonb,
  dead jsonb not null default '[]'::jsonb,
  last_counts jsonb,
  last_run_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.chain_index_state_snacc enable row level security;
revoke all on public.chain_index_state_snacc from anon, authenticated;
grant select, insert, update, delete on public.chain_index_state_snacc to service_role;

-- ---------------------------------------------------------------------------------------------
-- Events of the current state generation
-- ---------------------------------------------------------------------------------------------
create or replace view public.chain_events_current_snacc
with (security_invoker = true)
as
select e.receipt_id, e.log_index, e.tx_hash, e.standard, e.version, e.event, e.data, e.signer_id, e.block_height, e.block_time
from public.chain_events_snacc e
where e.standard <> 'snacc-index'
  and e.block_height >= coalesce(
    (select max(r.block_height) from public.chain_events_snacc r where r.standard = 'snacc-index' and r.event = 'state_reset'),
    0);

-- ---------------------------------------------------------------------------------------------
-- Lineage. For 'divided', child_id was born from parent_id (generation = the child's generation).
-- For 'spliced_into' and 'hostile', child_id is the strain that was absorbed (and burned) into parent_id, the survivor.
-- ---------------------------------------------------------------------------------------------
create or replace view public.strain_lineage_snacc
with (security_invoker = true)
as
select (e.data ->> 'child_id')::bigint as child_id,
       (e.data ->> 'parent_id')::bigint as parent_id,
       'divided'::text as relation,
       (e.data ->> 'child_generation')::integer as generation,
       e.signer_id as actor,
       e.tx_hash, e.block_height, e.block_time
from public.chain_events_current_snacc e
where e.standard = 'snacc' and e.event = 'strain_divided'
union all
select (e.data ->> 'absorbed_id')::bigint, (e.data ->> 'dominant_id')::bigint, 'spliced_into', null::integer, e.signer_id,
       e.tx_hash, e.block_height, e.block_time
from public.chain_events_current_snacc e
where e.standard = 'snacc' and e.event = 'strains_spliced'
union all
select (e.data ->> 'target_id')::bigint, (e.data ->> 'raider_id')::bigint, 'hostile', null::integer, e.signer_id,
       e.tx_hash, e.block_height, e.block_time
from public.chain_events_current_snacc e
where e.standard = 'snacc' and e.event = 'hostile_takeover_spliced';

-- ---------------------------------------------------------------------------------------------
-- History: one row per (event, strain it concerns). `role` says which part the strain played (parent/child, dominant/absorbed,
-- raider/target, payer, source ...); `amount` is the headline figure of the event in base units (yocto-$SNACC style integers),
-- `data` is the full event payload. atp_spent, dividend_inflow, zone_changed, feast_result, epoch_dividend_closed, the
-- nutrient burst and the nep141 ft_* events are not per-strain facts and are not listed here.
-- ---------------------------------------------------------------------------------------------
create or replace view public.strain_history_snacc
with (security_invoker = true)
as
with ev as not materialized (
  select * from public.chain_events_current_snacc e where e.standard = 'snacc'
),
single_strain (event, amount_key) as (
  values ('strain_created', 'initial_snacc_stake'), ('fed', 'effective_fee'), ('extracted', 'amount'),
         ('transmuted', 'minted'), ('synthesized', 'minted'), ('genome_committed', null),
         ('genome_mutated', 'vitality_bonus'), ('atp_allocated', 'cost'), ('aether_burned_for_dividend', 'amount'),
         ('dividend_claimed', 'payout'), ('npc_spores_bought', 'total_cost')
)
select (e.data ->> 'strain_id')::bigint as strain_id, e.event, null::text as role,
       coalesce(e.data ->> 'owner_id', e.signer_id) as actor,
       (e.data ->> k.amount_key)::numeric as amount, e.data, e.tx_hash, e.block_height, e.block_time
from ev e join single_strain k on k.event = e.event
union all
select (e.data ->> 'parent_id')::bigint, e.event, 'parent', e.signer_id, (e.data ->> 'child_balance')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'strain_divided'
union all
select (e.data ->> 'child_id')::bigint, e.event, 'child', e.signer_id, (e.data ->> 'child_balance')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'strain_divided'
union all
select (e.data ->> 'dominant_id')::bigint, e.event, 'dominant', e.signer_id, (e.data ->> 'merger_tax')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'strains_spliced'
union all
select (e.data ->> 'absorbed_id')::bigint, e.event, 'absorbed', e.signer_id, (e.data ->> 'merger_tax')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'strains_spliced'
union all
select (e.data ->> 'raider_id')::bigint, e.event, 'raider', e.signer_id, (e.data ->> 'payment')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'hostile_takeover_spliced'
union all
select (e.data ->> 'target_id')::bigint, e.event, 'target', e.signer_id, (e.data ->> 'payment')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'hostile_takeover_spliced'
union all
select (e.data ->> 'target_id')::bigint, e.event, 'target', e.data ->> 'adopter', (e.data ->> 'book_value')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'strain_adopted'
union all
select (e.data ->> 'raider_strain_id')::bigint, e.event, 'payer', e.data ->> 'adopter', (e.data ->> 'book_value')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'strain_adopted'
union all
select (e.data ->> 'target_id')::bigint, e.event, 'target', e.data ->> 'liquidator', (e.data ->> 'bounty')::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'strain_liquidated'
union all
select (e.data ->> 'from_strain_id')::bigint, e.event, 'source', e.signer_id, null::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'trait_conjugated'
union all
select (e.data ->> 'to_strain_id')::bigint, e.event, 'target', e.signer_id, null::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from ev e where e.event = 'trait_conjugated'
union all
select t.token_id::bigint, e.event, null::text, e.data ->> 'old_owner_id', null::numeric, e.data, e.tx_hash, e.block_height, e.block_time
from public.chain_events_current_snacc e
cross join lateral jsonb_array_elements_text(e.data -> 'token_ids') as t(token_id)
where e.standard = 'nep171' and e.event = 'nft_transfer'
union all
-- market events (snacc-market.testnet, standard 'snacc_market'): token_id is the strain id. actor = the seller (the buyer for
-- 'sold'); amount = the price in yoctoNEAR (the new price for 'price_updated'); `data` holds the rest (reason, old_price ...).
select (e.data ->> 'token_id')::bigint, e.event, null::text,
       case when e.event = 'sold' then e.data ->> 'buyer_id' else e.data ->> 'seller_id' end,
       (e.data ->> case e.event when 'price_updated' then 'new_price' else 'price' end)::numeric,
       e.data, e.tx_hash, e.block_height, e.block_time
from public.chain_events_current_snacc e
where e.standard = 'snacc_market' and e.event in ('listed', 'sold', 'delisted', 'price_updated');

-- ---------------------------------------------------------------------------------------------
-- Graveyard. cause: 'harvested_starving' (harvest_starving_strain, event strain_liquidated: by_account = the harvester),
-- 'spliced_burned' (splice_strains: by_account = the caller, absorbed_into = the surviving dominant strain),
-- 'hostile_takeover' (hostile_takeover_splice: by_account = the raider's owner, absorbed_into = the raider strain).
-- owner_before = the owner at the time of death, from the latest earlier strain_created / strain_divided (the child belongs to
-- the signer) / strain_adopted / nep171 nft_transfer event of that strain; null when none of them is in the index.
-- Within one block the order of two txs is unknown, so only txs of a strictly earlier block (or another tx of the same block)
-- are considered.
-- ---------------------------------------------------------------------------------------------
create or replace view public.graveyard_snacc
with (security_invoker = true)
as
with deaths as (
  select (e.data ->> 'target_id')::bigint as strain_id, 'harvested_starving'::text as cause,
         e.data ->> 'liquidator' as by_account, null::bigint as absorbed_into,
         (e.data ->> 'bounty')::numeric as amount, e.tx_hash, e.block_height, e.block_time
  from public.chain_events_current_snacc e
  where e.standard = 'snacc' and e.event = 'strain_liquidated'
  union all
  select (e.data ->> 'absorbed_id')::bigint, 'spliced_burned', e.signer_id, (e.data ->> 'dominant_id')::bigint,
         (e.data ->> 'merger_tax')::numeric, e.tx_hash, e.block_height, e.block_time
  from public.chain_events_current_snacc e
  where e.standard = 'snacc' and e.event = 'strains_spliced'
  union all
  select (e.data ->> 'target_id')::bigint, 'hostile_takeover', e.signer_id, (e.data ->> 'raider_id')::bigint,
         (e.data ->> 'payment')::numeric, e.tx_hash, e.block_height, e.block_time
  from public.chain_events_current_snacc e
  where e.standard = 'snacc' and e.event = 'hostile_takeover_spliced'
),
owners as (
  select (e.data ->> 'strain_id')::bigint as strain_id, e.data ->> 'owner_id' as owner_id, e.tx_hash, e.block_height, e.block_time
  from public.chain_events_current_snacc e where e.standard = 'snacc' and e.event = 'strain_created'
  union all
  select (e.data ->> 'child_id')::bigint, e.signer_id, e.tx_hash, e.block_height, e.block_time
  from public.chain_events_current_snacc e where e.standard = 'snacc' and e.event = 'strain_divided'
  union all
  select (e.data ->> 'target_id')::bigint, e.data ->> 'adopter', e.tx_hash, e.block_height, e.block_time
  from public.chain_events_current_snacc e where e.standard = 'snacc' and e.event = 'strain_adopted'
  union all
  select t.token_id::bigint, e.data ->> 'new_owner_id', e.tx_hash, e.block_height, e.block_time
  from public.chain_events_current_snacc e
  cross join lateral jsonb_array_elements_text(e.data -> 'token_ids') as t(token_id)
  where e.standard = 'nep171' and e.event = 'nft_transfer'
)
select d.strain_id, d.cause, d.by_account, d.absorbed_into, o.owner_id as owner_before, d.amount,
       d.tx_hash, d.block_height, d.block_time
from deaths d
left join lateral (
  select w.owner_id
  from owners w
  where w.strain_id = d.strain_id
    and (w.block_height < d.block_height or (w.block_height = d.block_height and w.tx_hash <> d.tx_hash))
  order by w.block_height desc, w.block_time desc, w.tx_hash desc
  limit 1
) o on true;

grant select on public.chain_events_current_snacc, public.strain_lineage_snacc, public.strain_history_snacc, public.graveyard_snacc
  to anon, authenticated, service_role;

comment on view public.strain_lineage_snacc is 'UI-155: divided / spliced_into / hostile links between strains of the current state generation. For spliced_into and hostile, child_id is the absorbed strain and parent_id the survivor.';
comment on view public.strain_history_snacc is 'UI-155: per-strain event history from the chain index (current state generation), including market listed / sold / delisted / price_updated.';
comment on view public.graveyard_snacc is 'UI-156: strains that died (harvested, spliced away, hostile takeover) with the account that did it.';

-- ---------------------------------------------------------------------------------------------
-- Schedule chain-index every 10 minutes with the same Vault secret as snacc_notify_scan (migration 0005).
-- The secret block below is a no-op when 0005 already created it.
-- ---------------------------------------------------------------------------------------------
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'snacc_cron_secret') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'snacc_cron_secret',
      'x-cron-secret for the Snacc cron-called edge functions'
    );
  end if;
end;
$$;

select cron.schedule(
  'snacc_chain_index',
  '*/10 * * * *',
  $job$
    select net.http_post(
      url := 'https://vldhsabgpfxccsljdtye.supabase.co/functions/v1/chain-index',
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
--   select jobid, jobname, schedule, active from cron.job where jobname = 'snacc_chain_index';
--   select status, return_message, start_time from cron.job_run_details
--     where jobid = (select jobid from cron.job where jobname = 'snacc_chain_index') order by start_time desc limit 5;
--   select last_run_at, head_ts, walk is not null as walking, jsonb_array_length(retry) as retry, last_counts from public.chain_index_state_snacc;
--   select cron.unschedule('snacc_chain_index');   -- removes only this job
