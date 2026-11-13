-- SEC-120: view privilege hygiene (Supabase security advisor, 2026-11-13).
--
--  1) quest_catalog_snacc is a constant VALUES list, so SECURITY DEFINER never exposed anything, but it is the only
--     Snacc view still defined without security_invoker. Switch it to security_invoker = true to match every other
--     read view and clear the advisor's `security_definer_view` error.
--     referral_counts_snacc stays security_invoker = false ON PURPOSE (UI-158): it publishes per-referrer counts
--     while referrals_snacc itself stays own-rows-only. It exposes user_id and near_account_id, which
--     profiles_snacc already makes public.
--  2) Supabase default privileges gave anon/authenticated INSERT, UPDATE, DELETE and TRUNCATE on several read views.
--     None of them is writable today: four are not auto-updatable, and chain_events_current_snacc is security_invoker
--     over chain_events_snacc, where those roles hold SELECT only (a write is rejected with 42501). Revoke the
--     unused write privileges anyway so the views are read-only by grant, not only by accident.
--
-- Re-runnable: ALTER VIEW ... SET and REVOKE are idempotent.

alter view public.quest_catalog_snacc set (security_invoker = true);

revoke insert, update, delete, truncate on table
  public.chain_events_current_snacc,
  public.graveyard_snacc,
  public.strain_history_snacc,
  public.strain_lineage_snacc,
  public.streaks_snacc
from anon, authenticated;
