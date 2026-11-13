-- SEC-119: per-network daily cap for the testnet starter pack.
-- starter-pack stores an HMAC-SHA256 of the client IP (keyed with an edge secret), never the raw IP,
-- and refuses more than 3 claims per hashed IP per UTC day (on top of 1 per NEAR account and 100 per day).
-- The column is service-only like the rest of starter_claims_snacc and is not part of the data export.

alter table public.starter_claims_snacc add column if not exists ip_hash text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'starter_claims_snacc_ip_hash') then
    alter table public.starter_claims_snacc
      add constraint starter_claims_snacc_ip_hash check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$');
  end if;
end;
$$;

create index if not exists snacc_starter_claims_ip_idx on public.starter_claims_snacc (ip_hash, created_at);
