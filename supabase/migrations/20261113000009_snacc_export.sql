-- UI-163: a signed-in player downloads everything Snacc stores about them, as one JSON document.
-- security definer so it can read the service-only starter claim, but every query is pinned to
-- auth.uid(). About other players it returns only what is already public: the account id and username
-- of the players you follow, and a count of your followers.

create or replace function public.snacc_export_my_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    raise exception 'not signed in' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'format', 'snacc-export-v1',
    'exported_at', now(),
    'note', 'Off-chain Snacc data only. On-chain state (Snacc NFTs, balances) lives on NEAR testnet and is public there.',
    'profile', (select to_jsonb(p) from public.profiles_snacc p where p.user_id = uid),
    'activity', coalesce((select jsonb_agg(to_jsonb(a) order by a.block_time) from public.activity_snacc a where a.user_id = uid), '[]'::jsonb),
    'achievements', coalesce((select jsonb_agg(to_jsonb(x) order by x.earned_at) from public.achievements_snacc x where x.user_id = uid), '[]'::jsonb),
    'notifications', coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at) from public.notifications_snacc n where n.user_id = uid), '[]'::jsonb),
    'notification_prefs', (select to_jsonb(np) from public.notification_prefs_snacc np where np.user_id = uid),
    'following', coalesce((
      select jsonb_agg(jsonb_build_object('near_account_id', p.near_account_id, 'username', p.username, 'since', f.created_at) order by f.created_at)
      from public.follows_snacc f join public.profiles_snacc p on p.user_id = f.followee
      where f.follower = uid), '[]'::jsonb),
    'followers_count', (select count(*) from public.follows_snacc f where f.followee = uid),
    'starter_claim', (
      select jsonb_build_object('near_account_id', s.near_account_id, 'amount_yocto', s.amount_yocto, 'tx_hash', s.tx_hash, 'created_at', s.created_at)
      from public.starter_claims_snacc s where s.user_id = uid limit 1)
  );
end;
$$;

revoke all on function public.snacc_export_my_data() from public, anon;
grant execute on function public.snacc_export_my_data() to authenticated;
