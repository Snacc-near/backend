-- SEC-120 assertions. Read-only (no rows are written); run after migration 20261113000013.
-- A failed check raises "FAIL ..."; success ends with the notice "ALL SNACC VIEW GRANT CHECKS PASSED".

do $$
declare
  v record;
  n integer;
begin
  -- Every Snacc view except the deliberate public aggregate referral_counts_snacc is security_invoker.
  for v in
    select c.relname, coalesce(c.reloptions, '{}') as opts
    from pg_class c
    where c.relkind = 'v' and c.relnamespace = 'public'::regnamespace and c.relname like '%\_snacc'
  loop
    if v.relname = 'referral_counts_snacc' then
      if not ('security_invoker=false' = any (v.opts)) then
        raise exception 'FAIL referral_counts_snacc lost its explicit security_invoker=false';
      end if;
    elsif not ('security_invoker=true' = any (v.opts)) then
      raise exception 'FAIL view % is not security_invoker', v.relname;
    end if;
  end loop;

  -- No Snacc view grants a write privilege to anon or authenticated.
  select count(*) into n
  from information_schema.role_table_grants g
  join pg_class c on c.relname = g.table_name and c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
  where g.table_schema = 'public' and g.table_name like '%\_snacc'
    and g.grantee in ('anon', 'authenticated')
    and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');
  if n <> 0 then raise exception 'FAIL % write grants on Snacc views remain for anon/authenticated', n; end if;

  -- The read paths the app uses still work.
  if not has_table_privilege('anon', 'public.graveyard_snacc', 'SELECT') then raise exception 'FAIL anon lost SELECT on graveyard_snacc'; end if;
  if not has_table_privilege('anon', 'public.quest_catalog_snacc', 'SELECT') then raise exception 'FAIL anon lost SELECT on quest_catalog_snacc'; end if;
  if not has_table_privilege('anon', 'public.chain_events_current_snacc', 'SELECT') then raise exception 'FAIL anon lost SELECT on chain_events_current_snacc'; end if;

  raise notice 'ALL SNACC VIEW GRANT CHECKS PASSED';
end $$;
