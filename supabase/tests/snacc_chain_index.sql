-- Snacc chain-index assertions (UI-155 lineage + history, UI-156 graveyard). Run as the migration owner (postgres) AFTER
-- migration 20261113000006:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/tests/snacc_chain_index.sql      (or paste into the SQL editor)
-- Everything runs in one transaction and is rolled back: no rows are left behind. Any failed check raises an exception whose
-- message starts with "FAIL". Success ends with the notice "ALL SNACC CHAIN INDEX CHECKS PASSED".
-- The fixture events sit at block heights from 899,999,000 upwards, far above any real testnet height, and include a
-- `state_reset` at 900,000,000, so the "current generation" the views show is exactly this fixture even when the real index
-- already holds data. Field values copy the shapes of real snacc-v001.testnet events.

begin;

insert into public.chain_events_snacc (receipt_id, log_index, tx_hash, standard, version, event, data, signer_id, block_height, block_time)
select 'RCP' || x.k, 0, rpad('CJT' || x.k, 40, '1'), x.standard, case when x.standard = 'snacc-index' then '1' else '1.0.0' end,
       x.event, x.data::jsonb, x.signer, x.height, timestamptz '2026-11-09 12:00:00+00' + (x.height - 899999000) * interval '1 second'
from (values
  -- generation A (before the reset): must never show up
  ('a1', 'snacc', 'strain_created',  '{"kind":"strain_created","strain_id":1,"owner_id":"old.testnet","role_mask":1,"initial_snacc_stake":"1000","spores_minted":1}', 'old.testnet', 899999000),
  ('a2', 'snacc', 'strain_liquidated', '{"kind":"strain_liquidated","target_id":1,"liquidator":"old.testnet","bounty":"5","treasury_recovery":"45"}', 'old.testnet', 899999500),
  -- the reset
  ('rr', 'snacc-index', 'state_reset', '{"method":"migrate"}', 'snacc-v001.testnet', 900000000),
  -- generation B
  ('bz', 'snacc', 'strain_created',  '{"kind":"strain_created","strain_id":9,"owner_id":"zed.testnet","role_mask":1,"initial_snacc_stake":"7","spores_minted":1}', 'zed.testnet', 900000000),
  ('b1', 'snacc', 'strain_created',  '{"kind":"strain_created","strain_id":1,"owner_id":"alice.testnet","role_mask":1,"initial_snacc_stake":"250000000000000000000000","spores_minted":10}', 'alice.testnet', 900000010),
  ('b2', 'snacc', 'strain_created',  '{"kind":"strain_created","strain_id":2,"owner_id":"alice.testnet","role_mask":1,"initial_snacc_stake":"100","spores_minted":10}', 'alice.testnet', 900000011),
  ('b3', 'snacc', 'strain_divided',  '{"kind":"strain_divided","parent_id":1,"child_id":3,"child_generation":1,"parent_balance":"434463694500699999997225","child_balance":"434463694500699999997225","child_vitality":5000,"child_spores":25}', 'alice.testnet', 900000020),
  ('b4', 'nep171', 'nft_transfer',   '{"old_owner_id":"alice.testnet","new_owner_id":"bob.testnet","token_ids":["3"],"approved_account_ids":null,"memo":"gift"}', 'alice.testnet', 900000030),
  ('b5', 'snacc', 'fed',             '{"kind":"fed","strain_id":1,"base_fee":"50000000000000000000000","effective_fee":"42416000000000000000000","burst_bps":360,"rescue_bps":8800,"dormant":false,"atp_minted":42416000}', 'alice.testnet', 900000040),
  ('b6', 'snacc', 'strains_spliced', '{"kind":"strains_spliced","dominant_id":1,"absorbed_id":2,"merger_tax":"10861592362517499999930"}', 'alice.testnet', 900000050),
  ('b7', 'snacc', 'hostile_takeover_spliced', '{"kind":"hostile_takeover_spliced","raider_id":1,"target_id":3,"book_value":"40000000000000000000000","payment":"46000000000000000000000","seller_payout":"43700000000000000000000","treasury_cut":"2300000000000000000000"}', 'carol.testnet', 900000060),
  ('b8', 'snacc', 'strain_created',  '{"kind":"strain_created","strain_id":4,"owner_id":"dave.testnet","role_mask":1,"initial_snacc_stake":"100","spores_minted":10}', 'dave.testnet', 900000070),
  ('b9', 'snacc', 'strain_liquidated', '{"kind":"strain_liquidated","target_id":4,"liquidator":"erin.testnet","bounty":"4000000000000000000000","treasury_recovery":"36000000000000000000000"}', 'erin.testnet', 900000071),
  ('c1', 'snacc', 'strain_created',  '{"kind":"strain_created","strain_id":5,"owner_id":"gus.testnet","role_mask":1,"initial_snacc_stake":"100","spores_minted":10}', 'gus.testnet', 900000080),
  ('c2', 'snacc', 'strain_adopted',  '{"kind":"strain_adopted","target_id":5,"adopter":"frank.testnet","raider_strain_id":6,"book_value":"40000000000000000000000"}', 'frank.testnet', 900000081),
  ('c3', 'snacc', 'strain_liquidated', '{"kind":"strain_liquidated","target_id":5,"liquidator":"hal.testnet","bounty":"10","treasury_recovery":"90"}', 'hal.testnet', 900000090),
  -- not per-strain facts and not nep171: must not appear in the history
  ('c4', 'snacc', 'atp_spent',       '{"kind":"atp_spent","strain_id":1,"purpose":"divide","cost":3}', 'alice.testnet', 900000020),
  ('c5', 'nep141', 'ft_transfer',    '{"old_owner_id":"a.testnet","new_owner_id":"b.testnet","amount":"1000","memo":null}', 'a.testnet', 900000100),
  -- market events (snacc-market.testnet): token_id is the strain id, prices are yoctoNEAR strings
  ('d1', 'snacc_market', 'listed',        '{"token_id":"1","seller_id":"alice.testnet","price":"100000000000000000000000","listed_at":"1794582012496400147"}', 'alice.testnet', 900000110),
  ('d2', 'snacc_market', 'price_updated', '{"token_id":"1","seller_id":"alice.testnet","old_price":"100000000000000000000000","new_price":"150000000000000000000000"}', 'alice.testnet', 900000111),
  ('d3', 'snacc_market', 'sold',          '{"token_id":"1","seller_id":"alice.testnet","buyer_id":"bob.testnet","price":"150000000000000000000000"}', 'bob.testnet', 900000112),
  ('d4', 'snacc_market', 'delisted',      '{"token_id":"2","seller_id":"alice.testnet","reason":"seller"}', 'alice.testnet', 900000113)
) as x(k, standard, event, data, signer, height);

-- a repeated insert of the same (receipt_id, log_index) is ignored (the indexer upserts with ignoreDuplicates)
insert into public.chain_events_snacc (receipt_id, log_index, tx_hash, standard, version, event, data, signer_id, block_height, block_time)
values ('RCPb1', 0, rpad('CJTb1', 40, '1'), 'snacc', '1.0.0', 'strain_created', '{"strain_id":1,"owner_id":"mallory.testnet","initial_snacc_stake":"1"}', 'mallory.testnet', 900000010, now())
on conflict (receipt_id, log_index) do nothing;

-- ---------------------------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------------------------
do $$
declare
  rec record;
begin
  for rec in select relname, relrowsecurity from pg_class
             where relnamespace = 'public'::regnamespace and relname in ('chain_events_snacc', 'chain_index_state_snacc') loop
    if not rec.relrowsecurity then
      raise exception 'FAIL % has no row level security', rec.relname;
    end if;
  end loop;
  for rec in select c.relname, c.reloptions from pg_class c
             where c.relnamespace = 'public'::regnamespace
               and c.relname in ('chain_events_current_snacc', 'strain_lineage_snacc', 'strain_history_snacc', 'graveyard_snacc') loop
    if rec.reloptions is null or not ('security_invoker=true' = any (rec.reloptions)) then
      raise exception 'FAIL view % is not security_invoker', rec.relname;
    end if;
  end loop;
  if (select count(*) from public.chain_events_snacc where receipt_id = 'RCPb1') <> 1
     or (select data ->> 'owner_id' from public.chain_events_snacc where receipt_id = 'RCPb1') <> 'alice.testnet' then
    raise exception 'FAIL duplicate (receipt_id, log_index) was not ignored';
  end if;
  -- the scheduled job exists on the real database (pg_cron is absent in a plain Postgres)
  if to_regclass('cron.job') is not null then
    if not exists (select 1 from cron.job where jobname = 'snacc_chain_index' and schedule = '*/10 * * * *' and command like '%/functions/v1/chain-index%') then
      raise exception 'FAIL cron job snacc_chain_index is missing or wrong';
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Current generation, lineage
-- ---------------------------------------------------------------------------------------------
do $$
declare
  n integer;
  r record;
begin
  -- 19 generation-B events (bz, b1..b9, c1..c5, d1..d4): everything from the reset block on, nothing before it, no pseudo event
  select count(*) into n from public.chain_events_current_snacc where block_height >= 899999000;
  if n <> 19 then raise exception 'FAIL current generation: expected 19 events, got %', n; end if;
  if exists (select 1 from public.chain_events_current_snacc where standard = 'snacc-index' or block_height < 900000000) then
    raise exception 'FAIL current generation leaks the reset pseudo event or older events';
  end if;

  select count(*) into n from public.strain_lineage_snacc where block_height >= 899999000;
  if n <> 3 then raise exception 'FAIL lineage: expected 3 rows, got %', n; end if;

  select * into r from public.strain_lineage_snacc where relation = 'divided' and block_height >= 899999000;
  if r.child_id <> 3 or r.parent_id <> 1 or r.generation <> 1 or r.actor <> 'alice.testnet' or r.tx_hash <> rpad('CJTb3', 40, '1') then
    raise exception 'FAIL lineage divided row: %', row_to_json(r);
  end if;
  select * into r from public.strain_lineage_snacc where relation = 'spliced_into' and block_height >= 899999000;
  if r.child_id <> 2 or r.parent_id <> 1 or r.generation is not null then
    raise exception 'FAIL lineage spliced_into row (child_id = absorbed, parent_id = survivor): %', row_to_json(r);
  end if;
  select * into r from public.strain_lineage_snacc where relation = 'hostile' and block_height >= 899999000;
  if r.child_id <> 3 or r.parent_id <> 1 or r.actor <> 'carol.testnet' then
    raise exception 'FAIL lineage hostile row (child_id = target, parent_id = raider): %', row_to_json(r);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- History
-- ---------------------------------------------------------------------------------------------
do $$
declare
  n integer;
  r record;
begin
  -- strain 1: created, divided (parent), fed, spliced (dominant), hostile (raider); the gen-A strain 1 events and atp_spent are absent
  select count(*) into n from public.strain_history_snacc where strain_id = 1 and block_height >= 899999000;
  -- plus its market life: listed, price_updated, sold
  if n <> 8 then raise exception 'FAIL history strain 1: expected 8 rows, got %', n; end if;
  if (select string_agg(coalesce(role, '-'), ',' order by block_height) from public.strain_history_snacc where strain_id = 1 and block_height >= 899999000)
     is distinct from '-,parent,-,dominant,raider,-,-,-' then
    raise exception 'FAIL history strain 1 roles/order';
  end if;
  if (select string_agg(event, ',' order by block_height) from public.strain_history_snacc where strain_id = 1 and block_height >= 900000110)
     is distinct from 'listed,price_updated,sold' then
    raise exception 'FAIL history strain 1 market events';
  end if;
  -- market actors and prices: seller lists and reprices (new price is the amount), the buyer is the actor of the sale
  select * into r from public.strain_history_snacc where strain_id = 1 and event = 'listed' and block_height >= 899999000;
  if r.actor <> 'alice.testnet' or r.amount <> 100000000000000000000000::numeric then raise exception 'FAIL history listed row: %', row_to_json(r); end if;
  select * into r from public.strain_history_snacc where strain_id = 1 and event = 'price_updated' and block_height >= 899999000;
  if r.actor <> 'alice.testnet' or r.amount <> 150000000000000000000000::numeric or r.data ->> 'old_price' <> '100000000000000000000000' then
    raise exception 'FAIL history price_updated row: %', row_to_json(r);
  end if;
  select * into r from public.strain_history_snacc where strain_id = 1 and event = 'sold' and block_height >= 899999000;
  if r.actor <> 'bob.testnet' or r.amount <> 150000000000000000000000::numeric or r.data ->> 'seller_id' <> 'alice.testnet' then
    raise exception 'FAIL history sold row: %', row_to_json(r);
  end if;
  select * into r from public.strain_history_snacc where strain_id = 2 and event = 'delisted' and block_height >= 899999000;
  if r.actor <> 'alice.testnet' or r.amount is not null or r.data ->> 'reason' <> 'seller' then raise exception 'FAIL history delisted row: %', row_to_json(r); end if;

  -- exact big-integer math on the headline amounts
  select amount into r from public.strain_history_snacc where strain_id = 1 and event = 'fed' and block_height >= 899999000;
  if r.amount is distinct from 42416000000000000000000::numeric then raise exception 'FAIL fed amount %', r.amount; end if;
  select amount into r from public.strain_history_snacc where strain_id = 1 and event = 'strain_divided' and role = 'parent' and block_height >= 899999000;
  if r.amount is distinct from 434463694500699999997225::numeric then raise exception 'FAIL divide child_balance %', r.amount; end if;
  select amount into r from public.strain_history_snacc where strain_id = 2 and event = 'strains_spliced' and role = 'absorbed' and block_height >= 899999000;
  if r.amount is distinct from 10861592362517499999930::numeric then raise exception 'FAIL merger_tax %', r.amount; end if;

  -- strain 3: born by divide (child), handed to bob (actor = the sender), absorbed in the hostile takeover (target)
  select count(*) into n from public.strain_history_snacc where strain_id = 3 and block_height >= 899999000;
  if n <> 3 then raise exception 'FAIL history strain 3: expected 3 rows, got %', n; end if;
  select * into r from public.strain_history_snacc where strain_id = 3 and event = 'nft_transfer' and block_height >= 899999000;
  if r.actor <> 'alice.testnet' or r.data ->> 'new_owner_id' <> 'bob.testnet' or r.amount is not null then
    raise exception 'FAIL history nft_transfer row: %', row_to_json(r);
  end if;
  select * into r from public.strain_history_snacc where strain_id = 3 and event = 'hostile_takeover_spliced' and block_height >= 899999000;
  if r.role <> 'target' or r.amount <> 46000000000000000000000::numeric then raise exception 'FAIL history hostile target row: %', row_to_json(r); end if;

  -- adopt: the target is adopted by frank, strain 6 paid (role payer)
  select * into r from public.strain_history_snacc where strain_id = 5 and event = 'strain_adopted' and block_height >= 899999000;
  if r.role <> 'target' or r.actor <> 'frank.testnet' then raise exception 'FAIL history adopt target row: %', row_to_json(r); end if;
  select * into r from public.strain_history_snacc where strain_id = 6 and event = 'strain_adopted' and block_height >= 899999000;
  if r.role <> 'payer' or r.amount <> 40000000000000000000000::numeric then raise exception 'FAIL history adopt payer row: %', row_to_json(r); end if;

  -- harvest: actor = the harvester, amount = bounty
  select * into r from public.strain_history_snacc where strain_id = 4 and event = 'strain_liquidated' and block_height >= 899999000;
  if r.actor <> 'erin.testnet' or r.amount <> 4000000000000000000000::numeric then raise exception 'FAIL history harvest row: %', row_to_json(r); end if;

  -- an event at exactly the reset height counts as after the reset
  if (select count(*) from public.strain_history_snacc where strain_id = 9 and block_height = 900000000) <> 1 then
    raise exception 'FAIL an event in the same block as the reset must be in the current generation';
  end if;

  -- nothing from generation A, and no non-strain events
  if exists (select 1 from public.strain_history_snacc where block_height < 900000000) then raise exception 'FAIL history leaks generation A'; end if;
  if exists (select 1 from public.strain_history_snacc where event in ('atp_spent', 'ft_transfer') and block_height >= 899999000) then
    raise exception 'FAIL history lists atp_spent / ft_transfer';
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Graveyard
-- ---------------------------------------------------------------------------------------------
do $$
declare
  n integer;
  r record;
begin
  select count(*) into n from public.graveyard_snacc where block_height >= 899999000;
  if n <> 4 then raise exception 'FAIL graveyard: expected 4 rows, got %', n; end if;
  if exists (select 1 from public.graveyard_snacc where strain_id = 1) then
    raise exception 'FAIL graveyard shows the generation-A harvest of strain 1';
  end if;

  select * into r from public.graveyard_snacc where strain_id = 2;
  if r.cause <> 'spliced_burned' or r.by_account <> 'alice.testnet' or r.absorbed_into <> 1 or r.owner_before <> 'alice.testnet' then
    raise exception 'FAIL graveyard strain 2 (spliced): %', row_to_json(r);
  end if;
  -- strain 3 was handed to bob before the hostile takeover: owner_before is bob, not the divider
  select * into r from public.graveyard_snacc where strain_id = 3;
  if r.cause <> 'hostile_takeover' or r.by_account <> 'carol.testnet' or r.absorbed_into <> 1 or r.owner_before <> 'bob.testnet'
     or r.amount <> 46000000000000000000000::numeric then
    raise exception 'FAIL graveyard strain 3 (hostile): %', row_to_json(r);
  end if;
  select * into r from public.graveyard_snacc where strain_id = 4;
  if r.cause <> 'harvested_starving' or r.by_account <> 'erin.testnet' or r.absorbed_into is not null or r.owner_before <> 'dave.testnet' then
    raise exception 'FAIL graveyard strain 4 (harvested): %', row_to_json(r);
  end if;
  -- strain 5 was adopted by frank, then harvested: owner_before is frank (latest ownership fact), not gus
  select * into r from public.graveyard_snacc where strain_id = 5;
  if r.cause <> 'harvested_starving' or r.by_account <> 'hal.testnet' or r.owner_before <> 'frank.testnet' or r.amount <> 10 then
    raise exception 'FAIL graveyard strain 5 (adopted then harvested): %', row_to_json(r);
  end if;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: world-readable chain data, nothing client-writable, the cursor is service only
-- ---------------------------------------------------------------------------------------------
set local role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', true);

do $$
begin
  if (select count(*) from public.chain_events_snacc where receipt_id like 'RCP%') <> 22 then
    raise exception 'FAIL anon cannot read chain_events_snacc';
  end if;
  if (select count(*) from public.strain_lineage_snacc where block_height >= 899999000) <> 3
     or (select count(*) from public.graveyard_snacc where block_height >= 899999000) <> 4
     or (select count(*) from public.strain_history_snacc where strain_id = 1 and block_height >= 899999000) <> 8 then
    raise exception 'FAIL anon cannot read the lineage / history / graveyard views';
  end if;
  begin
    insert into public.chain_events_snacc (receipt_id, log_index, tx_hash, standard, version, event, data, signer_id, block_height, block_time)
    values ('RCPanon', 0, rpad('CJTanon', 40, '1'), 'snacc', '1.0.0', 'fed', '{}', 'anon.testnet', 900000200, now());
    raise exception 'FAIL anon inserted into chain_events_snacc';
  exception when insufficient_privilege then null;
  end;
  begin
    update public.chain_events_snacc set signer_id = 'anon.testnet';
    raise exception 'FAIL anon updated chain_events_snacc';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.chain_events_snacc;
    raise exception 'FAIL anon deleted from chain_events_snacc';
  exception when insufficient_privilege then null;
  end;
  begin perform 1 from public.chain_index_state_snacc; raise exception 'FAIL anon read chain_index_state_snacc';
  exception when insufficient_privilege then null; end;
end $$;

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"aaaaaaaa-5acc-4000-8000-0000000000c1"}', true);

do $$
begin
  if (select count(*) from public.graveyard_snacc where block_height >= 899999000) <> 4 then
    raise exception 'FAIL authenticated cannot read graveyard_snacc';
  end if;
  begin
    insert into public.chain_events_snacc (receipt_id, log_index, tx_hash, standard, version, event, data, signer_id, block_height, block_time)
    values ('RCPauth', 0, rpad('CJTauth', 40, '1'), 'snacc', '1.0.0', 'fed', '{}', 'auth.testnet', 900000201, now());
    raise exception 'FAIL authenticated inserted into chain_events_snacc';
  exception when insufficient_privilege then null;
  end;
  begin perform 1 from public.chain_index_state_snacc; raise exception 'FAIL authenticated read chain_index_state_snacc';
  exception when insufficient_privilege then null; end;
end $$;

reset role;

do $$
begin
  raise notice 'ALL SNACC CHAIN INDEX CHECKS PASSED';
end $$;

rollback;
